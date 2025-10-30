import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Database } from '@tursodatabase/database/compat';
import { eq, sql } from 'drizzle-orm';
import {
	type BetterSQLite3Database,
	drizzle,
} from 'drizzle-orm/better-sqlite3';
import { type SQLiteTable, getTableConfig } from 'drizzle-orm/sqlite-core';
import { Ok, tryAsync } from 'wellcrafted/result';
import { IndexErr } from '../../core/errors';
import { defineIndex } from '../../core/indexes';
import type { WorkspaceSchema } from '../../core/schema';
import type { Db } from '../../db/core';
import { convertWorkspaceSchemaToDrizzle } from './schema-converter';

/**
 * SQLite index configuration
 */
export type SQLiteIndexConfig = {
	/**
	 * Path to the SQLite database file.
	 *
	 * If provided, the SQLite index will use file-based storage at this path.
	 * If not provided, the index will use in-memory storage (useful for testing).
	 *
	 * For file-based storage, construct the path using:
	 * ```typescript
	 * path: join(import.meta.dirname, '.epicenter/database.db')
	 * ```
	 */
	path?: string;
};

/**
 * Create a SQLite index
 * Syncs YJS changes to a SQLite database and exposes Drizzle query interface.
 *
 * This index creates internal resources (sqliteDb, drizzleTables) and exports them
 * via defineIndex(). All exported resources become available in your workspace actions
 * via the `indexes` parameter.
 *
 * @param db - Epicenter database instance
 * @param config - SQLite configuration
 *
 * @example
 * ```typescript
 * // In workspace definition with file-based storage:
 * indexes: {
 *   sqlite: (db) => sqliteIndex(db, {
 *     path: join(import.meta.dirname, '.epicenter/database.db')
 *   }),
 * },
 *
 * // Or with in-memory storage (for testing):
 * indexes: {
 *   sqlite: (db) => sqliteIndex(db),
 * },
 *
 * actions: ({ indexes }) => ({
 *   // Access exported resources from the index
 *   getPost: defineQuery({
 *     handler: async ({ id }) => {
 *       // indexes.sqlite.db is the exported Drizzle database instance
 *       // indexes.sqlite.posts is the exported Drizzle table
 *       return await indexes.sqlite.db
 *         .select()
 *         .from(indexes.sqlite.posts)
 *         .where(eq(indexes.sqlite.posts.id, id));
 *     }
 *   })
 * })
 * ```
 */
export async function sqliteIndex<TSchema extends WorkspaceSchema>(
	db: Db<TSchema>,
	config: SQLiteIndexConfig = {},
) {
	// Convert table schemas to Drizzle tables
	const drizzleTables = convertWorkspaceSchemaToDrizzle(db.schema);

	// Determine database path based on config
	let resolvedDatabasePath: string;
	if (config.path) {
		// File-based storage: use provided path
		resolvedDatabasePath = config.path;

		// Create parent directory if it doesn't exist
		const dirPath = resolvedDatabasePath.substring(
			0,
			resolvedDatabasePath.lastIndexOf('/'),
		);
		if (dirPath) {
			await mkdir(dirPath, { recursive: true });
		}
	} else {
		// In-memory storage
		resolvedDatabasePath = ':memory:';
	}

	// Create database connection with schema for proper type inference
	// WAL mode is enabled for better concurrent access
	// Using lazy connection - Database will auto-connect on first query
	const client = new Database(resolvedDatabasePath);
	client.exec('PRAGMA journal_mode = WAL');
	const sqliteDb = drizzle({ client, schema: drizzleTables });

	// Set up observers for each table
	const unsubscribers: Array<() => void> = [];

	for (const tableName of db.getTableNames()) {
		const drizzleTable = drizzleTables[tableName];
		if (!drizzleTable) {
			throw new Error(`Drizzle table for "${tableName}" not found`);
		}

		const unsub = db.tables[tableName]!.observe({
			onAdd: async (row) => {
				const { error } = await tryAsync({
					try: async () => {
						const serializedRow = row.toJSON();
						await sqliteDb.insert(drizzleTable as any).values(serializedRow);
					},
					catch: () => Ok(undefined),
				});

				if (error) {
					console.error(
						IndexErr({
							message: `SQLite index onAdd failed for ${tableName}/${row.id}`,
							context: { tableName, id: row.id, data: row },
							cause: error,
						}),
					);
				}
			},
			onUpdate: async (row) => {
				const { error } = await tryAsync({
					try: async () => {
						const serializedRow = row.toJSON();
						await sqliteDb
							.update(drizzleTable as any)
							.set(serializedRow)
							.where(eq((drizzleTable as any).id, row.id));
					},
					catch: () => Ok(undefined),
				});

				if (error) {
					console.error(
						IndexErr({
							message: `SQLite index onUpdate failed for ${tableName}/${row.id}`,
							context: { tableName, id: row.id, data: row },
							cause: error,
						}),
					);
				}
			},
			onDelete: async (id) => {
				const { error } = await tryAsync({
					try: async () => {
						await sqliteDb
							.delete(drizzleTable as any)
							.where(eq((drizzleTable as any).id, id));
					},
					catch: () => Ok(undefined),
				});

				if (error) {
					console.error(
						IndexErr({
							message: `SQLite index onDelete failed for ${tableName}/${id}`,
							context: { tableName, id },
							cause: error,
						}),
					);
				}
			},
		});
		unsubscribers.push(unsub);
	}

	// Initial sync: YJS → SQLite (blocking to ensure tables exist before queries)
	await createTablesIfNotExist(sqliteDb, drizzleTables);

	for (const tableName of db.getTableNames()) {
		const drizzleTable = drizzleTables[tableName];
		if (!drizzleTable) {
			throw new Error(`Drizzle table for "${tableName}" not found`);
		}

		const results = db.tables[tableName]!.getAll();
		const rows = results.filter((r) => r.status === 'valid').map((r) => r.row);

		for (const row of rows) {
			const { error } = await tryAsync({
				try: async () => {
					const serializedRow = row.toJSON();
					await sqliteDb.insert(drizzleTable as any).values(serializedRow);
				},
				catch: () => Ok(undefined),
			});

			if (error) {
				console.warn(
					`Failed to sync row ${row.id} to SQLite during init:`,
					error,
				);
			}
		}
	}

	// Return destroy function alongside exported resources (flattened structure)
	return defineIndex({
		destroy() {
			for (const unsub of unsubscribers) {
				unsub();
			}
		},
		db: sqliteDb,
		...drizzleTables,
	});
}

/**
 * Create SQLite tables if they don't exist
 * Uses Drizzle's official getTableConfig API for introspection
 */
async function createTablesIfNotExist<
	TSchema extends Record<string, SQLiteTable>,
>(db: BetterSQLite3Database<TSchema>, drizzleTables: TSchema): Promise<void> {
	for (const drizzleTable of Object.values(drizzleTables)) {
		const tableConfig = getTableConfig(drizzleTable);
		const columnDefs: string[] = [];

		for (const column of tableConfig.columns) {
			// Use column.getSQLType() to get the SQL type directly
			const sqlType = column.getSQLType();

			let constraints = '';
			if (column.notNull) {
				constraints += ' NOT NULL';
			}
			if (column.primary) {
				constraints += ' PRIMARY KEY';
			}
			if (column.isUnique) {
				constraints += ' UNIQUE';
			}

			columnDefs.push(`${column.name} ${sqlType}${constraints}`);
		}

		const createTableSQL = `CREATE TABLE IF NOT EXISTS ${tableConfig.name} (${columnDefs.join(', ')})`;
		await db.run(sql.raw(createTableSQL));
	}
}
