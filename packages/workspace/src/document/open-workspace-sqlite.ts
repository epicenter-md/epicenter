/**
 * Convenience reader for the daemon's SQLite materializer.
 *
 * The daemon's `attachBunSqliteMaterializer` can write a queryable mirror at
 * `sqlitePath(projectDir, workspaceId)`. This helper only opens that convention
 * path. A caller that passed a custom `filePath` to the materializer needs
 * `openSqliteReader({ filePath })` with the same explicit path.
 *
 * For ranked FTS5 search plus snippet helpers, use `openSqliteReader`
 * instead; this function intentionally returns a bare `bun:sqlite`
 * `Database` so callers can `db.query(...).all(...)` without extra
 * ceremony.
 */

import type { Database } from 'bun:sqlite';
import type { ProjectDir } from '../shared/types.js';
import { openReadonlySqlite } from './open-sqlite-reader.js';
import { sqlitePath } from './workspace-paths.js';

/**
 * Open the daemon's convention-path SQLite mirror for a workspace read-only.
 *
 * The returned handle is read-only and has `query_only` enabled so any
 * accidental write fails at the driver. The caller closes the database with
 * `db.close()` when done.
 *
 * Throws if no file exists at `sqlitePath(projectDir, workspaceId)`. That
 * usually means the daemon has not yet written its first materializer snapshot
 * for this workspace, or the mount wrote SQLite to an override path.
 *
 * @example
 * ```ts
 * import { findProjectRoot, openWorkspaceSqlite } from '@epicenter/workspace/node';
 *
 * const db = openWorkspaceSqlite(findProjectRoot(), 'epicenter-notes');
 * const welcome = db.query('SELECT * FROM notes WHERE title = ?').all('Welcome');
 * db.close();
 * ```
 *
 * For the Fuji example project, use `openSqliteReader({ filePath:
 * join(projectDir, ".epicenter/sqlite.db") })` because its mount overrides the
 * convention path.
 */
export function openWorkspaceSqlite(
	projectDir: ProjectDir,
	workspaceId: string,
): Database {
	return openReadonlySqlite(sqlitePath(projectDir, workspaceId));
}
