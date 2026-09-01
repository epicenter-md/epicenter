/// <reference lib="dom" />

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import type { SqliteValue } from '@epicenter/sqlite';
import { AppError, type AppSqliteDatabase } from './index.js';

type PreparedStatement = {
	bind(parameters: readonly SqliteValue[]): PreparedStatement;
	step(): boolean;
	get(row: Record<string, unknown>): Record<string, unknown>;
	finalize(): unknown;
};

type Database = {
	prepare(sql: string): PreparedStatement;
	exec(sql: string): unknown;
	changes(): number | bigint;
};

type SqliteModule = {
	oo1: {
		OpfsDb?: new (filename: string) => Database;
	};
};

const databases = new Map<string, Promise<AppSqliteDatabase>>();

/** Open one persistent SQLite database in this origin's OPFS. */
export function createBrowserSqliteFactory(): (
	appId: string,
	name: string,
) => Promise<AppSqliteDatabase> {
	return async (appId, name) => {
		const key = `${appId}/${name}`;
		let opened = databases.get(key);
		if (opened === undefined) {
			opened = openOpfsDatabase(databaseFilename(appId, name)).then(
				(database) => createAsyncDatabase(database),
			);
			// A rejected open holds no database, so forgetting it is safe, and
			// keeping it would answer every later open with a failure that has
			// already passed. Pinned in the Bun leaf, which holds the same rule
			// and can be driven from a test; OPFS cannot be opened in one.
			opened.catch(() => databases.delete(key));
			databases.set(key, opened);
		}
		return opened;
	};
}

async function openOpfsDatabase(filename: string): Promise<Database> {
	const sqlite3 = (await sqlite3InitModule()) as unknown as SqliteModule;
	if (sqlite3.oo1.OpfsDb === undefined) {
		throw new Error('This browser does not provide SQLite OPFS storage.');
	}
	return new sqlite3.oo1.OpfsDb(filename);
}

function createAsyncDatabase(database: Database): AppSqliteDatabase {
	let queue = Promise.resolve();
	const serialize = <T>(operation: () => T | Promise<T>): Promise<T> => {
		const next = queue.then(operation, operation);
		queue = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	};

	return {
		run: (sql, parameters) =>
			asResult(serialize(() => {
				execute(database, sql, parameters);
				return { changes: changeCount(database) };
			})),
		all: <TRow>(sql: string, parameters?: readonly SqliteValue[]) =>
			asResult(serialize(() => executeRows<TRow>(database, sql, parameters))),
		batch: (statements) =>
			asResult(serialize(() => {
				database.exec('BEGIN');
				try {
					const changes: number[] = [];
					for (const statement of statements) {
						execute(database, statement.sql, statement.parameters);
						changes.push(changeCount(database));
					}
					database.exec('COMMIT');
					return { changes };
				} catch (cause) {
					try {
						database.exec('ROLLBACK');
					} catch {
						// Preserve the statement failure. The owner is unusable if rollback fails.
					}
					throw cause;
				}
			})),
	};
}

function asResult<T>(promise: Promise<T>): Promise<import('wellcrafted/result').Result<T, import('./index.js').AppError>> {
	return promise.then(
		(value) => ({ data: value, error: null }),
		(cause) => AppError.StorageFailed({ cause }),
	);
}

function execute(
	database: Database,
	sql: string,
	parameters?: readonly SqliteValue[],
): void {
	const statement = database.prepare(sql);
	try {
		if (parameters !== undefined) statement.bind(parameters);
		while (statement.step()) {
			// Drain rows for statements that return them. `run` intentionally ignores them.
		}
	} finally {
		statement.finalize();
	}
}

function executeRows<TRow>(
	database: Database,
	sql: string,
	parameters?: readonly SqliteValue[],
): TRow[] {
	const statement = database.prepare(sql);
	try {
		if (parameters !== undefined) statement.bind(parameters);
		const rows: TRow[] = [];
		while (statement.step()) rows.push(statement.get({}) as TRow);
		return rows;
	} finally {
		statement.finalize();
	}
}

function changeCount(database: Database): number {
	const count = database.changes();
	if (typeof count === 'bigint') {
		if (count > BigInt(Number.MAX_SAFE_INTEGER)) {
			throw new Error('SQLite change count exceeds JavaScript precision.');
		}
		return Number(count);
	}
	return count;
}

function databaseFilename(appId: string, name: string): string {
	return `/${encodeURIComponent(appId)}-${encodeURIComponent(name)}.sqlite`;
}
