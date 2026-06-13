/**
 * `RoomUpdateLog` backed by a Cloudflare Durable Object's embedded
 * SQLite (`ctx.storage`).
 *
 * Owns: the `updates` table DDL, every read and write against it, and
 * the `replaceAll` atomicity via `storage.transactionSync`. Does not
 * know about `Y.Doc`; it stores opaque blobs.
 *
 * Construction is synchronous and idempotent (`CREATE TABLE IF NOT
 * EXISTS`), safe to run on every DO cold start.
 */

import type { RoomUpdateLog } from '../../contracts';

/**
 * Build a {@link RoomUpdateLog} over a Durable Object's `storage` handle.
 *
 * The factory creates the `updates` table if missing, then returns the
 * read/write surface that {@link createRoomCore} consumes.
 *
 * @param storage - The DO's `ctx.storage`. Both `storage.sql` (for the
 *   queries) and `storage.transactionSync` (for the `replaceAll` atomic
 *   swap) are used.
 */
export function createDurableObjectUpdateLog(storage: DurableObjectStorage) {
	storage.sql.exec(`
		CREATE TABLE IF NOT EXISTS updates (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			data BLOB NOT NULL
		)
	`);

	return {
		/**
		 * Read every update row in insertion order. Called once at room
		 * load to replay history into the `Y.Doc`.
		 */
		loadAll(): Uint8Array[] {
			return storage.sql
				.exec('SELECT data FROM updates ORDER BY id')
				.toArray()
				.map((row) => new Uint8Array(row.data as ArrayBuffer));
		},

		/**
		 * Append one Yjs update. Synchronous because the Yjs `updateV2`
		 * listener that calls this cannot await.
		 */
		append(update: Uint8Array): void {
			storage.sql.exec('INSERT INTO updates (data) VALUES (?)', update);
		},

		/**
		 * Empty the log without compacting. Transaction-free (like `append`) so a
		 * caller that owns a wider transaction (room destruction, which must empty
		 * the log and write the tombstone atomically) can compose it. The `updates`
		 * table name lives here, not at the call site.
		 */
		clear(): void {
			storage.sql.exec('DELETE FROM updates');
		},

		/**
		 * Replace the entire log with one compacted blob. Wrapped in
		 * `storage.transactionSync` so the DELETE + INSERT is one atomic
		 * unit with respect to readers.
		 */
		replaceAll(compacted: Uint8Array): void {
			storage.transactionSync(() => {
				storage.sql.exec('DELETE FROM updates');
				storage.sql.exec('INSERT INTO updates (data) VALUES (?)', compacted);
			});
		},

		/** SQLite database size in bytes, surfaced as `storageBytes` to callers. */
		byteSize(): number {
			return storage.sql.databaseSize;
		},

		/** Row count via `SELECT COUNT(*)`. Used to skip no-op compactions. */
		entryCount(): number {
			return storage.sql.exec('SELECT COUNT(*) as count FROM updates').one()
				.count as number;
		},
	} satisfies RoomUpdateLog;
}
