/**
 * `attachBunSqliteMaterializer(workspace, { filePath })`: bun:sqlite-backed
 * materializer. Owns the database file end-to-end: opens it (with the
 * writer-side WAL pragmas), mirrors every table in `workspace.tables` into
 * it, and closes the handle when the workspace's ydoc is destroyed.
 *
 * Daemon-side. Browser and Tauri SQLite writers are intentionally not part of
 * this public surface; add a new materializer only when a real runtime caller
 * earns that product path.
 *
 *
 * @example
 * ```ts
 * const materializer = attachBunSqliteMaterializer(workspace, {
 *   filePath: sqlitePath(projectDir, workspace.ydoc.guid),
 *   waitFor: idb.whenLoaded,
 *   fts: { entries: ['title', 'body'] },
 * });
 *
 * // Daemon-local reads against the same file (raw SQL):
 * const rows = materializer.client.query('SELECT * FROM entries').all();
 * ```
 *
 * @module
 */

import { createLogger, type Logger } from 'wellcrafted/logger';
import type * as Y from 'yjs';
import { openWriterSqlite } from '../../sqlite-writer.js';
import type { TablesRecord } from '../shared.js';
import { attachSqliteMaterializerCore, type FtsConfig } from './core.js';

/**
 * Options for {@link attachBunSqliteMaterializer}.
 */
export type AttachBunSqliteMaterializerOptions<
	TTables extends TablesRecord,
	TFts extends FtsConfig<TTables> | undefined = undefined,
> = {
	/**
	 * Absolute path to the bun:sqlite mirror file, or `':memory:'` for an
	 * ephemeral in-memory mirror. The parent directory is created on demand
	 * (no-op for `:memory:`).
	 */
	filePath: ':memory:' | (string & {});

	/**
	 * Optional FTS5 configuration. Keys must match `workspace.tables` keys; values
	 * list the columns of that table's row to include in the FTS index.
	 * When provided, the result exposes `sqlite.actions.sqlite_search(...)`; when
	 * omitted, `sqlite.actions` only contains `sqlite_rebuild`.
	 */
	fts?: TFts;

	/**
	 * Debounce window for the materializer's incremental row flush. Defaults
	 * to 100 ms. Set to 0 in tests where each `set()` should flush on the
	 * next microtask.
	 */
	debounceMs?: number;

	/**
	 * Gate: the materializer awaits this before the initial DDL + full-load.
	 * Matches the `waitFor` convention used by `openCollaboration`. Omit for
	 * no gate.
	 */
	waitFor?: Promise<unknown>;

	/**
	 * Logger for background failures (debounced sync flush, FTS query, WAL
	 * pragma fallbacks). Defaults to a console-backed logger with source
	 * `attachBunSqliteMaterializer`.
	 */
	log?: Logger;
};

/**
 * Attach a bun:sqlite-backed materializer to a Y.Doc. The materializer
 * opens the file at `filePath`, applies the writer-side WAL pragmas, and
 * closes the handle on `ydoc.destroy()`.
 *
 * The returned object exposes the underlying `Database` as `.client`, so
 * callers can run raw SQL (`materializer.client.query(...)`) against the same
 * file.
 */
export function attachBunSqliteMaterializer<
	TTables extends TablesRecord,
	TFts extends FtsConfig<TTables> | undefined = undefined,
>(
	workspace: { ydoc: Y.Doc; tables: TTables },
	{
		filePath,
		fts,
		debounceMs,
		waitFor,
		log = createLogger('attachBunSqliteMaterializer'),
	}: AttachBunSqliteMaterializerOptions<TTables, TFts>,
) {
	const { ydoc, tables } = workspace;
	const client = openWriterSqlite({ filePath, log });

	const core = attachSqliteMaterializerCore<TTables, TFts>(ydoc, {
		db: client,
		tables,
		fts,
		debounceMs,
		waitFor,
		log,
	});

	return { ...core, client };
}
