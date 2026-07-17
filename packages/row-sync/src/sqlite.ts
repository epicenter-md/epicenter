/** Values shared by SQLite bindings in browsers, Bun, and Durable Objects. */
export type SqliteValue = string | number | null;

export type SqliteRow = Record<string, SqliteValue>;

/**
 * The complete runtime-specific boundary consumed by the record authority.
 *
 * Transactions are synchronous because every supported embedded SQLite engine
 * provides a synchronous transaction callback. Network and hashing work stays
 * outside this boundary.
 */
export type RecordSyncSqlite = {
	run(sql: string, parameters?: readonly SqliteValue[]): void;
	all<TRow extends SqliteRow>(
		sql: string,
		parameters?: readonly SqliteValue[],
	): TRow[];
	transaction<TResult>(run: () => TResult): TResult;
};
