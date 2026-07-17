import type { Database, SQLQueryBindings } from 'bun:sqlite';
import type { RowSyncSqlite, SqliteRow } from '../sqlite.js';

/** Adapt one caller-owned `bun:sqlite` database. */
export function createBunSqliteAdapter(database: Database): RowSyncSqlite {
	return {
		run(sql, parameters = []): void {
			database.run(sql, parameters as SQLQueryBindings[]);
		},
		all<TRow extends SqliteRow>(sql: string, parameters = []): TRow[] {
			return database
				.query<TRow, SQLQueryBindings[]>(sql)
				.all(...(parameters as SQLQueryBindings[]));
		},
		transaction<TResult>(run: () => TResult): TResult {
			return database.transaction(run).immediate();
		},
	};
}
