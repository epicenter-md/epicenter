import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Database } from '@tursodatabase/database/compat';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { extractErrorMessage } from 'wellcrafted/error';
import { tryAsync } from 'wellcrafted/result';
import { defineExports, type ExtensionContext } from '../../dynamic/extension';
import type { Id, KvField, Row, TableDefinition } from '../../dynamic/schema';
import { Id as createId } from '../../dynamic/schema';
import { convertTableDefinitionsToDrizzle } from '../../dynamic/schema/converters/to-drizzle';
import { ExtensionErr, ExtensionError } from '../../shared/errors';
import { createIndexLogger } from '../error-logger';

const DEFAULT_DEBOUNCE_MS = 100;

/**
 * Configuration for the SQLite extension.
 */
export type SqliteConfig = {
	/** Absolute path to the .db file. */
	dbPath: string;
	/** Absolute path to logs directory. */
	logsDir: string;
	/**
	 * Debounce interval in milliseconds.
	 *
	 * Changes are batched and synced after this delay. When the debounce fires,
	 * SQLite is rebuilt from YJS (all rows deleted, then re-inserted).
	 *
	 * Lower values = more responsive but more SQLite writes.
	 * Higher values = better batching but longer staleness.
	 *
	 * @default 100
	 */
	debounceMs?: number;
};

/**
 * SQLite extension: syncs YJS changes to SQLite and exposes Drizzle query interface.
 *
 * This extension creates internal resources (sqliteDb, drizzleTables) and exports them
 * via defineExports(). All exported resources become available in your workspace
 * via `client.extensions.sqlite`.
 *
 * **Sync Strategy**:
 * Changes are debounced (default 100ms), then SQLite is rebuilt from YJS.
 * This "rebuild on change" approach is simple and guarantees consistency:
 * - No race conditions from interleaved async operations
 * - No ordering bugs when multiple transactions touch the same row
 * - SQLite always matches YJS exactly after sync
 *
 * The rebuild is fast enough for most use cases (<50k items). For very large
 * datasets, consider splitting into multiple workspaces.
 *
 * @param context - Extension context with workspace ID and tables instance
 * @param config - Configuration with paths and optional debounce settings
 *
 * @example
 * ```typescript
 * import { createWorkspace } from '@epicenter/hq/dynamic';
 * import { sqlite } from '@epicenter/hq/extensions/sqlite';
 * import { join } from 'node:path';
 *
 * const projectDir = '/my/project';
 * const epicenterDir = join(projectDir, '.epicenter');
 *
 * const workspace = createWorkspace({ name: 'Blog', tables: {...} })
 *   .withExtensions({
 *     sqlite: (ctx) => sqlite(ctx, {
 *       dbPath: join(epicenterDir, 'sqlite', `${ctx.id}.db`),
 *       logsDir: join(epicenterDir, 'sqlite', 'logs'),
 *     }),
 *   });
 *
 * // Query with Drizzle:
 * const posts = await workspace.extensions.sqlite.db
 *   .select()
 *   .from(workspace.extensions.sqlite.posts);
 * ```
 */
export const sqlite = async <
	TTableDefinitions extends readonly TableDefinition[],
	TKvFields extends readonly KvField[],
>(
	{ id, tables }: ExtensionContext<TTableDefinitions, TKvFields>,
	config: SqliteConfig,
) => {
	const { dbPath, logsDir, debounceMs = DEFAULT_DEBOUNCE_MS } = config;

	const drizzleTables = convertTableDefinitionsToDrizzle(tables.definitions);

	await mkdir(path.dirname(dbPath), { recursive: true });
	await mkdir(logsDir, { recursive: true });

	const client = new Database(dbPath);
	client.exec('PRAGMA journal_mode = WAL');
	const sqliteDb = drizzle({ client, schema: drizzleTables });

	const logger = createIndexLogger({
		logPath: path.join(logsDir, `${id}.log`),
	});

	// Prevents infinite loop during pushFromSqlite: when we insert into YJS,
	// observers fire and would schedule a sync back to SQLite without this flag
	let isPushingFromSqlite = false;

	// =========================================================================
	// SQLite helpers (use sqliteDb and drizzleTables from closure)
	// =========================================================================

	/**
	 * Drop and recreate all SQLite tables.
	 *
	 * Always drops existing tables before recreating to handle schema changes
	 * (e.g., column renames, type changes). This is safe because SQLite is just
	 * an index; YJS is the source of truth and data is re-synced after recreation.
	 *
	 * Uses Drizzle's getTableConfig API for schema introspection.
	 */
	async function recreateTables() {
		for (const drizzleTable of Object.values(drizzleTables) as SQLiteTable[]) {
			const tableConfig = getTableConfig(drizzleTable);

			// Drop existing table to handle schema changes
			await sqliteDb.run(sql.raw(`DROP TABLE IF EXISTS "${tableConfig.name}"`));

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
			await sqliteDb.run(sql.raw(createTableSQL));
		}
	}

	/**
	 * Rebuild SQLite from YJS data.
	 * Drops/recreates tables then inserts all rows from YJS.
	 */
	async function rebuildSqlite() {
		// Drop and recreate tables (benchmarks show this is faster than DELETE at scale)
		await recreateTables();

		// Insert all valid rows from YJS into SQLite
		for (const [tableName, drizzleTable] of Object.entries(drizzleTables) as [
			string,
			SQLiteTable,
		][]) {
			const table = tables.get(tableName);
			const rows = table.getAllValid();

			if (rows.length > 0) {
				const { error } = await tryAsync({
					try: async () => {
						await sqliteDb.insert(drizzleTable).values(rows);
					},
					catch: (e) =>
						ExtensionErr({
							message: `Failed to sync ${rows.length} rows to table "${tableName}" in SQLite: ${extractErrorMessage(e)}`,
						}),
				});

				if (error) {
					logger.log(error);
				}
			}
		}
	}

	// =========================================================================
	// Debounce state
	// =========================================================================
	let syncTimeout: NodeJS.Timeout | null = null;

	function scheduleSync() {
		if (syncTimeout) clearTimeout(syncTimeout);
		syncTimeout = setTimeout(async () => {
			syncTimeout = null;
			await rebuildSqlite();
		}, debounceMs);
	}

	// =========================================================================
	// Set up observers for each table
	// =========================================================================
	const unsubscribers: Array<() => void> = [];

	for (const tableName of Object.keys(tables.definitions)) {
		const table = tables.get(tableName);
		const unsub = table.observe((changedIds) => {
			if (isPushingFromSqlite) return;

			for (const id of changedIds) {
				const result = table.get(id);
				if (result.status === 'not_found') {
					// Row was deleted - no validation needed
					continue;
				}
				if (result.status === 'invalid') {
					logger.log(
						ExtensionError({
							message: `SQLite extension: validation failed for ${tableName}`,
						}),
					);
				}
				// result.status === 'valid' means row was added or updated - sync will handle it
			}

			scheduleSync();
		});
		unsubscribers.push(unsub);
	}

	// =========================================================================
	// Initial sync: YJS → SQLite (blocking to ensure tables exist before queries)
	// =========================================================================
	await recreateTables();

	// Insert all valid rows from YJS into SQLite
	for (const [tableName, drizzleTable] of Object.entries(drizzleTables) as [
		string,
		SQLiteTable,
	][]) {
		const table = tables.get(tableName);
		const rows = table.getAllValid();

		if (rows.length > 0) {
			const { error } = await tryAsync({
				try: async () => {
					await sqliteDb.insert(drizzleTable).values(rows);
				},
				catch: (e) =>
					ExtensionErr({
						message: `Failed to sync ${rows.length} rows to table "${tableName}" in SQLite during init: ${extractErrorMessage(e)}`,
					}),
			});

			if (error) {
				logger.log(error);
			}
		}
	}

	// Return destroy function alongside exported resources (flattened structure)
	return defineExports({
		async destroy() {
			// Clear any pending sync timeout
			if (syncTimeout) {
				clearTimeout(syncTimeout);
				syncTimeout = null;
			}

			for (const unsub of unsubscribers) {
				unsub();
			}
			// Flush and close logger to ensure all pending logs are written
			await logger.close();
			// Close the database connection to ensure WAL files are properly checkpointed
			client.close();
		},

		async pullToSqlite() {
			return tryAsync({
				try: () => rebuildSqlite(),
				catch: (error) =>
					ExtensionErr({
						message: `SQLite extension pull operation failed: ${extractErrorMessage(error)}`,
					}),
			});
		},

		async pushFromSqlite() {
			return tryAsync({
				try: async () => {
					isPushingFromSqlite = true;
					tables.clear();

					for (const [tableName, drizzleTable] of Object.entries(
						drizzleTables,
					) as [string, SQLiteTable][]) {
						const table = tables.get(tableName);
						const rows = await sqliteDb.select().from(drizzleTable);
						for (const row of rows) {
							// Cast is safe: Drizzle schema is derived from workspace definition
							// Convert string id to branded Id type
							const rowWithBrandedId = {
								...row,
								id: createId((row as { id: string }).id),
							} as Row<TTableDefinitions[number]['fields']> & {
								id: Id;
							};
							table.upsert(rowWithBrandedId);
						}
					}

					isPushingFromSqlite = false;
				},
				catch: (error) => {
					isPushingFromSqlite = false;
					return ExtensionErr({
						message: `SQLite extension push operation failed: ${extractErrorMessage(error)}`,
					});
				},
			});
		},

		db: sqliteDb,
		...drizzleTables,
	});
};
