/**
 * Embedded SQLite Adapter Conformance Tests
 *
 * Verifies that every runtime adapter exposes the same query and transaction
 * semantics without depending on an authority or workspace schema.
 *
 * Key behaviors:
 * - bound writes and object-row reads agree across adapters
 * - transaction exceptions roll back every write
 * - nesting is not part of the contract, and the browser adapter says so
 *   loudly (OO1 refuses a nested BEGIN) rather than pretending
 *
 * The browser adapter runs against sqlite.org's real WASM build, not a
 * bun:sqlite stand-in, so what is pinned here is OO1's own semantics.
 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { createBrowserSqliteAdapter } from './browser.js';
import { createBunSqliteAdapter } from './bun.js';
import {
	createDurableObjectSqliteAdapter,
	type DurableObjectSqliteStorage,
} from './durable-object.js';
import type { SqliteDatabase, SqliteValue } from './index.js';

const sqlite3 = await sqlite3InitModule();

type OpenDatabase = () => {
	database: SqliteDatabase;
	close(): void;
};

function execute(
	database: Database,
	sql: string,
	parameters: readonly SqliteValue[],
): void {
	database.run(sql, [...parameters]);
}

function query<TRow>(
	database: Database,
	sql: string,
	parameters: readonly SqliteValue[],
): TRow[] {
	return database.query<TRow, SqliteValue[]>(sql).all(...parameters);
}

function openBrowser() {
	const handle = new sqlite3.oo1.DB(':memory:');
	return {
		database: createBrowserSqliteAdapter(handle),
		close: () => handle.close(),
	};
}

const adapters: [name: string, open: OpenDatabase][] = [
	[
		'Bun SQLite',
		() => {
			const sqlite = new Database(':memory:');
			return {
				database: createBunSqliteAdapter(sqlite),
				close: () => sqlite.close(),
			};
		},
	],
	['browser SQLite OO1', openBrowser],
	[
		'Durable Object SQLite',
		() => {
			const sqlite = new Database(':memory:');
			const storage = {
				sql: {
					exec<TRow>(sql: string, ...bindings: SqliteValue[]) {
						let rows: TRow[] = [];
						if (/^\s*(SELECT|WITH|PRAGMA)/i.test(sql)) {
							rows = query<TRow>(sqlite, sql, bindings);
						} else {
							execute(sqlite, sql, bindings);
						}
						return { toArray: () => rows };
					},
				},
				transactionSync(run) {
					return sqlite.transaction(run).immediate();
				},
			} satisfies DurableObjectSqliteStorage;
			return {
				database: createDurableObjectSqliteAdapter(storage),
				close: () => sqlite.close(),
			};
		},
	],
];

for (const [name, open] of adapters) {
	test(`${name}: writes, reads, and rollback share one contract`, () => {
		const { database, close } = open();
		try {
			database.run('CREATE TABLE values_table(value TEXT NOT NULL)');
			database.run('INSERT INTO values_table VALUES (?)', ['kept']);
			expect(() =>
				database.transaction(() => {
					database.run('INSERT INTO values_table VALUES (?)', ['rolled-back']);
					throw new Error('rollback');
				}),
			).toThrow('rollback');
			expect(
				database.all<{ value: string }>(
					'SELECT value FROM values_table ORDER BY rowid',
				),
			).toEqual([{ value: 'kept' }]);
		} finally {
			close();
		}
	});
}

test('browser SQLite OO1: a nested transaction is refused loudly, and the outer work survives', () => {
	// Nesting has no production caller (the browser store loads no SQLite; the
	// only browser-reachable transaction, never nested), so the adapter does
	// not emulate it. OO1's own refusal is the honest answer, and the outer
	// transaction is still the caller's to complete: catching the refusal and
	// finishing commits the outer work.
	const { database, close } = openBrowser();
	try {
		database.run('CREATE TABLE nested_values(value TEXT NOT NULL)');
		database.transaction(() => {
			database.run("INSERT INTO nested_values VALUES ('outer')");
			expect(() => database.transaction(() => undefined)).toThrow(
				/transaction within a transaction/,
			);
		});
		expect(database.all('SELECT value FROM nested_values')).toEqual([
			{ value: 'outer' },
		]);
	} finally {
		close();
	}
});

test('browser SQLite OO1: object rows come back with bound values intact', () => {
	// The two exec shapes the façade declares, exercised against the real
	// overload set: a run for effects, and an object-rows read.
	const { database, close } = openBrowser();
	try {
		database.run('CREATE TABLE typed(label TEXT, count INTEGER, blob BLOB)');
		database.run('INSERT INTO typed VALUES (?, ?, ?)', [
			'a',
			2,
			new Uint8Array([7]),
		]);
		const rows = database.all<{
			label: string;
			count: number;
			blob: Uint8Array;
		}>('SELECT label, count, blob FROM typed');
		expect(rows).toHaveLength(1);
		expect(rows[0]?.label).toBe('a');
		expect(rows[0]?.count).toBe(2);
		expect(new Uint8Array(rows[0]?.blob ?? [])).toEqual(new Uint8Array([7]));
	} finally {
		close();
	}
});
