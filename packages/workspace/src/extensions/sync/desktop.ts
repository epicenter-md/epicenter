import { Database } from 'bun:sqlite';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import * as Y from 'yjs';
import type { Lifecycle } from '../../workspace/lifecycle';

/**
 * Configuration for the persistence extension.
 */
export type PersistenceConfig = {
	/** Absolute path to the SQLite database file for storing YJS state. */
	filePath: string;
};

/** Max compacted update size (2 MB). Matches the Cloudflare DO limit. */
const MAX_COMPACTED_BYTES = 2 * 1024 * 1024;

/**
 * Compact the SQLite update log into a single row.
 *
 * Encodes the current doc state via `Y.encodeStateAsUpdateV2` — produces
 * smaller output than merging individual updates. No-ops if the log already
 * has ≤ 1 row or the compacted blob exceeds 2 MB.
 */
function compactUpdateLog(db: Database, ydoc: Y.Doc): void {
	const row = db.query('SELECT COUNT(*) as count FROM updates').get() as {
		count: number;
	};
	if (row.count <= 1) return;

	const compacted = Y.encodeStateAsUpdateV2(ydoc);
	if (compacted.byteLength > MAX_COMPACTED_BYTES) return;

	db.transaction(() => {
		db.run('DELETE FROM updates');
		db.run('INSERT INTO updates (data) VALUES (?)', [compacted]);
	})();
}

/**
 * Initialize a SQLite persistence database: create table, replay updates, compact.
 *
 * Shared setup logic used by both `persistence` and `filesystemPersistence`.
 */
function initPersistenceDb(filePath: string, ydoc: Y.Doc): Database {
	const db = new Database(filePath);
	db.run(
		'CREATE TABLE IF NOT EXISTS updates (id INTEGER PRIMARY KEY AUTOINCREMENT, data BLOB NOT NULL)',
	);

	// Replay update log to reconstruct Y.Doc state
	const rows = db.query('SELECT data FROM updates ORDER BY id').all() as {
		data: Buffer;
	}[];
	for (const row of rows) {
		Y.applyUpdateV2(ydoc, new Uint8Array(row.data));
	}

	// Compact on startup if the log has accumulated many rows
	compactUpdateLog(db, ydoc);

	return db;
}

/**
 * YJS document persistence extension using SQLite append-log.
 *
 * Stores incremental Y.Doc updates in a SQLite database using the same
 * append-only update log pattern as the Cloudflare Durable Object sync server.
 * Each update is a tiny INSERT (O(update_size)), not a full doc re-encode.
 *
 * **Platform**: Desktop (Tauri, Bun)
 *
 * **How it works**:
 * 1. Creates parent directory if it doesn't exist
 * 2. Opens/creates a SQLite database at the specified filePath
 * 3. Replays stored updates to reconstruct Y.Doc state
 * 4. Compacts the log on startup (many rows → 1 row)
 * 5. Appends each incremental update as a new row
 * 6. Compacts again on destroy (clean shutdown)
 *
 * @example
 * ```typescript
 * import { createWorkspace } from '@epicenter/workspace';
 * import { persistence } from '@epicenter/workspace/extensions/sync/desktop';
 * import { join } from 'node:path';
 *
 * const projectDir = '/my/project';
 * const epicenterDir = join(projectDir, '.epicenter');
 *
 * const workspace = createWorkspace({ id: 'blog', tables: {...} })
 *   .withWorkspaceExtension('persistence', (ctx) => persistence(ctx, {
 *     filePath: join(epicenterDir, 'persistence', `${ctx.id}.db`),
 *   }));
 * ```
 */
export const persistence = (
	{ ydoc }: { ydoc: Y.Doc },
	{ filePath }: PersistenceConfig,
) => {
	let db: Database | null = null;

	const updateHandler = (update: Uint8Array) => {
		db?.run('INSERT INTO updates (data) VALUES (?)', [update]);
	};

	const whenReady = (async () => {
		await mkdir(path.dirname(filePath), { recursive: true });
		db = initPersistenceDb(filePath, ydoc);

		// Persist incremental updates — tiny INSERTs, not full doc re-encodes
		ydoc.on('updateV2', updateHandler);
	})();

	return {
		whenReady,
		destroy() {
			ydoc.off('updateV2', updateHandler);
			if (db) {
				compactUpdateLog(db, ydoc);
				db.close();
			}
		},
	};
};

/**
 * Filesystem persistence factory that returns a `Lifecycle`.
 *
 * Uses SQLite append-log for efficient incremental persistence.
 * Same pattern as the Cloudflare DO sync server.
 *
 * @example
 * ```typescript
 * import { filesystemPersistence } from '@epicenter/workspace/extensions/sync/desktop';
 * import { createSyncExtension } from '@epicenter/workspace/extensions/sync';
 *
 * createWorkspace(definition)
 *   .withExtension('persistence', filesystemPersistence({
 *     filePath: join(epicenterDir, 'persistence', `workspace.db`),
 *   }))
 *   .withWorkspaceExtension('sync', createSyncExtension({
 *     url: 'ws://localhost:3913/rooms/{id}',
 *   }))
 * ```
 */
export function filesystemPersistence({
	filePath,
}: {
	filePath: string;
}): (context: { ydoc: Y.Doc }) => Lifecycle {
	return ({ ydoc }): Lifecycle => {
		let db: Database | null = null;

		const updateHandler = (update: Uint8Array) => {
			db?.run('INSERT INTO updates (data) VALUES (?)', [update]);
		};

		const whenReady = (async () => {
			await mkdir(path.dirname(filePath), { recursive: true });
			db = initPersistenceDb(filePath, ydoc);
			ydoc.on('updateV2', updateHandler);
		})();

		return {
			whenReady,
			destroy: () => {
				ydoc.off('updateV2', updateHandler);
				if (db) {
					compactUpdateLog(db, ydoc);
					db.close();
				}
			},
		};
	};
}
