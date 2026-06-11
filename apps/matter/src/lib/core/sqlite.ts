/**
 * The SQLite projector: turn a folder's VALID rows into a typed table.
 *
 * `matter.sqlite` sits next to `matter.json` as a derived, disposable, READ-ONLY
 * mirror so a coding agent (or an in-app SQL console) can run arbitrary SQL over the
 * typed folder. The live in-app grid stays reactive JS over the projection; this is
 * the external read surface, not the app's query engine.
 *
 * This module is the PURE half: given the model and the classified rows, it produces
 * the schema script (`DROP` + `CREATE`) and the row tuples to insert. The impure half
 * (writing the file) is a thin Tauri command that runs the script and parameter-binds
 * the rows; keeping serialization here makes it unit-testable with no filesystem.
 *
 * Three properties define the table:
 *   - Every READABLE row, valid or not. A folder of drafts is mostly incomplete, and
 *     the whole point of the WHERE filter (and of an agent triaging the folder) is to
 *     find those drafts ("my carousel posts that still need a publishDate"), so a row
 *     is included whether or not every field is filled. Only unparseable FILES are
 *     absent, they never became a row; their broken text stays in the markdown.
 *   - Field columns are nullable. A missing required cell (NEEDS_VALUE) binds NULL; an
 *     out-of-domain value (INVALID) binds its raw value, which SQLite's flexible typing
 *     stores regardless of the column's declared affinity. So a draft is still
 *     filterable on the fields it does have.
 *   - No CHECK. Validation lives once, at classify time (the grid shows conformance per
 *     cell, amber for empty, red for out-of-domain); the mirror just mirrors, so a SQL
 *     CHECK would only reject the very drafts the filter exists to surface.
 */

import type { RowConformance } from './conformance';
import type { MatterModel } from './model';
import { storageOf, type Field } from '@epicenter/field';

/** A SQLite-bindable scalar. A missing (NEEDS_VALUE) cell binds NULL, so values are nullable. */
export type SqlValue = string | number | null;

/**
 * The pure artifacts a Tauri command needs to materialize the table: exactly its
 * arguments, nothing exposed that the command does not consume. All SQL TEXT is built
 * here (one quoting implementation); the command runs the script and binds the rows,
 * so it never constructs SQL.
 */
export type SqliteProjection = {
	/** `DROP TABLE IF EXISTS ...; CREATE TABLE ...`: one param-less script for `execute_batch`. */
	schema: string;
	/** `INSERT INTO ... VALUES (?, ?, ...)`: one `?` placeholder per column, bound positionally. */
	insert: string;
	/** One tuple per readable row, positional against the insert's columns. */
	rows: SqlValue[][];
};

/**
 * Quote a SQL identifier, doubling embedded quotes, so any field name is safe. The ONE
 * identifier-quoting implementation: the vault reuses it to build the WHERE filter's
 * `SELECT` so the table name is never quoted by hand in a second place.
 */
export function quoteIdent(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

/**
 * The one table in every matter.sqlite. A matter folder is one db file with one table, so
 * the name is a CONSTANT, not the folder's basename: the agent read surface (and the WHERE
 * filter) stays stable no matter what the folder is called or renamed to. The read
 * (`matchingFileNames` in the vault) and the write (`buildDdl`) both name it through this one
 * value, still guarded by `quoteIdent`.
 */
export const MIRROR_TABLE = 'entries';

/**
 * Serialize one OK (validated) cell value to its storage class. The value passed the
 * field's schema, so the kind determines the encoding: booleans to 0/1, lists to JSON
 * text, everything else to its TEXT/INTEGER/REAL form.
 */
function serializeCell(field: Field, value: unknown): SqlValue {
	switch (field.kind) {
		case 'integer':
		case 'number':
			return value as number;
		case 'boolean':
			return value ? 1 : 0;
		case 'tags':
		case 'multiSelect':
		case 'json':
			return JSON.stringify(value); // an array or arbitrary JSON payload -> JSON TEXT
		default:
			// string / url / datetime / select, all TEXT columns. String(v) is identity
			// for a string and the TEXT form for a numeric/boolean enum value (what a
			// select holds), which SQLite's TEXT affinity stores and coerces on read.
			return String(value);
	}
}

/**
 * Serialize an out-of-domain (INVALID) cell value by its RUNTIME type, not the field's
 * kind: the value did not match the kind, so a stray float in an integer field stays a
 * real and a string in a tags field stays text. SQLite stores it regardless of the
 * column's affinity, so the draft is still findable on that field. NEEDS_VALUE cells
 * never reach here (they bind NULL directly); the `null` guard is only defensive.
 */
function serializeInvalid(value: unknown): SqlValue {
	if (value == null) return null;
	if (typeof value === 'boolean') return value ? 1 : 0;
	if (typeof value === 'number') return value;
	if (typeof value === 'string') return value;
	return JSON.stringify(value); // an object / array where a scalar was expected
}

/**
 * Build the `CREATE TABLE` for a folder: `file` primary key (the row's basename
 * identity), one NULLABLE column per modeled field (typed by its storage class so the
 * filter coerces by affinity; a missing cell binds NULL), and an `_extra` JSON column
 * (always present) for the unmodeled keys, so an agent can see extras too.
 */
function buildDdl(fields: readonly Field[]): string {
	const defs = [
		`${quoteIdent('file')} TEXT PRIMARY KEY`,
		...fields.map((c) => `${quoteIdent(c.name)} ${storageOf(c.kind)}`),
		`${quoteIdent('_extra')} TEXT NOT NULL`,
	];
	return `CREATE TABLE ${quoteIdent(MIRROR_TABLE)} (${defs.join(', ')})`;
}

/**
 * Project a classified folder into the SQLite artifacts. EVERY readable row is included;
 * each cell is serialized by its conformance state (OK by storage class, INVALID by its
 * raw value, NEEDS_VALUE as NULL) and its unmodeled keys are folded into the `_extra`
 * JSON object. The cells are read off `RowConformance.cells`, which classifyRow built in
 * `model.fields` order, so they line up positionally with the columns below.
 */
export function projectToSqlite(
	model: MatterModel,
	conformance: readonly RowConformance[],
): SqliteProjection {
	const columns = ['file', ...model.fields.map((c) => c.name), '_extra'];
	const rows = conformance.map((c) => {
		const cells = c.cells.map((cell): SqlValue => {
			switch (cell.state) {
				case 'NEEDS_VALUE':
					return null;
				case 'OK':
					return serializeCell(cell.field, cell.value);
				case 'INVALID':
					return serializeInvalid(cell.raw);
				default:
					return cell satisfies never;
			}
		});
		const extra = JSON.stringify(
			Object.fromEntries(c.extras.map((e) => [e.key, e.value])),
		);
		return [c.row.fileName, ...cells, extra];
	});

	const placeholders = columns.map(() => '?').join(', ');
	const insert = `INSERT INTO ${quoteIdent(MIRROR_TABLE)} (${columns
		.map(quoteIdent)
		.join(', ')}) VALUES (${placeholders})`;

	// DROP + CREATE as one param-less script; the command runs it via execute_batch,
	// rusqlite's idiom for a multi-statement setup script.
	const drop = `DROP TABLE IF EXISTS ${quoteIdent(MIRROR_TABLE)}`;
	const schema = `${drop};\n${buildDdl(model.fields)}`;

	return { schema, insert, rows };
}
