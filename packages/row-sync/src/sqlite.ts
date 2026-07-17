/**
 * Values shared by SQLite bindings in browsers, Bun, and Durable Objects.
 * BLOB values bind as `Uint8Array`; the authority itself stores no blobs, but
 * the replica schema (ADR-0134) does, and both share these adapters. Durable
 * Object reads surface blobs as `ArrayBuffer`, which no authority query does.
 */
export type SqliteValue = string | number | null | Uint8Array;

/** SQLite result rows may surface BLOBs as either view or backing buffer. */
export type SqliteRow = Record<string, SqliteValue | ArrayBuffer>;

/**
 * The complete runtime-specific boundary consumed by the row authority.
 *
 * Transactions are synchronous because every supported embedded SQLite engine
 * provides a synchronous transaction callback. Network and hashing work stays
 * outside this boundary.
 */
export type RowSyncSqlite = {
	run(sql: string, parameters?: readonly SqliteValue[]): void;
	all<TRow extends SqliteRow>(
		sql: string,
		parameters?: readonly SqliteValue[],
	): TRow[];
	transaction<TResult>(run: () => TResult): TResult;
};
