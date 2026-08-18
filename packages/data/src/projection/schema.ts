/**
 * The SQL shape of a projected workspace: one relation per declared table,
 * plus `kv` as a one-row relation.
 *
 * Deliberately whole-rebuild only. The store's superseded built-in projection
 * kept a second per-row patch path beside the rebuild, and its own comments
 * record why that was a liability: two code paths that can disagree, kept
 * honest only by rebuilding wholesale anyway whenever a remote update arrived.
 * A projection is a cache the live document can always rebuild in
 * milliseconds, so the rebuild is the only writer.
 */

import type {
	JsonObject,
	JsonValue,
	ParsedDatabase,
	ParsedTable,
} from '@epicenter/database';
import type { SqliteDatabase, SqliteRow, SqliteValue } from '@epicenter/sqlite';

/**
 * A projection table per declared table: `id` plus one column per declared
 * field.
 *
 * Columns are `ANY` rather than typed from the field's arktype expression. A
 * field is a union as often as not (`'string|null'`), and the projection is a
 * cache the live document can always rebuild, so deriving a narrow column type
 * would buy nothing and cost a mapping that has to be right for every
 * expression.
 *
 * The name is quoted but the parser has already refused anything that is not a
 * bare SQL identifier, so quoting is defence rather than permission.
 */
export function applyProjectionSchema(
	sqlite: SqliteDatabase,
	workspace: ParsedDatabase,
): void {
	// KV projects as a one-row relation named `kv`, which the parser reserves as
	// a table name so nothing can collide with it.
	const relations: [string, ParsedTable][] = [
		...(workspace.kv === undefined
			? []
			: ([['kv', workspace.kv]] as [string, ParsedTable][])),
		...workspace.tables,
	];
	// The projection owns this database's whole letter-named databaseId, so a
	// relation the current definition no longer declares is dropped, not just
	// left behind: a workspace upgrade that REMOVES a table must remove it
	// from SQL too, or `query` keeps serving rows the runtime cannot see and
	// will never update (the data itself stays preserved in the live document,
	// and reappears the moment a definition that declares it opens). The sweep
	// is safe because the parser refuses any table name that does not start
	// with a letter, so underscore-prefixed relations can never be declared
	// and are never swept.
	const declared = new Set(relations.map(([tableName]) => tableName));
	const leftBehind = sqlite
		.all<SqliteRow & { name: string }>(
			"SELECT name FROM sqlite_master WHERE type = 'table'",
		)
		.map((row) => row.name)
		.filter(
			(name) =>
				!name.startsWith('_') &&
				!name.startsWith('sqlite_') &&
				!declared.has(name),
		);
	for (const name of leftBehind) {
		sqlite.run(`DROP TABLE IF EXISTS ${quoteIdentifier(name)}`);
	}
	for (const [tableName, table] of relations) {
		const fields = [...table.fields.keys()];
		// A relation whose columns no longer match the declaration is DROPPED
		// rather than altered, which is only safe because a projection is a
		// cache: the whole rebuild repopulates every table right after this.
		// `CREATE TABLE IF NOT EXISTS` alone was a live bug in the superseded
		// built-in projection: adding a field left the old relation in place
		// without the new column, and the rebuild then failed on every open.
		if (!columnsMatch(sqlite, tableName, fields)) {
			sqlite.run(`DROP TABLE IF EXISTS ${quoteIdentifier(tableName)}`);
		}
		const columns = fields.map((field) => `${quoteIdentifier(field)} ANY`);
		sqlite.run(
			`CREATE TABLE IF NOT EXISTS ${quoteIdentifier(tableName)} (
				id TEXT PRIMARY KEY${columns.length === 0 ? '' : `,\n\t\t\t\t${columns.join(',\n\t\t\t\t')}`}
			) WITHOUT ROWID, STRICT`,
		);
	}
}

/**
 * Whether a projected relation already has exactly the declared columns.
 *
 * A relation that does not exist yet "matches", so a first rebuild creates it
 * rather than dropping nothing and creating it. Order is compared as a set,
 * because the projection addresses columns by name.
 */
function columnsMatch(
	sqlite: SqliteDatabase,
	tableName: string,
	fields: readonly string[],
): boolean {
	const existing = sqlite.all<SqliteRow & { name: string }>(
		`PRAGMA table_info(${quoteIdentifier(tableName)})`,
	);
	if (existing.length === 0) return true;
	const found = new Set(existing.map((column) => column.name));
	found.delete('id');
	if (found.size !== fields.length) return false;
	return fields.every((field) => found.has(field));
}

/**
 * One field's value as the projection stores it.
 *
 * A scalar binds natively so `WHERE title = 'Groceries'` works; an array or
 * object binds as JSON text so `json_each(notes.tags)` works. Nothing ever
 * decodes these back, because the live document is the truth and the
 * projection is a cache, so the two encodings can never be confused for one
 * another.
 */
export function projectValue(value: JsonValue | undefined): SqliteValue {
	if (value === undefined || value === null) return null;
	if (typeof value === 'string' || typeof value === 'number') return value;
	if (typeof value === 'boolean') return value ? 1 : 0;
	return JSON.stringify(value);
}

/** Clear one relation, as the first step of its rebuild. */
export function clearProjectedTable(
	sqlite: SqliteDatabase,
	tableName: string,
): void {
	sqlite.run(`DELETE FROM ${quoteIdentifier(tableName)}`);
}

/** Insert one row into a cleared relation. */
export function insertProjectedRow(
	sqlite: SqliteDatabase,
	tableName: string,
	fieldNames: readonly string[],
	rowId: string,
	payload: JsonObject,
): void {
	const columns = ['id', ...fieldNames];
	const values: SqliteValue[] = [
		rowId,
		...fieldNames.map((field) => projectValue(payload[field])),
	];
	sqlite.run(
		`INSERT OR REPLACE INTO ${quoteIdentifier(tableName)} (${columns
			.map(quoteIdentifier)
			.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
		values,
	);
}

/**
 * Quote one SQL identifier.
 *
 * The workspace parser already refuses any table or field name that is not a
 * bare identifier, so this never has real work to do. It stays because the
 * projection builds SQL by concatenation, and a schema that depends on a
 * validator two packages away for its safety should not also depend on nobody
 * ever relaxing that validator.
 */
export function quoteIdentifier(name: string): string {
	return `"${name.replaceAll('"', '""')}"`;
}
