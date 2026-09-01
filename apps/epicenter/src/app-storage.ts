/** Bun-owned application SQLite files. The application never receives this owner. */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { appDataDir, isAppId } from '@epicenter/constants/app-data';
import type { AppSqliteDatabase } from '@epicenter/app';
import type { SqliteValue } from '@epicenter/sqlite';

export type BunAppStorage = {
	open(appId: string, name: string): Promise<AppSqliteDatabase>;
};

/** Open and retain one owner-local handle per scoped application database. */
export function createBunAppStorage(root: string): BunAppStorage {
	const opened = new Map<string, Promise<AppSqliteDatabase>>();
	return {
		open(appId, name) {
			if (!isAppId(appId)) throw new Error('Invalid application id.');
			const key = `${appId}/${name}`;
			const existing = opened.get(key);
			if (existing !== undefined) return existing;
			const opening = (async () => {
				const directory = join(appDataDir(root, appId), 'sqlite');
				await mkdir(directory, { recursive: true });
				const database = new Database(join(directory, `${name}.sqlite`), {
					create: true,
				});
				database.run('PRAGMA busy_timeout = 5000');
				return createAsyncHandle(database);
			})();
			opened.set(key, opening);
			return opening;
		},
	};
}

function createAsyncHandle(database: Database): AppSqliteDatabase {
	let queue = Promise.resolve();
	const serialize = <T>(operation: () => T): Promise<T> => {
		const next = queue.then(operation, operation);
		queue = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	};

	return {
		run: (sql, parameters) =>
			resultOf(
				serialize(() => {
					const result = database
						.query(sql)
						.run(...toBindings(parameters));
					return { changes: result.changes };
				}),
			),
		all: <TRow>(sql: string, parameters?: readonly SqliteValue[]) =>
			resultOf(
				serialize(() =>
					database
						.query<TRow, SQLQueryBindings[]>(sql)
						.all(...toBindings(parameters)),
				),
			),
		batch: (statements) =>
			resultOf(
				serialize(() =>
					database.transaction(() => {
						const changes: number[] = [];
						for (const statement of statements) {
							const result = database
								.query(statement.sql)
								.run(...toBindings(statement.parameters));
							changes.push(result.changes);
						}
						return { changes };
					})(),
				),
			),
	};
}

function toBindings(
	parameters: readonly SqliteValue[] | undefined,
): SQLQueryBindings[] {
	return [...(parameters ?? [])] as SQLQueryBindings[];
}

function resultOf<T>(promise: Promise<T>): Promise<import('wellcrafted/result').Result<T, import('@epicenter/app').AppError>> {
	return promise.then(
		(data) => ({ data, error: null }),
		(cause) => import('@epicenter/app').then(({ AppError }) => AppError.StorageFailed({ cause })),
	);
}
