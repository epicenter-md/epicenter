/**
 * Runtime DDL generation from Drizzle schema definitions.
 *
 * Uses `getTableConfig()` from `drizzle-orm/sqlite-core` to introspect a
 * `sqliteTable` definition and produce `CREATE TABLE` + `CREATE INDEX`
 * SQL strings. This eliminates the duplication of defining columns in
 * both Drizzle schema and raw SQL.
 *
 * Drizzle itself doesn't expose DDL generation at runtime—that logic
 * lives in drizzle-kit's serializer. This utility replicates the
 * subset needed for in-memory SQLite (sql.js) table creation.
 *
 * @module
 */

import {
	getTableConfig,
	type SQLiteTableWithColumns,
} from 'drizzle-orm/sqlite-core';

/**
 * Generate `CREATE TABLE IF NOT EXISTS` SQL from a Drizzle `sqliteTable` definition.
 *
 * Introspects columns via `getTableConfig()` and builds the DDL string.
 * Handles TEXT, INTEGER primary keys, NOT NULL constraints.
 *
 * @example
 * ```typescript
 * import { files } from './schema.js';
 * const sql = generateCreateTableSQL(files);
 * // CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY NOT NULL, ...)
 * ```
 */
export function generateCreateTableSQL(
	// biome-ignore lint/suspicious/noExplicitAny: getTableConfig requires SQLiteTable<any>
	table: SQLiteTableWithColumns<any>,
): string {
	const config = getTableConfig(table);

	const columnDefs = config.columns.map((col) => {
		let def = `${col.name} ${col.getSQLType()}`;
		if (col.primary) def += ' PRIMARY KEY';
		if (col.notNull) def += ' NOT NULL';
		return def;
	});

	return `CREATE TABLE IF NOT EXISTS ${config.name} (${columnDefs.join(', ')})`;
}

/**
 * Generate `CREATE INDEX IF NOT EXISTS` SQL statements from a Drizzle table's indexes.
 *
 * Returns one SQL string per index defined in the schema's third argument.
 *
 * @example
 * ```typescript
 * import { files } from './schema.js';
 * const statements = generateCreateIndexSQL(files);
 * // ['CREATE INDEX IF NOT EXISTS parent_idx ON files(parent_id)', ...]
 * ```
 */
// biome-ignore lint/suspicious/noExplicitAny: getTableConfig requires SQLiteTable<any>
export function generateCreateIndexSQL(
	table: SQLiteTableWithColumns<any>,
): string[] {
	const config = getTableConfig(table);

	return config.indexes.map((idx) => {
		const idxConfig = idx.config;
		const columns = idxConfig.columns
			.map((col) => {
				if ('name' in col) return (col as { name: string }).name;
				return String(col);
			})
			.join(', ');

		const unique = idxConfig.unique ? 'UNIQUE ' : '';
		return `CREATE ${unique}INDEX IF NOT EXISTS ${idxConfig.name} ON ${config.name}(${columns})`;
	});
}

/**
 * Generate all DDL statements (CREATE TABLE + CREATE INDEX) for a Drizzle table.
 *
 * Convenience wrapper that combines {@link generateCreateTableSQL} and
 * {@link generateCreateIndexSQL} into a single array of SQL strings,
 * ready to be executed sequentially.
 *
 * @example
 * ```typescript
 * import { files } from './schema.js';
 * for (const sql of generateDDL(files)) {
 *   sqlite.run(sql);
 * }
 * ```
 */
// biome-ignore lint/suspicious/noExplicitAny: getTableConfig requires SQLiteTable<any>
export function generateDDL(table: SQLiteTableWithColumns<any>): string[] {
	return [generateCreateTableSQL(table), ...generateCreateIndexSQL(table)];
}
