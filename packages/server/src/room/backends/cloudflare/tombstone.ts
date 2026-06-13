/**
 * Per-room tombstone backed by a Cloudflare Durable Object's embedded SQLite.
 *
 * A Durable Object cannot be truly deleted: `deleteAll()` empties storage but
 * the same name keeps resolving to a live, empty object on the next request.
 * So "drop a room" structurally means *empty its update log and mark it
 * destroyed*, then refuse every future operation. This module owns that mark.
 *
 * Kept in a SEPARATE table from `updates` so the update log's `replaceAll`
 * (DELETE + INSERT) can never clobber the tombstone, and so the mark survives
 * the `DELETE FROM updates` that `Room.destroy()` runs in the same transaction.
 *
 * Reads are synchronous (`storage.sql`) on purpose: the Durable Object reads
 * `isDestroyed()` inside its constructor's await-free `blockConcurrencyWhile`
 * callback, which must stay synchronous to keep `core` definite-assigned.
 */

/**
 * Build a tombstone over a Durable Object's `storage` handle. Creates the
 * `room_tombstone` table if missing (idempotent, safe on every cold start).
 */
export function createDurableObjectTombstone(storage: DurableObjectStorage) {
	storage.sql.exec(`
		CREATE TABLE IF NOT EXISTS room_tombstone (
			id INTEGER PRIMARY KEY
		)
	`);

	return {
		/**
		 * Whether this room has been destroyed. Synchronous so the constructor
		 * can gate on it without awaiting.
		 */
		isDestroyed(): boolean {
			const { count } = storage.sql
				.exec('SELECT COUNT(*) as count FROM room_tombstone')
				.one();
			return (count as number) > 0;
		},

		/**
		 * Mark this room destroyed. Idempotent: a second mark is a no-op. Intended
		 * to run inside the same `transactionSync` that empties the update log.
		 */
		mark(): void {
			storage.sql.exec('INSERT OR IGNORE INTO room_tombstone (id) VALUES (1)');
		},
	};
}

export type DurableObjectTombstone = ReturnType<
	typeof createDurableObjectTombstone
>;
