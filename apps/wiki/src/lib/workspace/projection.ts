/**
 * Per-type SQLite projection: the derived, disposable query index.
 *
 * SQLite is never truth. It is re-projected from the CURRENT type schemas, so
 * it is always safe to drop and rebuild. The shape:
 *
 *   wiki_pages(id PK, title, description, tags, source, created, updated)
 *   wiki_page_types(page_id, type_id)                  -- membership edge
 *   wiki_type_<typeId>(page_id PK, c_<colId> ...)      -- one per type
 *
 * Two consequences fall straight out of this layout:
 *
 *   - A column's physical id is `c_<colId>`, and `colId` never changes on a
 *     display rename, so a rename emits NO DDL (`projectWiki` returns the same
 *     DDL string). Adding a column changes the DDL, so it re-projects.
 *   - Projection is schema-on-read: only columns in the CURRENT schema become
 *     physical columns; excess stored values are simply not projected (they
 *     survive in Yjs, see `./lens.ts`).
 */

import type { Database } from 'bun:sqlite';
import type { TSchema } from 'typebox';
import type { JsonValue } from 'wellcrafted/json';
import { type Page, typeColumns, type WikiType } from './schema';

/** Result of one projection run: the DDL emitted per type table. */
export type ProjectionResult = {
	/** `typeId -> CREATE TABLE` for that type's side table. */
	typeTableDdl: Record<string, string>;
};

/**
 * Drop and rebuild the entire derived index from the current registry + pages.
 * Idempotent and disposable: call it again after any schema or data change.
 */
export function projectWiki(
	db: Database,
	{ types, pages }: { types: WikiType[]; pages: Page[] },
): ProjectionResult {
	dropProjectedTables(db);

	db.run(
		`CREATE TABLE ${q('wiki_pages')} (` +
			`${q('id')} TEXT PRIMARY KEY, ${q('title')} TEXT NOT NULL, ` +
			`${q('description')} TEXT, ${q('tags')} TEXT NOT NULL, ` +
			`${q('source')} TEXT NOT NULL, ${q('created')} TEXT NOT NULL, ` +
			`${q('updated')} TEXT NOT NULL)`,
	);
	db.run(
		`CREATE TABLE ${q('wiki_page_types')} (` +
			`${q('page_id')} TEXT NOT NULL, ${q('type_id')} TEXT NOT NULL, ` +
			`PRIMARY KEY (${q('page_id')}, ${q('type_id')}))`,
	);

	const insertPage = db.prepare(
		`INSERT INTO ${q('wiki_pages')} ` +
			`(${q('id')}, ${q('title')}, ${q('description')}, ${q('tags')}, ${q('source')}, ${q('created')}, ${q('updated')}) ` +
			'VALUES (?, ?, ?, ?, ?, ?, ?)',
	);
	const insertMembership = db.prepare(
		`INSERT INTO ${q('wiki_page_types')} (${q('page_id')}, ${q('type_id')}) VALUES (?, ?)`,
	);
	for (const page of pages) {
		insertPage.run(
			page.id,
			page.title,
			page.description,
			JSON.stringify(page.tags),
			JSON.stringify(page.source),
			page.createdAt,
			page.updatedAt,
		);
		for (const typeId of Object.keys(page.types)) {
			insertMembership.run(page.id, typeId);
		}
	}

	const typeTableDdl: Record<string, string> = {};
	for (const type of types) {
		typeTableDdl[type.id] = projectTypeTable(db, type, pages);
	}

	return { typeTableDdl };
}

/**
 * Build and populate one `wiki_type_<typeId>` side table from the type's
 * CURRENT columns. Returns the `CREATE TABLE` statement so callers can prove a
 * rename emits identical DDL while an add does not.
 */
function projectTypeTable(db: Database, type: WikiType, pages: Page[]): string {
	const tableName = `wiki_type_${assertSafeSlug(type.id)}`;

	const columnDefs: string[] = [`${q('page_id')} TEXT PRIMARY KEY`];
	const projected: { colId: string; physical: string }[] = [];
	for (const spec of typeColumns(type)) {
		const physical = `c_${spec.id}`;
		columnDefs.push(`${q(physical)} ${deriveStorage(spec.schema)}`);
		projected.push({ colId: spec.id, physical });
	}

	const ddl = `CREATE TABLE ${q(tableName)} (${columnDefs.join(', ')})`;
	db.run(ddl);

	const columns = [q('page_id'), ...projected.map((p) => q(p.physical))];
	const placeholders = columns.map(() => '?').join(', ');
	const insert = db.prepare(
		`INSERT INTO ${q(tableName)} (${columns.join(', ')}) VALUES (${placeholders})`,
	);
	for (const page of pages) {
		const data = page.types[type.id];
		if (data === undefined) continue; // page does not carry this type
		const values = projected.map((p) => serializeValue(data[p.colId]));
		insert.run(page.id, ...values);
	}

	return ddl;
}

// ════════════════════════════════════════════════════════════════════════════
// SQLITE HELPERS (self-contained; the workspace internals are not public)
// ════════════════════════════════════════════════════════════════════════════

/** Drop every wiki-projected table so the next projection is a clean rebuild. */
function dropProjectedTables(db: Database): void {
	const rows = db
		.query<{ name: string }, []>(
			"SELECT name FROM sqlite_master WHERE type = 'table' " +
				"AND (name = 'wiki_pages' OR name = 'wiki_page_types' OR name LIKE 'wiki_type_%')",
		)
		.all();
	for (const { name } of rows) db.run(`DROP TABLE IF EXISTS ${q(name)}`);
}

/** Double-quote a SQL identifier, escaping embedded quotes. */
function q(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
}

/** Type ids become physical table-name segments, so keep them slug-shaped. */
function assertSafeSlug(value: string): string {
	if (!/^[a-z0-9_]+$/.test(value)) {
		throw new Error(
			`type id "${value}" is not a safe table-name segment (expected [a-z0-9_]+)`,
		);
	}
	return value;
}

type SchemaShape = { type?: string; const?: unknown; anyOf?: TSchema[] };

/**
 * SQLite storage class for a column schema. Mirrors the workspace materializer's
 * `deriveStorage` (which is not exported from the package), including the
 * `const` branch, so an integer-`const` column (`Type.Literal(5)`) derives
 * INTEGER like the real one rather than silently falling through to TEXT.
 */
function deriveStorage(schema: TSchema): 'TEXT' | 'INTEGER' | 'REAL' {
	const s = schema as SchemaShape;
	if (s.type === 'integer' || s.type === 'boolean') return 'INTEGER';
	if (s.type === 'number') return 'REAL';
	if (s.type === 'string' || s.type === 'array' || s.type === 'object') {
		return 'TEXT';
	}
	if (s.const !== undefined) {
		return typeof s.const === 'number' && Number.isInteger(s.const)
			? 'INTEGER'
			: 'TEXT';
	}
	if (s.anyOf) {
		const nonNull = s.anyOf.filter(
			(branch) => (branch as SchemaShape).type !== 'null',
		);
		if (nonNull.length === 1 && nonNull[0]) return deriveStorage(nonNull[0]);
	}
	return 'TEXT';
}

/** Convert a stored JSON value into a SQLite binding. */
function serializeValue(value: JsonValue | undefined): string | number | null {
	if (value === null || value === undefined) return null;
	if (typeof value === 'boolean') return value ? 1 : 0;
	if (typeof value === 'object') return JSON.stringify(value);
	return value;
}
