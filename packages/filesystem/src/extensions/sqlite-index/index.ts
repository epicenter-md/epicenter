/**
 * SQLite index extension for the Yjs filesystem.
 *
 * Mirrors the CRDT files table into an in-memory SQLite database
 * (libSQL WASM). Provides SQL queries, full-text search, and fast
 * lookups against file metadata and content.
 *
 * The SQLite database is **never** the source of truth: it is a derived,
 * rebuildable cache. On every page load the index is rebuilt from Yjs.
 * Ongoing mutations are picked up via a debounced table observer.
 *
 * Uses `@libsql/client-wasm` for browser WASM SQLite. To upgrade to
 * remote Turso, swap `url: ':memory:'` for `url: 'libsql://your-db.turso.io'`.
 *
 * @example
 * ```typescript
 * const ydoc = new Y.Doc({ guid: 'app' });
 * const tables = attachTables(ydoc, { files: filesTable });
 * const sqliteIndex = createSqliteIndex({
 *   readContent: fileContent.read,
 * })({ tables });
 * await sqliteIndex.exports.whenReady;
 * const results = await sqliteIndex.exports.search('meeting notes');
 * ```
 *
 * @module
 */

import type { Table } from '@epicenter/workspace';
import type { Client, InStatement } from '@libsql/client-wasm';
import { createClient } from '@libsql/client-wasm';

import type { FileId } from '../../ids.js';
import type { FileRow } from '../../table.js';

const MAX_PATH_DEPTH = 50;

const FILES_DDL = `CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id TEXT,
  type TEXT NOT NULL,
  path TEXT,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  trashed_at INTEGER,
  content TEXT
)`;

const FILES_INDEXES = [
	'CREATE INDEX IF NOT EXISTS parent_idx ON files(parent_id)',
	'CREATE INDEX IF NOT EXISTS type_idx ON files(type)',
	'CREATE INDEX IF NOT EXISTS path_idx ON files(path)',
	'CREATE INDEX IF NOT EXISTS updated_idx ON files(updated_at)',
];

const FILES_FTS = `CREATE VIRTUAL TABLE IF NOT EXISTS files_fts
  USING fts5(file_id UNINDEXED, name, content)`;

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

/** Public exports surfaced on the document bundle's `sqliteIndex.exports`. */
export type SqliteIndexExports = {
	/** Raw libSQL client for arbitrary SQL queries. */
	readonly client: Client;
	/** Full-text search across file names and content. */
	search: (query: string) => Promise<SearchResult[]>;
	/** Manually rebuild the entire index from Yjs. */
	rebuild: () => Promise<void>;
	/** Resolves after the initial rebuild completes. */
	whenReady: Promise<void>;
};

/** The raw extension factory return: exports plus lifecycle metadata. */
export type SqliteIndex = {
	exports: SqliteIndexExports;
	/** Readiness signal (same promise as `exports.whenReady`). */
	init: Promise<void>;
	/** Dispose observers and close the SQLite database. */
	dispose: () => void;
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
	tables: {
		files: Table<FileRow>;
	};
};

// ════════════════════════════════════════════════════════════════════════════
// FACTORY
// ════════════════════════════════════════════════════════════════════════════

/**
 * Create a SQLite index. Returns a curried factory: call with options, then
 * invoke the inner function with `{ tables }` to wire it into the workspace.
 *
 * @example
 * ```typescript
 * const ydoc = new Y.Doc({ guid: 'app' });
 * const tables = attachTables(ydoc, { files: filesTable });
 * attachIndexedDb(ydoc);
 * const sqliteIndex = createSqliteIndex({ readContent })({ tables });
 * ```
 */
export function createSqliteIndex(
	{
		readContent,
	}: {
		readContent(fileId: FileId): Promise<string>;
	},
	{ debounceMs = 100 }: SqliteIndexOptions = {},
) {
	return (context: SqliteIndexContext): SqliteIndex => {
		const filesTable = context.tables.files;

		const client = createClient({ url: ':memory:' });
		let syncTimeout: ReturnType<typeof setTimeout> | null = null;
		let pendingIds = new Set<string>();
		let unobserve: (() => void) | null = null;

		// ── Async initialization ──────────────────────────────────────
		const whenReady = (async () => {
			// WAL mode: no-op for in-memory but documents intent
			await client.execute('PRAGMA journal_mode = WAL');

			await client.execute(FILES_DDL);
			for (const idx of FILES_INDEXES) {
				await client.execute(idx);
			}

			// FTS5 virtual table: standalone (not external-content)
			await client.execute(FILES_FTS);

			// Initial rebuild from Yjs
			await rebuild();

			// Observe ongoing table mutations
			unobserve = filesTable.observe((changedIds) => scheduleSync(changedIds));
		})();

		// ── Debounced sync ────────────────────────────────────────────
		function scheduleSync(changedIds: ReadonlySet<string>) {
			for (const id of changedIds) pendingIds.add(id);
			if (syncTimeout) clearTimeout(syncTimeout);
			syncTimeout = setTimeout(() => {
				syncTimeout = null;
				const ids = pendingIds;
				pendingIds = new Set();
				void syncRows(ids);
			}, debounceMs);
		}

		// ── Full rebuild ──────────────────────────────────────────
		async function rebuild(): Promise<void> {
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
					const text = await readContent(row.id);
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

				// Insert into FTS: use empty string for null content
				// so the file name is still searchable
				statements.push({
					sql: 'INSERT INTO files_fts (file_id, name, content) VALUES (?, ?, ?)',
					args: [row.id, row.name, content ?? ''],
				});
			}

			// libSQL batch executes all statements in a single transaction
			await client.batch(statements, 'write');
		}

		// ── Surgical sync ────────────────────────────────────────

		async function syncRows(changedIds: Set<string>): Promise<void> {
			const statements: InStatement[] = [];

			// Classify changed rows
			const folderIds: string[] = [];
			const fileIds: string[] = [];
			const deletedIds: string[] = [];

			for (const id of changedIds) {
				const { data: row, error } = filesTable.get(id);
				if (error || row === null) {
					deletedIds.push(id);
				} else if (row.type === 'folder') {
					folderIds.push(id);
				} else {
					fileIds.push(id);
				}
			}

			// Process deletes
			for (const id of deletedIds) {
				statements.push({
					sql: 'DELETE FROM files_fts WHERE file_id = ?',
					args: [id],
				});
				statements.push({
					sql: 'DELETE FROM files WHERE id = ?',
					args: [id],
				});
			}

			// Process folders first (path cascading must precede file processing)
			for (const id of folderIds) {
				const { data: row, error } = filesTable.get(id);
				if (error || row === null) continue;
				const path = computePathForRow(id, filesTable);

				// Query current path from SQLite before mutation
				const oldResult = await client.execute({
					sql: 'SELECT path FROM files WHERE id = ?',
					args: [id],
				});
				const oldPath = oldResult.rows[0]?.path as string | null | undefined;

				// DELETE + INSERT the folder
				statements.push({
					sql: 'DELETE FROM files_fts WHERE file_id = ?',
					args: [id],
				});
				statements.push({
					sql: 'DELETE FROM files WHERE id = ?',
					args: [id],
				});
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
						null,
					],
				});
				statements.push({
					sql: 'INSERT INTO files_fts (file_id, name, content) VALUES (?, ?, ?)',
					args: [row.id, row.name, ''],
				});

				// Cascade: if folder path changed, update all descendant paths
				if (oldPath != null && path != null && oldPath !== path) {
					const descendants = await client.execute({
						sql: "SELECT id, path FROM files WHERE path LIKE ? || '/%'",
						args: [oldPath],
					});

					for (const desc of descendants.rows) {
						const descId = desc.id as string;
						const descOldPath = desc.path as string;
						const descNewPath = path + descOldPath.slice(oldPath.length);
						statements.push({
							sql: 'UPDATE files SET path = ? WHERE id = ?',
							args: [descNewPath, descId],
						});
					}
				}
			}

			// Process files
			for (const id of fileIds) {
				const { data: row, error } = filesTable.get(id);
				if (error || row === null) continue;
				const path = computePathForRow(id, filesTable);

				let fileContent: string | null = null;
				try {
					const text = await readContent(row.id);
					fileContent = text || null;
				} catch {
					fileContent = null;
				}

				statements.push({
					sql: 'DELETE FROM files_fts WHERE file_id = ?',
					args: [id],
				});
				statements.push({
					sql: 'DELETE FROM files WHERE id = ?',
					args: [id],
				});
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
						fileContent,
					],
				});
				statements.push({
					sql: 'INSERT INTO files_fts (file_id, name, content) VALUES (?, ?, ?)',
					args: [row.id, row.name, fileContent ?? ''],
				});
			}

			if (statements.length > 0) {
				await client.batch(statements, 'write');
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
				// Invalid FTS5 query syntax: return empty rather than throw
				return [];
			}
		}

		// ── Extension exports ─────────────────────────────────────────
		return {
			exports: {
				client,
				search,
				rebuild,
				whenReady,
			},
			init: whenReady,
			dispose() {
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
 * Memoized per-call: each path is computed once and cached. Handles
 * cycles (via visited-set) and orphans (fallback to root `/name`).
 */
function computePaths(rows: FileRow[]): Map<string, string> {
	const rowById = new Map<string, FileRow>();
	for (const row of rows) rowById.set(row.id, row);

	const paths = new Map<string, string>();

	function getPath(id: string, visited: Set<string>): string | null {
		const cachedPath = paths.get(id);
		if (cachedPath !== undefined) return cachedPath;
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
			// Orphan or cycle: treat as root-level
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

/**
 * Compute a materialized POSIX path for a single row by walking its parentId chain.
 *
 * Uses `filesTable.get()` for each hop instead of bulk reads. Returns `null`
 * only when the target row itself doesn't exist. Cycles and orphans fall back
 * to root-level `/{name}`, matching the behavior of {@link computePaths}.
 */
function computePathForRow(
	id: string,
	filesTable: Table<FileRow>,
): string | null {
	const visited = new Set<string>();

	function walk(currentId: string): string | null {
		if (visited.has(currentId)) return null;
		visited.add(currentId);

		const { data: row, error } = filesTable.get(currentId);
		if (error || row === null) return null;

		if (row.parentId === null) {
			return `/${row.name}`;
		}

		// Guard against unreasonably deep trees
		if (visited.size > MAX_PATH_DEPTH) return null;

		const parentPath = walk(row.parentId);
		if (parentPath === null) {
			// Orphan or cycle: treat as root-level
			return `/${row.name}`;
		}

		return `${parentPath}/${row.name}`;
	}

	return walk(id);
}
