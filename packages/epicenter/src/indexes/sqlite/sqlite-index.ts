import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Database } from '@tursodatabase/database/compat';
import { eq, sql } from 'drizzle-orm';
import {
	type BetterSQLite3Database,
	drizzle,
} from 'drizzle-orm/better-sqlite3';
import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { extractErrorMessage } from 'wellcrafted/error';
import { tryAsync } from 'wellcrafted/result';
import { defineQuery } from '../../core/actions';
import { IndexErr, IndexError } from '../../core/errors';
import {
	defineIndexExports,
	type Index,
	type IndexContext,
} from '../../core/indexes';
import type { WorkspaceSchema } from '../../core/schema';
import { convertWorkspaceSchemaToDrizzle } from '../../core/schema/converters/drizzle';
import { createIndexLogger } from '../error-logger';

/**
 * Bidirectional sync coordination state
 *
 * Prevents infinite loops during two-way synchronization between YJS (in-memory)
 * and SQLite database (on disk).
 *
 * The state ensures changes only flow in one direction at a time by tracking
 * which system is currently processing changes.
 */
type SyncCoordination = {
	/**
	 * True when pull operation is processing changes from SQLite to YJS
	 * YJS observers check this and skip processing to avoid the loop
	 */
	isProcessingSQLiteChange: boolean;

	/**
	 * True when push operation is processing changes from YJS to SQLite
	 * (Currently not checked since we don't have SQLite → YJS observers,
	 * but included for consistency with markdown index pattern)
	 */
	isProcessingYJSChange: boolean;
};

/**
 * Create a SQLite index
 * Syncs YJS changes to a SQLite database and exposes Drizzle query interface.
 *
 * This index creates internal resources (sqliteDb, drizzleTables) and exports them
 * via defineIndex(). All exported resources become available in your workspace exports
 * via the `indexes` parameter.
 *
 * **Storage**:
 * - Database: `.epicenter/{workspaceId}.db`
 * - Logs: `.epicenter/{workspaceId}/{indexId}.log`
 *
 * @param context - Index context with workspace ID, database instance, and storage directory
 *
 * @example
 * ```typescript
 * // In workspace definition:
 * indexes: {
 *   sqlite: (c) => sqliteIndex(c),  // Auto-saves to .epicenter/{id}.db
 * },
 *
 * exports: ({ indexes }) => ({
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
export const sqliteIndex = (async <TSchema extends WorkspaceSchema>({
	id,
	indexId,
	schema,
	db,
	epicenterDir,
}: IndexContext<TSchema>) => {
	// Require Node.js environment with filesystem access
	if (!epicenterDir) {
		throw new Error(
			'SQLite index requires Node.js environment with filesystem access',
		);
	}

	// Convert table schemas to Drizzle tables
	const drizzleTables = convertWorkspaceSchemaToDrizzle(schema);

	// Set up storage paths
	const databasePath = path.join(epicenterDir, `${id}.db`);
	await mkdir(path.dirname(databasePath), { recursive: true });

	// Create database connection with schema for proper type inference
	// WAL mode is enabled for better concurrent access
	// Using lazy connection - Database will auto-connect on first query
	const client = new Database(databasePath);
	client.exec('PRAGMA journal_mode = WAL');
	const sqliteDb = drizzle({ client, schema: drizzleTables });

	// Create error logger for this index
	// Structure: .epicenter/{workspaceId}/{indexId}.log
	const workspaceConfigDir = path.join(epicenterDir, id);
	const logPath = path.join(workspaceConfigDir, `${indexId}.log`);
	const logger = createIndexLogger({ logPath });

	/**
	 * Coordination state to prevent infinite sync loops
	 *
	 * How it works:
	 * - Before pull operation: set isProcessingSQLiteChange = true
	 *   - YJS observers check this and skip processing
	 * - Before push operation: set isProcessingYJSChange = true
	 *   - (Not currently checked, but consistent with pattern)
	 */
	const syncCoordination: SyncCoordination = {
		isProcessingSQLiteChange: false,
		isProcessingYJSChange: false,
	};

	// Set up observers for each table
	const unsubscribers: Array<() => void> = [];

	for (const table of db.$tables()) {
		const drizzleTable = drizzleTables[table.name];
		if (!drizzleTable) {
			throw new Error(`Drizzle table for "${table.name}" not found`);
		}

		const unsub = table.observe({
			onAdd: async (result) => {
				// Skip if this YJS change was triggered by a SQLite change we're processing
				// (prevents SQLite -> YJS -> SQLite infinite loop during pull)
				if (syncCoordination.isProcessingSQLiteChange) return;

				// Handle validation errors
				if (result.error) {
					logger.log(
						IndexError({
							message: `SQLite index onAdd: validation failed for ${table.name}`,
							context: result.error.context,
							cause: result.error,
						}),
					);
					return;
				}

				const row = result.data;
				const { error } = await tryAsync({
					try: async () => {
						const serializedRow = row.toJSON();
						// @ts-expect-error SerializedRow<TSchema[string]> is not assignable to InferInsertModel<DrizzleTable> due to union type from $tableEntries iteration
						await sqliteDb.insert(drizzleTable).values(serializedRow);
					},
					catch: (e) =>
						IndexErr({
							message: `SQLite index onAdd failed for ${table.name}/${row.id}: ${extractErrorMessage(e)}`,
							context: { tableName: table.name, id: row.id, data: row },
						}),
				});

				if (error) {
					logger.log(error);
				}
			},
			onUpdate: async (result) => {
				// Skip if this YJS change was triggered by a SQLite change we're processing
				// (prevents SQLite -> YJS -> SQLite infinite loop during pull)
				if (syncCoordination.isProcessingSQLiteChange) return;

				// Handle validation errors
				if (result.error) {
					logger.log(
						IndexError({
							message: `SQLite index onUpdate: validation failed for ${table.name}`,
							context: result.error.context,
							cause: result.error,
						}),
					);
					return;
				}

				const row = result.data;
				const { error } = await tryAsync({
					try: async () => {
						const serializedRow = row.toJSON();
						await sqliteDb
							.update(drizzleTable)
							// @ts-expect-error SerializedRow<TSchema[string]> is not assignable to Partial<InferInsertModel<DrizzleTable>> due to union type from $tableEntries iteration
							.set(serializedRow)
							// @ts-expect-error Column<string> is not assignable to Column<typeof table.id> due to union type from $tableEntries iteration
							.where(eq(drizzleTable.id, row.id));
					},
					catch: (e) =>
						IndexErr({
							message: `SQLite index onUpdate failed for ${table.name}/${row.id}: ${extractErrorMessage(e)}`,
							context: { tableName: table.name, id: row.id, data: row },
						}),
				});

				if (error) {
					logger.log(error);
				}
			},
			onDelete: async (id) => {
				// Skip if this YJS change was triggered by a SQLite change we're processing
				// (prevents SQLite -> YJS -> SQLite infinite loop during pull)
				if (syncCoordination.isProcessingSQLiteChange) return;

				const { error } = await tryAsync({
					try: async () => {
						await sqliteDb
							.delete(drizzleTable)
							// @ts-expect-error Column<string> is not assignable to Column<typeof table.id> due to union type from $tableEntries iteration
							.where(eq(drizzleTable.id, id));
					},
					catch: (e) =>
						IndexErr({
							message: `SQLite index onDelete failed for ${table.name}/${id}: ${extractErrorMessage(e)}`,
							context: { tableName: table.name, id },
						}),
				});

				if (error) {
					logger.log(error);
				}
			},
		});
		unsubscribers.push(unsub);
	}

	// Initial sync: YJS → SQLite (blocking to ensure tables exist before queries)
	// Always recreate tables to handle schema changes (e.g., column renames)
	await recreateTables(sqliteDb, drizzleTables);

	// Insert all valid rows from YJS into SQLite
	for (const table of db.$tables()) {
		const drizzleTable = drizzleTables[table.name];
		if (!drizzleTable) {
			throw new Error(`Drizzle table for "${table.name}" not found`);
		}

		const rows = table.getAll();

		if (rows.length > 0) {
			const { error } = await tryAsync({
				try: async () => {
					const serializedRows = rows.map((row) => row.toJSON());
					// @ts-expect-error SerializedRow<TSchema[string]>[] is not assignable to InferInsertModel<DrizzleTable>[] due to union type from $tables() iteration
					await sqliteDb.insert(drizzleTable).values(serializedRows);
				},
				catch: (e) =>
					IndexErr({
						message: `Failed to sync ${rows.length} rows to SQLite during init: ${extractErrorMessage(e)}`,
						context: { rowCount: rows.length, tableName: table.name },
					}),
			});

			if (error) {
				logger.log(error);
			}
		}
	}

	// Return destroy function alongside exported resources (flattened structure)
	return defineIndexExports({
		async destroy() {
			for (const unsub of unsubscribers) {
				unsub();
			}
			// Flush and close logger to ensure all pending logs are written
			await logger.close();
			// Close the database connection to ensure WAL files are properly checkpointed
			client.close();
		},

		/**
		 * Pull: Sync from YJS to SQLite (replace all SQLite data with current YJS data)
		 */
		pullToSqlite: defineQuery({
			description:
				'Pull all YJS data to SQLite (deletes existing rows and writes fresh copies)',
			handler: async () => {
				return tryAsync({
					try: async () => {
						syncCoordination.isProcessingYJSChange = true;

						// Delete all rows from all SQLite tables
						for (const table of db.$tables()) {
							const drizzleTable = drizzleTables[table.name];
							if (!drizzleTable) {
								throw new Error(`Drizzle table for "${table.name}" not found`);
							}
							await sqliteDb.delete(drizzleTable);
						}

						// Insert all valid rows from YJS into SQLite
						for (const table of db.$tables()) {
							const drizzleTable = drizzleTables[table.name];
							if (!drizzleTable) {
								throw new Error(`Drizzle table for "${table.name}" not found`);
							}

							const rows = table.getAll();

							if (rows.length > 0) {
								const serializedRows = rows.map((row) => row.toJSON());
								// @ts-expect-error SerializedRow<TSchema[string]>[] is not assignable to InferInsertModel<DrizzleTable>[] due to union type from $tables() iteration
								await sqliteDb.insert(drizzleTable).values(serializedRows);
							}
						}

						syncCoordination.isProcessingYJSChange = false;
					},
					catch: (error) => {
						syncCoordination.isProcessingYJSChange = false;
						return IndexErr({
							message: `SQLite index push failed: ${extractErrorMessage(error)}`,
							context: { operation: 'push' },
						});
					},
				});
			},
		}),

		/**
		 * Push: Sync from SQLite to YJS (replace all YJS data with current SQLite data)
		 */
		pushFromSqlite: defineQuery({
			description:
				'Push all SQLite data into YJS (clears YJS tables and imports from database)',
			handler: async () => {
				return tryAsync({
					try: async () => {
						syncCoordination.isProcessingSQLiteChange = true;

						// Clear all YJS tables
						db.$clearAll();

						// Read all rows from SQLite and insert into YJS
						for (const table of db.$tables()) {
							const drizzleTable = drizzleTables[table.name];
							if (!drizzleTable) {
								throw new Error(`Drizzle table for "${table.name}" not found`);
							}

							const rows = await sqliteDb.select().from(drizzleTable);

							for (const row of rows) {
								// @ts-expect-error InferSelectModel<DrizzleTable> is not assignable to InferInsertModel<TableHelper<TSchema[string]>> due to union type from $tables() iteration
								const result = table.insert(row);
								if (result.error) {
									// @ts-expect-error row.id exists but TypeScript cannot narrow the union type from $tables() iteration
									const rowId = row.id;
									logger.log(
										IndexError({
											message: `Failed to insert row ${rowId} from SQLite into YJS table ${table.name}`,
											context: {
												rowId,
												tableName: table.name,
												cause: result.error,
											},
										}),
									);
								}
							}
						}

						syncCoordination.isProcessingSQLiteChange = false;
					},
					catch: (error) => {
						syncCoordination.isProcessingSQLiteChange = false;
						return IndexErr({
							message: `SQLite index pull failed: ${extractErrorMessage(error)}`,
							context: { operation: 'pull' },
						});
					},
				});
			},
		}),

		db: sqliteDb,
		...drizzleTables,
	});
}) satisfies Index;

/**
 * Drop and recreate SQLite tables
 *
 * Always drops existing tables before recreating to handle schema changes
 * (e.g., column renames, type changes). This is safe because SQLite is just
 * an index; YJS is the source of truth and data is re-synced after recreation.
 *
 * Uses Drizzle's official getTableConfig API for introspection.
 */
async function recreateTables<TSchema extends Record<string, SQLiteTable>>(
	db: BetterSQLite3Database<TSchema>,
	drizzleTables: TSchema,
): Promise<void> {
	for (const drizzleTable of Object.values(drizzleTables)) {
		const tableConfig = getTableConfig(drizzleTable);

		// Drop existing table to handle schema changes
		await db.run(sql.raw(`DROP TABLE IF EXISTS "${tableConfig.name}"`));

		// Build column definitions
		const columnDefs: string[] = [];
		for (const column of tableConfig.columns) {
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

			// Quote column names to handle SQLite reserved keywords (e.g., "from", "to", "order")
			columnDefs.push(`"${column.name}" ${sqlType}${constraints}`);
		}

		// Create table with current schema
		const createTableSQL = `CREATE TABLE "${tableConfig.name}" (${columnDefs.join(', ')})`;
		await db.run(sql.raw(createTableSQL));
	}
}
