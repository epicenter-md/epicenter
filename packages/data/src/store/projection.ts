/**
 * The workspace's derived SQL: one real table per declared table, rebuilt at
 * open.
 *
 * Split from the durable log beside it because the two share a file and nothing
 * else. The log is the CRDT's own bytes and is read by `../sync`; this is a
 * cache the CRDT can always rebuild, and it is the only thing here that knows
 * what a workspace declared.
 */

import type { SqliteDatabase, SqliteRow, SqliteValue } from '@epicenter/sqlite';
import type {
	JsonObject,
	JsonValue,
	ParsedTable,
	ParsedWorkspace,
} from '@epicenter/workspace';

/**
 * A projection table per declared table: `id` plus one column per declared
 * field.
 *
 * Columns are `ANY` rather than typed from the field's arktype expression. A
 * field is a union as often as not (`'string|null'`), and the projection is a
 * cache the CRDT can always rebuild, so deriving a narrow column type would buy
 * nothing and cost a mapping that has to be right for every expression.
 *
 * The name is quoted but the parser has already refused anything that is not a
 * bare SQL identifier, so quoting is defence rather than permission.
 */
export function applyProjectionSchema(
	database: SqliteDatabase,
	workspace: ParsedWorkspace,
): void {
	// KV projects as a one-row relation named `kv`, which the parser reserves as
	// a table name so nothing can collide with it.
	const relations: [string, ParsedTable][] = [
		...(workspace.kv === undefined
			? []
			: ([['kv', workspace.kv]] as [string, ParsedTable][])),
		...workspace.tables,
	];
	// The projection owns this database's whole letter-named namespace, so a
	// relation the current definition no longer declares is dropped, not just
	// left behind: a workspace upgrade that REMOVES a table must remove it
	// from SQL too, or `query` keeps serving rows the runtime cannot see and
	// will never update (the data itself stays preserved in the CRDT, and
	// reappears the moment a definition that declares it opens). The sweep is
	// safe wherever the projection lives, because the two namespaces cannot
	// meet: the parser refuses any table name that does not start with a
	// letter, and every durable relation a store may share this database with
	// (`_updates`, `_outbox`, `_cursor`, `_meta`) is underscore-prefixed. The
	// sync authority's own relations never come near this code at all.
	const declared = new Set(relations.map(([tableName]) => tableName));
	const leftBehind = database
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
		database.run(`DROP TABLE IF EXISTS ${quoteIdentifier(name)}`);
	}
	for (const [tableName, table] of relations) {
		const fields = [...table.fields.keys()];
		// A relation whose columns no longer match the declaration is DROPPED
		// rather than altered, which is only safe because a projection is a
		// cache the CRDT can always rebuild, and the whole-index rebuild
		// repopulates every table right after this.
		//
		// `CREATE TABLE IF NOT EXISTS` alone was a live bug, and the most
		// ordinary declaration change there is triggered it: adding a field left
		// the old relation in place without the new column, so
		// `rebuildProjectedTable` failed with "table notes has no column named
		// pinned". Because the store then failed closed, the damage was not
		// confined to the new runtime: every read and write started reporting
		// `StorageFailed`, and `applyRemote` failed too, so through the
		// transport it was indistinguishable from a poison pill even though the
		// bytes were fine and every other replica took them.
		if (!columnsMatch(database, tableName, fields)) {
			database.run(`DROP TABLE IF EXISTS ${quoteIdentifier(tableName)}`);
		}
		const columns = fields.map((field) => `${quoteIdentifier(field)} ANY`);
		database.run(
			`CREATE TABLE IF NOT EXISTS ${quoteIdentifier(tableName)} (
				id TEXT PRIMARY KEY${columns.length === 0 ? '' : `,\n\t\t\t\t${columns.join(',\n\t\t\t\t')}`}
			) WITHOUT ROWID, STRICT`,
		);
	}
}

/**
 * Whether a projected relation already has exactly the declared columns.
 *
 * A relation that does not exist yet "matches", so a first open creates it
 * rather than dropping nothing and creating it. Order is compared as a set,
 * because the projection addresses columns by name.
 */
function columnsMatch(
	database: SqliteDatabase,
	tableName: string,
	fields: readonly string[],
): boolean {
	const existing = database.all<SqliteRow & { name: string }>(
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
 * decodes these back, because the CRDT is the truth and the projection is a
 * cache, so the two encodings can never be confused for one another.
 */
export function projectValue(value: JsonValue | undefined): SqliteValue {
	if (value === undefined || value === null) return null;
	if (typeof value === 'string' || typeof value === 'number') return value;
	if (typeof value === 'boolean') return value ? 1 : 0;
	return JSON.stringify(value);
}

/** Replace one row in the projection. */
export function upsertProjectedRow(
	database: SqliteDatabase,
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
	database.run(
		`INSERT OR REPLACE INTO ${quoteIdentifier(tableName)} (${columns
			.map(quoteIdentifier)
			.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
		values,
	);
}

/** Remove one row from the projection. A dead row is not a queryable row. */
export function deleteProjectedRow(
	database: SqliteDatabase,
	tableName: string,
	rowId: string,
): void {
	database.run(`DELETE FROM ${quoteIdentifier(tableName)} WHERE id = ?`, [
		rowId,
	]);
}

/** Drop and rebuild one table's projection from the CRDT. */
export function rebuildProjectedTable(
	database: SqliteDatabase,
	tableName: string,
	fieldNames: readonly string[],
	rows: ReadonlyMap<string, JsonObject>,
): void {
	database.run(`DELETE FROM ${quoteIdentifier(tableName)}`);
	for (const [rowId, payload] of rows) {
		upsertProjectedRow(database, tableName, fieldNames, rowId, payload);
	}
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
function quoteIdentifier(name: string): string {
	return `"${name.replaceAll('"', '""')}"`;
}
