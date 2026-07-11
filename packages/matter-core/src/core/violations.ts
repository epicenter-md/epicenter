/**
 * The flat projections of {@link VaultIntegrity} for the outside world.
 *
 * `assess` returns a rich, indexed structure the grid binds to cell-by-cell. The CLI, the
 * integrity panel, and `--json` want the opposite: the flat list of what is WRONG, and the
 * roll-up counts. {@link toViolations} and {@link summarize} are those two pure SELECTORS. They
 * re-walk nothing of the filesystem and re-run no classification: they read the already-assessed
 * cells. So the grid and the report cannot disagree, because both read the same {@link
 * VaultIntegrity}.
 *
 * A {@link Violation} is a cell whose state needs attention. Only four of the seven `AssessedCell`
 * states project: `ok`, `missing-optional`, and `resolved` are healthy and never appear. `ok` and
 * `missing-optional` not appearing is the proof that this list is a PROJECTION of the cells, not
 * all of them. Table-load failures and Markdown files that could not become rows are NOT violations
 * either: they have no cells, and they surface through {@link summarize} and the exit code, where
 * unreadable input is a different kind of answer than a row with a bad value.
 *
 * `expected` is deliberately absent from the `invalid-type` violation: it is a render projection
 * (`describeExpected` in `./expected`), so the violation carries the {@link Field} itself and the
 * edge computes "what was expected" only when it formats or serializes. See the spec's "expected
 * is a render projection, not data".
 */

import type { Field } from '@epicenter/field';
import type {
	LocatedUnreadableFile,
	TableAssessment,
	VaultIntegrity,
} from './integrity';
import { stemOf } from './parse';

/**
 * One thing wrong with the vault's data, located for a flat list. The four kinds are exactly the
 * four attention cell states; each carries only what its fix needs:
 *
 *   - `missing-target`     a reference column whose target table is absent from the vault. The
 *                          whole column is unresolvable, so it is reported ONCE per
 *                          `{ table, field, target }`, not once per row (per-row would echo one
 *                          structural cause). No row: it is not any single row's fault.
 *   - `missing-required`   a required cell with no value, located to its row.
 *   - `invalid-type`       a present value out of its field's domain. Carries the raw value AND
 *                          the {@link Field} (not just the name), because "what was expected" is a
 *                          render projection computed from the field at the edge, never stored.
 *   - `dangling-reference` a present, valid pointer that names no row in a target table that IS
 *                          loaded, located per offending row.
 */
export type Violation =
	| { kind: 'missing-target'; table: string; field: string; target: string }
	| { kind: 'missing-required'; table: string; row: string; field: string }
	| {
			kind: 'invalid-type';
			table: string;
			row: string;
			field: Field;
			raw: unknown;
	  }
	| {
			kind: 'dangling-reference';
			table: string;
			row: string;
			field: string;
			value: string;
			target: string;
	  };

/**
 * Select every attention cell as a flat, located {@link Violation}. A pure selector over the
 * assessed cells: it never reads the filesystem, never calls `assess` or `resolveReferences`, and
 * never reclassifies. Only `typed` tables have typed cells, so only they contribute; a
 * `missing-target` column is deduped to one violation per `{ field, target }` within its table.
 */
export function toViolations(integrity: VaultIntegrity): Violation[] {
	const violations: Violation[] = [];

	for (const table of integrity.tables) {
		if (table.status !== 'typed') continue;

		// The whole column is unresolvable when its target table is absent, so report it once.
		// Keyed by field + target (a table could reference the same target from two columns).
		const reportedMissingTargets = new Set<string>();

		for (const { row, cells } of table.rows) {
			const rowId = stemOf(row.fileName);
			for (const cell of cells) {
				switch (cell.state) {
					case 'missing-required':
						violations.push({
							kind: 'missing-required',
							table: table.name,
							row: rowId,
							field: cell.field.name,
						});
						break;
					case 'invalid':
						violations.push({
							kind: 'invalid-type',
							table: table.name,
							row: rowId,
							field: cell.field,
							raw: cell.raw,
						});
						break;
					case 'dangling':
						violations.push({
							kind: 'dangling-reference',
							table: table.name,
							row: rowId,
							field: cell.field.name,
							value: cell.value,
							target: cell.target,
						});
						break;
					case 'missing-target': {
						const columnKey = JSON.stringify([cell.field.name, cell.target]);
						if (reportedMissingTargets.has(columnKey)) break;
						reportedMissingTargets.add(columnKey);
						violations.push({
							kind: 'missing-target',
							table: table.name,
							field: cell.field.name,
							target: cell.target,
						});
						break;
					}
					// ok / missing-optional / resolved are healthy: never violations.
				}
			}
		}
	}

	return violations;
}

/** Per-field roll-up over the seven cell states, in declared field order. */
export type FieldSummary = {
	field: string;
	/** Present and valid, including a `resolved` reference. */
	ok: number;
	/** Absent and allowed (`missing-optional`). */
	empty: number;
	/** Absent and required (`missing-required`). */
	needsValue: number;
	/** Present but out of the field's domain (`invalid`). */
	invalid: number;
	/** A reference that did not resolve (`dangling` or `missing-target`). */
	unresolved: number;
};

/** One table's place in the roll-up. The four statuses mirror {@link TableAssessment}. */
export type TableSummary =
	| { name: string; status: 'unreadable'; message: string }
	| { name: string; status: 'invalid-contract'; message: string }
	| { name: string; status: 'untyped'; rows: number }
	| {
			name: string;
			status: 'typed';
			rows: number;
			/** Rows with no cell that needs a per-row fix. */
			ready: number;
			/** Rows with at least one missing-required / invalid / dangling cell. */
			needsAttention: number;
			fields: FieldSummary[];
	  };

/** A row's extra frontmatter keys: a note, never a violation. */
export type ExtraNote = { table: string; row: string; keys: string[] };

/**
 * The vault roll-up: per-table summaries, the extras-as-notes, and vault totals. A pure selector
 * over {@link VaultIntegrity}, the source the format text and the exit code both read.
 */
export type Summary = {
	tables: TableSummary[];
	extras: ExtraNote[];
	/** Markdown files that could not become rows, already located by `assess`. */
	unreadableFiles: LocatedUnreadableFile[];
	totals: {
		tables: number;
		rows: number;
		/** Typed rows with every cell healthy. */
		ready: number;
		/** Typed rows with at least one attention cell (the exit-code signal). */
		needsAttention: number;
		/** Tables whose folder could not be read at all (a fatal). */
		unreadableTables: number;
		/** Markdown files omitted from classification because they could not parse or read. */
		unreadableFiles: number;
		/** Tables whose matter.json is present but corrupt (a fatal). */
		invalidContract: number;
		/** Untyped tables (no matter.json): valid, never a failure. */
		untyped: number;
	};
};

/**
 * True for the cell states a row's author fixes by editing the row: an absent required value, an
 * out-of-domain value, or a pointer that dangles against a loaded table. `missing-target` is NOT
 * here: it is a table-tier structural problem (the whole referenced table is absent), surfaced as
 * its own violation, never a per-row fix, so it does not flip a row to "needs attention".
 */
function cellNeedsAttention(state: string): boolean {
	return (
		state === 'missing-required' || state === 'invalid' || state === 'dangling'
	);
}

/** Roll one typed table's cells up into its {@link TableSummary} and accumulate its extras. */
function summarizeTyped(
	table: Extract<TableAssessment, { status: 'typed' }>,
	extras: ExtraNote[],
): Extract<TableSummary, { status: 'typed' }> {
	const fields: FieldSummary[] = table.contract.fields.map((field) => ({
		field: field.name,
		ok: 0,
		empty: 0,
		needsValue: 0,
		invalid: 0,
		unresolved: 0,
	}));
	const byName = new Map(fields.map((field) => [field.field, field]));

	let ready = 0;
	for (const { row, cells, extras: rowExtras } of table.rows) {
		if (rowExtras.length > 0) {
			extras.push({
				table: table.name,
				row: stemOf(row.fileName),
				keys: rowExtras.map((extra) => extra.key),
			});
		}

		let rowReady = true;
		for (const cell of cells) {
			if (cellNeedsAttention(cell.state)) rowReady = false;
			const count = byName.get(cell.field.name);
			if (!count) continue;
			switch (cell.state) {
				case 'ok':
				case 'resolved':
					count.ok += 1;
					break;
				case 'missing-optional':
					count.empty += 1;
					break;
				case 'missing-required':
					count.needsValue += 1;
					break;
				case 'invalid':
					count.invalid += 1;
					break;
				case 'dangling':
				case 'missing-target':
					count.unresolved += 1;
					break;
			}
		}
		if (rowReady) ready += 1;
	}

	return {
		name: table.name,
		status: 'typed',
		rows: table.rows.length,
		ready,
		needsAttention: table.rows.length - ready,
		fields,
	};
}

/**
 * Roll {@link VaultIntegrity} up into its {@link Summary}. A pure selector: same cells the grid
 * and {@link toViolations} read, counted for the per-table view, the notes, and the totals the
 * exit code derives from.
 */
function summarizeTable(
	table: TableAssessment,
	extras: ExtraNote[],
): TableSummary {
	switch (table.status) {
		case 'unreadable':
			return { name: table.name, status: 'unreadable', message: table.message };
		case 'invalid-contract':
			return {
				name: table.name,
				status: 'invalid-contract',
				message: table.message,
			};
		case 'untyped':
			return { name: table.name, status: 'untyped', rows: table.rows.length };
		case 'typed':
			return summarizeTyped(table, extras);
	}
}

export function summarize(integrity: VaultIntegrity): Summary {
	const extras: ExtraNote[] = [];
	const tables: TableSummary[] = integrity.tables.map((table) =>
		summarizeTable(table, extras),
	);

	const totals = {
		tables: tables.length,
		rows: 0,
		ready: 0,
		needsAttention: 0,
		unreadableTables: 0,
		unreadableFiles: integrity.unreadableFiles.length,
		invalidContract: 0,
		untyped: 0,
	};
	for (const table of tables) {
		switch (table.status) {
			case 'unreadable':
				totals.unreadableTables += 1;
				break;
			case 'invalid-contract':
				totals.invalidContract += 1;
				break;
			case 'untyped':
				totals.untyped += 1;
				totals.rows += table.rows;
				break;
			case 'typed':
				totals.rows += table.rows;
				totals.ready += table.ready;
				totals.needsAttention += table.needsAttention;
				break;
		}
	}

	return {
		tables,
		extras,
		unreadableFiles: integrity.unreadableFiles,
		totals,
	};
}
