/**
 * The lens's derived SQL: one real table per declared table, rebuilt at bind.
 *
 * Split from the durable log beside it because the two share a file and nothing
 * else. The log is the CRDT's own bytes and is read by `../sync`; this is a
 * cache the CRDT can always rebuild, and it is the only thing here that knows
 * what a lens declared.
 */
import type {
	JsonObject,
	JsonValue,
	ParsedLens,
	ParsedTable,
} from '@epicenter/lens';
import type {
	SqliteDatabase,
	SqliteRow,
	SqliteValue,
} from '@epicenter/sqlite';


/**
 * A projection table per lens table: `id` plus one column per declared field.
 *
 * Columns are `ANY` rather than typed from the field's arktype expression. A
 * field is a union as often as not (`'string|null'`), and the projection is a
 * cache the CRDT can always rebuild, so deriving a narrow column type would buy
 * nothing and cost a mapping that has to be right for every expression.
 *
 * The name is quoted but the lens has already refused anything that is not a
 * bare SQL identifier, so quoting is defence rather than permission.
 */
export function applyProjectionSchema(
	database: SqliteDatabase,
	lens: ParsedLens,
): void {
	// KV projects as a one-row relation named `kv`, which the lens reserves as a
	// table name so nothing can collide with it.
	const relations: [string, ParsedTable][] = [
		...(lens.kv === undefined ? [] : ([['kv', lens.kv]] as [string, ParsedTable][])),
		...lens.tables,
	];
	for (const [tableName, table] of relations) {
		const fields = [...table.fields.keys()];
		// A relation whose columns no longer match the lens is DROPPED rather than
		// altered, which is only safe because a projection is a cache the CRDT can
		// always rebuild, and `bindUnknown` rebuilds every table right after this.
		//
		// `CREATE TABLE IF NOT EXISTS` alone was a live bug, and the most ordinary
		// lens change there is triggered it: adding a field left the old relation
		// in place without the new column, so `rebuildProjectedTable` failed with
		// "table notes has no column named pinned". Because `persist` fails closed,
		// that did not stop at the new binding: the binding the app already held
		// started reporting `StorageFailed` for every read and write, and
		// `applyRemote` failed too, so through the transport it was indistinguish-
		// able from a poison pill even though the bytes were fine and every other
		// replica took them.
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
 * Whether a projected relation already has exactly the columns a lens declares.
 *
 * A relation that does not exist yet "matches", so a first bind creates it
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
 * The lens already refuses any table or field name that is not a bare
 * identifier, so this never has real work to do. It stays because the
 * projection builds SQL by concatenation, and a schema that depends on a
 * validator two packages away for its safety should not also depend on nobody
 * ever relaxing that validator.
 */
function quoteIdentifier(name: string): string {
	return `"${name.replaceAll('"', '""')}"`;
}
