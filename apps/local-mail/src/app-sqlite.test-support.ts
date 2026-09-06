/**
 * An `AppSqliteDatabase` over an in-memory Bun database, for tests.
 *
 * Not a second owner. The real owners are the host's Bun files and the
 * browser's OPFS database, both behind `appStorage.sqlite.open`; this exists so a
 * test can exercise the statements Local Mail actually sends without standing up
 * a desktop host. It reproduces the contract that matters here: asynchronous,
 * no transaction callback, and `batch` is all or nothing.
 */

import { Database, type SQLQueryBindings } from 'bun:sqlite';
import type { AppSqliteDatabase } from '@epicenter/app-storage';

export function createTestAppSqlite(): AppSqliteDatabase & {
	close(): void;
} {
	const database = new Database(':memory:');
	const bind = (parameters: readonly unknown[] | undefined) =>
		[...(parameters ?? [])] as SQLQueryBindings[];
	const ok = <T>(data: T) => ({ data, error: null }) as never;
	const failed = (cause: unknown) =>
		({
			data: null,
			error: {
				name: 'StorageFailed',
				message: 'The application storage owner failed.',
				cause,
			},
		}) as never;

	return {
		async run(sql, parameters) {
			try {
				const result = database.query(sql).run(...bind(parameters));
				return ok({ changes: result.changes });
			} catch (cause) {
				return failed(cause);
			}
		},
		async all(sql, parameters) {
			try {
				return ok(database.query(sql).all(...bind(parameters)));
			} catch (cause) {
				return failed(cause);
			}
		},
		async batch(statements) {
			try {
				return ok(
					database.transaction(() => {
						const changes: number[] = [];
						for (const statement of statements) {
							changes.push(
								database.query(statement.sql).run(...bind(statement.parameters))
									.changes,
							);
						}
						return { changes };
					})(),
				);
			} catch (cause) {
				return failed(cause);
			}
		},
		close: () => database.close(),
	};
}
