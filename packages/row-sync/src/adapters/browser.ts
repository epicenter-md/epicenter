import type { RowSyncSqlite, SqliteRow, SqliteValue } from '../sqlite.js';

export type BrowserSqliteDatabase = {
	exec(options: {
		sql: string;
		bind?: readonly SqliteValue[];
		rowMode?: 'object';
		resultRows?: unknown[];
	}): unknown;
	transaction<TResult>(
		beginQualifier: 'IMMEDIATE',
		run: () => TResult,
	): TResult;
};

/** Adapt sqlite.org's OO1 browser API without importing a WASM implementation. */
export function createBrowserSqliteAdapter(
	database: BrowserSqliteDatabase,
): RowSyncSqlite {
	return {
		run(sql, parameters = []): void {
			database.exec({ sql, bind: parameters });
		},
		all<TRow extends SqliteRow>(sql: string, parameters = []): TRow[] {
			const resultRows: unknown[] = [];
			database.exec({
				sql,
				bind: parameters,
				rowMode: 'object',
				resultRows,
			});
			return resultRows as TRow[];
		},
		transaction<TResult>(run: () => TResult): TResult {
			return database.transaction('IMMEDIATE', run);
		},
	};
}
