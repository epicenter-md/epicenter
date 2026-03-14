/**
 * SQLite index extension for the Yjs filesystem.
 *
 * Mirrors the CRDT files table into an in-memory SQLite database
 * (libSQL WASM) wrapped with Drizzle ORM. Provides SQL queries,
 * full-text search, and fast lookups against file metadata and content.
 *
 * The SQLite database is **never** the source of truth—it's a derived,
 * rebuildable cache. On every page load the index is rebuilt from Yjs.
 * Ongoing mutations are picked up via a debounced table observer.
 *
 * Uses `@libsql/client-wasm` for browser WASM SQLite. To upgrade to
 * remote Turso, swap `url: ':memory:'` for `url: 'libsql://your-db.turso.io'`.
 *
 * @example
 * ```typescript
 * const ws = createWorkspace({ id: 'app', tables: { files: filesTable } })
 *   .withWorkspaceExtension('sqliteIndex', createSqliteIndex());
 *
 * await ws.whenReady;
 * const results = await ws.extensions.sqliteIndex.search('meeting notes');
 * ```
 *
 * @module
 */

import type { Documents, TableHelper } from '@epicenter/workspace';
import type { Client, InStatement } from '@libsql/client-wasm';
import { createClient } from '@libsql/client-wasm';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';

import type { FileRow } from '../../table.js';
import { generateDDL } from './ddl.js';
import * as schema from './schema.js';

const MAX_PATH_DEPTH = 50;

// ════════════════════════════════════════════════════════════════════════════
// PUBLIC TYPES
// ════════════════════════════════════════════════════════════════════════════

export type SqliteIndexOptions = {
	/** Debounce interval (ms) between table mutation and rebuild. @default 100 */
	debounceMs?: number;
};

/**
 * A single full-text search result.
 *
 * Returned by {@link SqliteIndex.search}. The `snippet` field contains
 * an HTML fragment with `<mark>` tags around matched terms.
 */
export type SearchResult = {
	/** File ID matching the query. */
	id: string;
	/** File name. */
	name: string;
	/** Materialized POSIX path, or null if the file is orphaned. */
	path: string | null;
	/** FTS5 snippet with `<mark>` highlights around matched terms. */
	snippet: string;
};

/** The public surface returned by the SQLite index extension. */
export type SqliteIndex = {
	/** Drizzle database instance for typed queries against the index. */
	readonly db: LibSQLDatabase<typeof schema>;
	/**
	 * Raw libSQL client for arbitrary SQL queries.
	 *
	 * Use this when you need to run user-authored SQL strings directly.
	 * The database is read-only in intent (writes are overwritten on rebuild).
	 *
	 * @example
	 * ```typescript
	 * const result = await ws.extensions.sqliteIndex.client.execute(
	 *   "SELECT name, path FROM files WHERE type = 'file' AND trashed_at IS NULL"
	 * );
	 * console.log(result.rows);
	 * ```
	 */
	readonly client: Client;
	/** Drizzle schema (re-exported for query building convenience). */
	readonly schema: typeof schema;
	/**
	 * Full-text search across file names and content.
	 *
	 * Uses SQLite FTS5 under the hood. Returns ranked results with
	 * highlighted snippets. Empty/whitespace queries return `[]`.
	 *
	 * @example
	 * ```typescript
	 * const hits = await ws.extensions.sqliteIndex.search('meeting notes');
	 * for (const hit of hits) {
	 *   console.log(hit.name, hit.path, hit.snippet);
	 * }
	 * ```
	 */
	search: (query: string) => Promise<SearchResult[]>;
	/**
	 * Manually nuke and rebuild the entire index from Yjs.
	 *
	 * Called automatically on init and after every debounced table mutation.
	 * Exposed for manual recovery (e.g. suspected corruption).
	 */
	rebuild: () => Promise<void>;
	/** Promise that resolves after the initial rebuild completes. */
	whenReady: Promise<void>;
	/** Tear down observers and close the SQLite database. */
	destroy: () => void;
};

// ════════════════════════════════════════════════════════════════════════════
// EXTENSION CONTEXT
// ════════════════════════════════════════════════════════════════════════════

/**
 * Minimal context shape this extension needs from the workspace.
 *
 * Structural subtyping means any workspace with a `files` table
 * (using `filesTable` from `@epicenter/filesystem`) satisfies this.
 */
type SqliteIndexContext = {
	tables: { files: TableHelper<FileRow> };
	documents: { files: { content: Documents<FileRow> } };
};

// ════════════════════════════════════════════════════════════════════════════
// FACTORY
// ════════════════════════════════════════════════════════════════════════════

/**
 * Create a SQLite index workspace extension.
 *
 * Returns a curried factory: call with options, then pass to
 * `.withWorkspaceExtension()`. The inner factory receives the
 * workspace context and returns the extension exports.
 *
 * @example
 * ```typescript
 * createWorkspace({ id: 'opensidian', tables: { files: filesTable } })
 *   .withExtension('persistence', indexeddbPersistence)
 *   .withWorkspaceExtension('sqliteIndex', createSqliteIndex());
 * ```
 */
export function createSqliteIndex(options: SqliteIndexOptions = {}) {
	const { debounceMs = 100 } = options;

	return (context: SqliteIndexContext): SqliteIndex => {
		const filesTable = context.tables.files;
		const contentDocs = context.documents.files.content;

		const client = createClient({ url: ':memory:' });
		let db: LibSQLDatabase<typeof schema>;
		let syncTimeout: ReturnType<typeof setTimeout> | null = null;
		let rebuilding = false;
		let unobserve: (() => void) | null = null;

		// ── Async initialization ──────────────────────────────────────
		const whenReady = (async () => {
			// WAL mode — no-op for in-memory but documents intent
			await client.execute('PRAGMA journal_mode = WAL');

			// Create files table + indexes from the Drizzle schema (single source of truth)
			for (const ddl of generateDDL(schema.files)) {
				await client.execute(ddl);
			}

			// FTS5 virtual table — standalone (not external-content)
			// Drizzle has no virtual table support, so this stays as raw SQL
			await client.execute(`
				CREATE VIRTUAL TABLE IF NOT EXISTS files_fts
				USING fts5(file_id UNINDEXED, name, content)
			`);

			db = drizzle(client, { schema });

			// Initial rebuild from Yjs
			await rebuild();

			// Observe ongoing table mutations
			unobserve = filesTable.observe(() => scheduleSync());
		})();

		// ── Debounced sync ────────────────────────────────────────────
		function scheduleSync() {
			if (syncTimeout) clearTimeout(syncTimeout);
			syncTimeout = setTimeout(() => {
				syncTimeout = null;
				void rebuild();
			}, debounceMs);
		}

		// ── Full rebuild ──────────────────────────────────────────────
		async function rebuild(): Promise<void> {
			if (rebuilding) return;
			rebuilding = true;

			try {
				const rows = filesTable.getAllValid();
				const paths = computePaths(rows);

				// Read content for files (skip folders)
				const contentMap = new Map<string, string | null>();
				for (const row of rows) {
					if (row.type === 'folder') {
						contentMap.set(row.id, null);
						continue;
					}
					try {
						const handle = await contentDocs.open(row.id);
						const text = handle.read();
						contentMap.set(row.id, text || null);
					} catch {
						contentMap.set(row.id, null);
					}
				}

				// Build batch: nuke + reinsert in a single transaction
				const statements: InStatement[] = [
					'DELETE FROM files_fts',
					'DELETE FROM files',
				];

				for (const row of rows) {
					const path = paths.get(row.id) ?? null;
					const content = contentMap.get(row.id) ?? null;

					statements.push({
						sql: `INSERT INTO files
							(id, name, parent_id, type, path, size, created_at, updated_at, trashed_at, content)
							VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
						args: [
							row.id,
							row.name,
							row.parentId,
							row.type,
							path,
							row.size,
							row.createdAt,
							row.updatedAt,
							row.trashedAt,
							content,
						],
					});

					// Insert into FTS — use empty string for null content
					// so the file name is still searchable
					statements.push({
						sql: 'INSERT INTO files_fts (file_id, name, content) VALUES (?, ?, ?)',
						args: [row.id, row.name, content ?? ''],
					});
				}

				// libSQL batch executes all statements in a single transaction
				await client.batch(statements, 'write');
			} finally {
				rebuilding = false;
			}
		}

		// ── Full-text search ──────────────────────────────────────────

		/**
		 * Search file names and content using FTS5 MATCH.
		 *
		 * Returns up to 50 results ranked by relevance, each with an
		 * HTML snippet (`<mark>` tags around matched terms).
		 */
		async function search(query: string): Promise<SearchResult[]> {
			const trimmed = query.trim();
			if (!trimmed) return [];

			try {
				// snippet() args: table, column-index, open, close, ellipsis, max-tokens
				const result = await client.execute({
					sql: `SELECT
						fts.file_id,
						f.name,
						f.path,
						snippet(files_fts, 2, '<mark>', '</mark>', '...', 64) AS snippet
					 FROM files_fts fts
					 JOIN files f ON f.id = fts.file_id
					 WHERE files_fts MATCH ?
					 ORDER BY rank
					 LIMIT 50`,
					args: [trimmed],
				});

				return result.rows.map((row) => ({
					id: row.file_id as string,
					name: row.name as string,
					path: (row.path as string) ?? null,
					snippet: row.snippet as string,
				}));
			} catch {
				// Invalid FTS5 query syntax — return empty rather than throw
				return [];
			}
		}

		// ── Extension exports ─────────────────────────────────────────
		return {
			get db() {
				return db;
			},
			get client() {
				return client;
			},
			schema,
			search,
			rebuild,
			whenReady,
			destroy() {
				if (syncTimeout) clearTimeout(syncTimeout);
				unobserve?.();
				client.close();
			},
		};
	};
}

// ════════════════════════════════════════════════════════════════════════════
// PATH COMPUTATION
// ════════════════════════════════════════════════════════════════════════════

/**
 * Compute materialized POSIX paths for all rows by walking parentId chains.
 *
 * Memoized per-call — each path is computed once and cached. Handles
 * cycles (via visited-set) and orphans (fallback to root `/name`).
 */
function computePaths(rows: FileRow[]): Map<string, string> {
	const rowById = new Map<string, FileRow>();
	for (const row of rows) rowById.set(row.id, row);

	const paths = new Map<string, string>();

	function getPath(id: string, visited: Set<string>): string | null {
		if (paths.has(id)) return paths.get(id)!;
		if (visited.has(id)) return null; // Cycle
		visited.add(id);

		const row = rowById.get(id);
		if (!row) return null;

		if (row.parentId === null) {
			const path = `/${row.name}`;
			paths.set(id, path);
			return path;
		}

		// Guard against unreasonably deep trees
		if (visited.size > MAX_PATH_DEPTH) return null;

		const parentPath = getPath(row.parentId, visited);
		if (parentPath === null) {
			// Orphan or cycle — treat as root-level
			const path = `/${row.name}`;
			paths.set(id, path);
			return path;
		}

		const path = `${parentPath}/${row.name}`;
		paths.set(id, path);
		return path;
	}

	for (const row of rows) {
		getPath(row.id, new Set());
	}

	return paths;
}
