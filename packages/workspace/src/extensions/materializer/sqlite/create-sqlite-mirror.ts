/**
 * Create the main SQLite mirror workspace extension.
 *
 * This materializes workspace tables into a caller-provided SQLite database so
 * SQL reads and FTS5 queries can run against a derived cache instead of the
 * Yjs source of truth. The mirror waits for the workspace to hydrate, creates
 * SQLite tables from the workspace schemas, performs an initial full load, then
 * keeps the mirror fresh with debounced incremental sync.
 *
 * @module
 */

import type { StandardJSONSchemaV1 } from '@standard-schema/spec';
import { standardSchemaToJsonSchema } from '../../../shared/standard-schema/to-json-schema.js';
import type { BaseRow, TableHelper } from '../../../workspace/types.js';
import { generateDdl, quoteIdentifier } from './ddl.js';
import type {
	SearchOptions,
	SearchResult,
	SqliteMirror,
	SqliteMirrorOptions,
	SyncChange,
} from './types.js';

type SqliteMirrorContext = {
	tables: Record<string, TableHelper<BaseRow>>;
	definitions: { tables: Record<string, unknown> };
	whenReady: Promise<void>;
};

/**
 * Create a workspace extension that mirrors table rows into SQLite.
 *
 * Use this when Yjs should remain the write path, but you still want fast SQL
 * reads, optional FTS5 search, and lifecycle hooks for downstream indexing.
 * The returned function plugs directly into `.withWorkspaceExtension()`.
 *
 * @example
 * ```typescript
 * const workspace = createWorkspace(definition).withWorkspaceExtension(
 * 	'sqlite',
 * 	createSqliteMirror({
 * 		db,
 * 		fts: {
 * 			posts: ['title', 'body'],
 * 		},
 * 	}),
 * );
 *
 * await workspace.extensions.sqlite.whenReady;
 * const hits = await workspace.extensions.sqlite.search('posts', 'local-first');
 * ```
 */
export function createSqliteMirror(
	options: SqliteMirrorOptions,
): (context: SqliteMirrorContext) => SqliteMirror {
	const { db, onReady, onSync } = options;
	const debounceMs = options.debounceMs ?? 100;

	return (context: SqliteMirrorContext): SqliteMirror => {
		const mirroredTables = resolveMirroredTables(context, options.tables);
		const unsubscribes: Array<() => void> = [];
		let pendingSync = new Map<string, Set<string>>();
		let syncTimeout: ReturnType<typeof setTimeout> | null = null;
		// Each flush chains onto the previous via .then() so concurrent observer
		// callbacks don't trigger parallel SQLite writes. Resolved promises are
		// GC'd — the chain does not leak.
		let syncQueue = Promise.resolve();
		let isDisposed = false;

		// ── Public methods ───────────────────────────────────────────

		async function rebuild() {
			await whenReady;

			if (isDisposed) {
				return;
			}

			await rebuildTables();
		}

		async function rebuildTable(tableName: string) {
			await whenReady;

			if (isDisposed) {
				return;
			}

			const table = mirroredTables.get(tableName);
			if (table === undefined) {
				throw new Error(
					`Cannot rebuild "${tableName}" — not in the mirrored table set.`,
				);
			}

			await db.exec('BEGIN');
			try {
				await db.exec(`DELETE FROM ${quoteIdentifier(tableName)}`);
				await fullLoadTable(tableName, table);
				await db.exec('COMMIT');
			} catch (error: unknown) {
				await db.exec('ROLLBACK');
				throw error;
			}
		}

		async function count(tableName: string): Promise<number> {
			await whenReady;

			if (isDisposed) {
				return 0;
			}

			try {
				const row = await db
					.prepare(
						`SELECT COUNT(*) AS count FROM ${quoteIdentifier(tableName)}`,
					)
					.get();
				return Number(row?.count ?? 0);
			} catch {
				return 0;
			}
		}

		async function search(
			table: string,
			query: string,
			searchOptions?: SearchOptions,
		): Promise<SearchResult[]> {
			await whenReady;

			if (isDisposed) {
				return [];
			}

			const trimmed = query.trim();
			if (!trimmed) {
				return [];
			}

			const ftsColumns = options.fts?.[table];
			if (ftsColumns === undefined || ftsColumns.length === 0) {
				return [];
			}

			const ftsTableName = `${table}_fts`;
			const limit = searchOptions?.limit ?? 50;
			const snippetColumnIndex = searchOptions?.snippetColumn
				? Math.max(ftsColumns.indexOf(searchOptions.snippetColumn), 0)
				: 0;

			try {
				const qt = quoteIdentifier(table);
				const qfts = quoteIdentifier(ftsTableName);
				const rows = await db
					.prepare(
						`SELECT ${qt}.${quoteIdentifier('id')} AS id,\n` +
							`  snippet(${qfts}, ${snippetColumnIndex}, '<mark>', '</mark>', '...', 64) AS snippet,\n` +
							`  rank\n` +
							`FROM ${qfts}\n` +
							`JOIN ${qt} ON ${qt}.rowid = ${qfts}.rowid\n` +
							`WHERE ${qfts} MATCH ?\n` +
							`ORDER BY rank LIMIT ?`,
					)
					.all(trimmed, limit);

				return rows.map((row) => ({
					id: String(row.id),
					snippet: String(row.snippet ?? ''),
					rank: Number(row.rank ?? 0),
				}));
			} catch (error: unknown) {
				console.warn('[createSqliteMirror] FTS search failed.', error);
				return [];
			}
		}

		function dispose() {
			isDisposed = true;

			if (syncTimeout !== null) {
				clearTimeout(syncTimeout);
				syncTimeout = null;
			}

			for (const unsubscribe of unsubscribes) {
				unsubscribe();
			}
		}

		// ── Lifecycle ────────────────────────────────────────────────

		async function initialize() {
			await context.whenReady;

			if (isDisposed) {
				return;
			}

			for (const [tableName] of mirroredTables) {
				const jsonSchema = getTableJsonSchema(context, tableName);
				await db.exec(generateDdl(tableName, jsonSchema));
			}

			validateFtsConfig();
			await setupFtsTables();

			if (isDisposed) {
				return;
			}

			await rebuildTables();

			if (isDisposed) {
				return;
			}

			if (onReady) {
				await onReady(db);
			}

			if (isDisposed) {
				return;
			}

			for (const [tableName, table] of mirroredTables) {
				const unsubscribe = table.observe((changedIds) => {
					scheduleSync(tableName, changedIds);
				});
				unsubscribes.push(unsubscribe);
			}
		}

		// ── Sync engine ──────────────────────────────────────────────

		function scheduleSync(tableName: string, changedIds: ReadonlySet<string>) {
			if (isDisposed) {
				return;
			}

			let tableIds = pendingSync.get(tableName);
			if (tableIds === undefined) {
				tableIds = new Set<string>();
				pendingSync.set(tableName, tableIds);
			}

			for (const id of changedIds) {
				tableIds.add(id);
			}

			if (syncTimeout !== null) {
				clearTimeout(syncTimeout);
			}

			syncTimeout = setTimeout(() => {
				syncTimeout = null;
				syncQueue = syncQueue
					.then(() => flushPendingSync())
					.catch((error: unknown) => {
						console.error(
							'[createSqliteMirror] Failed to sync SQLite mirror.',
							error,
						);
					});
			}, debounceMs);
		}

		async function flushPendingSync() {
			if (isDisposed) {
				return;
			}

			const currentPending = pendingSync;
			pendingSync = new Map<string, Set<string>>();

			const changes: SyncChange[] = [];

			for (const [tableName, ids] of currentPending) {
				const table = mirroredTables.get(tableName);
				if (table === undefined) {
					continue;
				}

				const upserted: string[] = [];
				const deleted: string[] = [];

				for (const id of ids) {
					const result = table.get(id);

					switch (result.status) {
						case 'valid': {
							await insertRow(tableName, result.row);
							upserted.push(id);
							break;
						}

						case 'invalid':
						case 'not_found': {
							await deleteRow(tableName, id);
							deleted.push(id);
							break;
						}
					}
				}

				if (upserted.length > 0 || deleted.length > 0) {
					changes.push({ table: tableName, upserted, deleted });
				}
			}

			if (onSync) {
				await onSync(db, changes);
			}
		}

		// ── Init helpers ─────────────────────────────────────────────

		function validateFtsConfig() {
			if (options.fts === undefined) {
				return;
			}

			for (const ftsTableName of Object.keys(options.fts)) {
				if (!mirroredTables.has(ftsTableName)) {
					console.warn(
						`[createSqliteMirror] FTS configured for "${ftsTableName}" but it is not in the mirrored table set. FTS index will not be created.`,
					);
				}
			}
		}

		async function setupFtsTables() {
			if (options.fts === undefined) {
				return;
			}

			for (const [tableName] of mirroredTables) {
				const columns = options.fts[tableName];
				if (columns === undefined || columns.length === 0) {
					continue;
				}

				const ftsTableName = `${tableName}_fts`;
				const quotedColumns = columns.map(quoteIdentifier).join(', ');
				const newValues = columns
					.map((column) => `new.${quoteIdentifier(column)}`)
					.join(', ');
				const oldValues = columns
					.map((column) => `old.${quoteIdentifier(column)}`)
					.join(', ');

				const qt = quoteIdentifier(tableName);
				const qfts = quoteIdentifier(ftsTableName);

				await db.exec(
					`CREATE VIRTUAL TABLE IF NOT EXISTS ${qfts}\n` +
						`USING fts5(${quotedColumns}, content=${quoteString(tableName)}, content_rowid=rowid)`,
				);

				await db.exec(
					`CREATE TRIGGER IF NOT EXISTS ${quoteIdentifier(`${tableName}_fts_ai`)}\n` +
						`AFTER INSERT ON ${qt} BEGIN\n` +
						`  INSERT INTO ${qfts}(rowid, ${quotedColumns})\n` +
						`  VALUES (new.rowid, ${newValues});\n` +
						`END`,
				);

				await db.exec(
					`CREATE TRIGGER IF NOT EXISTS ${quoteIdentifier(`${tableName}_fts_ad`)}\n` +
						`AFTER DELETE ON ${qt} BEGIN\n` +
						`  INSERT INTO ${qfts}(${qfts}, rowid, ${quotedColumns})\n` +
						`  VALUES('delete', old.rowid, ${oldValues});\n` +
						`END`,
				);

				await db.exec(
					`CREATE TRIGGER IF NOT EXISTS ${quoteIdentifier(`${tableName}_fts_au`)}\n` +
						`AFTER UPDATE ON ${qt} BEGIN\n` +
						`  INSERT INTO ${qfts}(${qfts}, rowid, ${quotedColumns})\n` +
						`  VALUES('delete', old.rowid, ${oldValues});\n` +
						`  INSERT INTO ${qfts}(rowid, ${quotedColumns})\n` +
						`  VALUES (new.rowid, ${newValues});\n` +
						`END`,
				);
			}
		}

		async function rebuildTables() {
			if (isDisposed) {
				return;
			}

			await db.exec('BEGIN');
			try {
				for (const [tableName] of mirroredTables) {
					await db.exec(`DELETE FROM ${quoteIdentifier(tableName)}`);
				}
				for (const [tableName, table] of mirroredTables) {
					await fullLoadTable(tableName, table);
				}
				await db.exec('COMMIT');
			} catch (error: unknown) {
				await db.exec('ROLLBACK');
				throw error;
			}
		}

		async function fullLoadTable(
			tableName: string,
			table: TableHelper<BaseRow>,
		) {
			const rows = table.getAllValid();
			if (rows.length === 0) {
				return;
			}

			// Prepare statement once from the first row's column shape, reuse for all rows.
			const keys = Object.keys(rows[0]!);
			const placeholders = keys.map(() => '?').join(', ');
			const columns = keys.map(quoteIdentifier).join(', ');
			const stmt = db.prepare(
				`INSERT OR REPLACE INTO ${quoteIdentifier(tableName)} (${columns}) VALUES (${placeholders})`,
			);

			for (const row of rows) {
				const values = keys.map((key) => serializeValue(row[key]));
				await stmt.run(...values);
			}
		}

		// ── SQL primitives ───────────────────────────────────────────

		async function insertRow(tableName: string, row: BaseRow) {
			const keys = Object.keys(row);
			const placeholders = keys.map(() => '?').join(', ');
			const values = keys.map((key) => serializeValue(row[key]));
			const columns = keys.map(quoteIdentifier).join(', ');

			await db
				.prepare(
					`INSERT OR REPLACE INTO ${quoteIdentifier(tableName)} (${columns}) VALUES (${placeholders})`,
				)
				.run(...values);
		}

		async function deleteRow(tableName: string, id: string) {
			await db
				.prepare(
					`DELETE FROM ${quoteIdentifier(tableName)} WHERE ${quoteIdentifier('id')} = ?`,
				)
				.run(id);
		}

		// ── Kick off and return ──────────────────────────────────────

		const whenReady = initialize();

		return {
			db,
			rebuild,
			rebuildTable,
			count,
			search,
			whenReady,
			dispose,
		};
	};
}

// ════════════════════════════════════════════════════════════════════════════
// MODULE-LEVEL HELPERS
// ════════════════════════════════════════════════════════════════════════════

function resolveMirroredTables(
	context: SqliteMirrorContext,
	tableNames: SqliteMirrorOptions['tables'],
): Map<string, TableHelper<BaseRow>> {
	const selectedTableNames =
		tableNames === undefined || tableNames === 'all'
			? Object.keys(context.tables)
			: [...new Set(tableNames)];

	const result = new Map<string, TableHelper<BaseRow>>();

	for (const tableName of selectedTableNames) {
		const table = context.tables[tableName];
		if (table === undefined) {
			throw new Error(
				`SQLite mirror table helper not found for "${tableName}".`,
			);
		}

		if (context.definitions.tables[tableName] === undefined) {
			throw new Error(
				`SQLite mirror table definition not found for "${tableName}".`,
			);
		}

		result.set(tableName, table);
	}

	return result;
}

function getTableJsonSchema(
	context: SqliteMirrorContext,
	tableName: string,
): Record<string, unknown> {
	const tableDef = context.definitions.tables[tableName];
	if (tableDef === null || tableDef === undefined) {
		throw new Error(`SQLite mirror definition for "${tableName}" is missing.`);
	}

	// Table definitions may wrap the schema in a { schema } property or be
	// the Standard Schema directly (e.g. an arktype Type which is callable).
	const schema =
		isRecord(tableDef) && 'schema' in tableDef ? tableDef.schema : tableDef;

	if (
		schema === null ||
		schema === undefined ||
		(typeof schema !== 'object' && typeof schema !== 'function') ||
		!('~standard' in schema)
	) {
		throw new Error(
			`SQLite mirror definition for "${tableName}" is not a Standard Schema (missing ~standard).`,
		);
	}

	return standardSchemaToJsonSchema(schema as StandardJSONSchemaV1);
}

function serializeValue(value: unknown): unknown {
	if (value === null || value === undefined) {
		return null;
	}

	if (typeof value === 'object') {
		return JSON.stringify(value);
	}

	if (typeof value === 'boolean') {
		return value ? 1 : 0;
	}

	return value;
}

function quoteString(value: string) {
	return `'${value.replaceAll("'", "''")}'`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
