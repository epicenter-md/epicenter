/**
 * Native SQLite Document Store Tests
 *
 * Verifies Yjs 14 persistence semantics over the shared synchronous SQLite
 * contract without runtime or Tauri wiring.
 */

import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import type { SqliteDatabase } from '@epicenter/sqlite';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import * as Y from '@y/y';
import { createNativeSqliteDocumentStore } from './native-sqlite.js';
import type { RowAddress } from './persistence.js';

const UPDATES_TABLE = 'workspace_document_updates';

function address(rowId: string): RowAddress {
	return { table: 'notes', rowId };
}

function setup({ compactionThreshold }: { compactionThreshold?: number } = {}) {
	const sqlite = new Database(':memory:', { strict: true });
	const database = createBunSqliteAdapter(sqlite);
	return {
		sqlite,
		database,
		store: createNativeSqliteDocumentStore({
			database,
			...(compactionThreshold === undefined ? {} : { compactionThreshold }),
		}),
	};
}

function countUpdates(
	database: SqliteDatabase,
	rowAddress: RowAddress,
): number {
	return (
		database.all<{ count: number }>(
			`SELECT COUNT(*) AS count FROM ${UPDATES_TABLE}
			 WHERE table_name = ? AND row_id = ?`,
			[rowAddress.table, rowAddress.rowId],
		)[0]?.count ?? 0
	);
}

test('empty attach and edit/durable/dispose/reopen use one caller database', async () => {
	const context = setup();
	try {
		const empty = new Y.Doc();
		const emptyLease = context.store.attach(address('empty'), empty);
		await emptyLease.whenLoaded;
		expect(empty.get('editor').toString()).toBe('');
		await emptyLease.dispose();
		empty.destroy();

		const written = new Y.Doc();
		const writtenLease = context.store.attach(address('written'), written);
		await writtenLease.whenLoaded;
		written.get('editor').insert(0, 'native value');
		await writtenLease.whenDurable();
		await writtenLease.dispose();
		written.destroy();

		const reopened = createNativeSqliteDocumentStore({
			database: context.database,
		});
		const replayed = new Y.Doc();
		const replayedLease = reopened.attach(address('written'), replayed);
		await replayedLease.whenLoaded;
		expect(replayed.get('editor').toString()).toBe('native value');
		await replayedLease.dispose();
		replayed.destroy();
	} finally {
		context.sqlite.close();
	}
});

test('whenDurable captures one fixed synchronous transaction cut', async () => {
	const context = setup();
	try {
		const document = new Y.Doc();
		const lease = context.store.attach(address('fixed-cut'), document);
		await lease.whenLoaded;
		document.get('editor').insert(0, 'a');
		const firstCut = lease.whenDurable();
		document.get('editor').insert(1, 'b');
		expect(lease.whenDurable()).not.toBe(firstCut);
		await firstCut;
		await lease.whenDurable();
		await lease.dispose();
		document.destroy();
	} finally {
		context.sqlite.close();
	}
});

test('listener admission precedes synchronous hydration', async () => {
	const sqlite = new Database(':memory:', { strict: true });
	const base = createBunSqliteAdapter(sqlite);
	const document = new Y.Doc();
	let injected = false;
	const database: SqliteDatabase = {
		run: base.run,
		all(sql, parameters) {
			if (!injected && sql.includes('SELECT update_bytes')) {
				injected = true;
				document.get('immediate').insert(0, 'admitted');
			}
			return base.all(sql, parameters);
		},
		transaction: base.transaction,
	};
	try {
		const store = createNativeSqliteDocumentStore({ database });
		const lease = store.attach(address('hydration'), document);
		await lease.whenLoaded;
		await lease.whenDurable();
		await lease.dispose();

		const reopened = createNativeSqliteDocumentStore({ database: base });
		const replayed = new Y.Doc();
		const replayedLease = reopened.attach(address('hydration'), replayed);
		await replayedLease.whenLoaded;
		expect(replayed.get('immediate').toString()).toBe('admitted');
		await replayedLease.dispose();
		replayed.destroy();
		document.destroy();
	} finally {
		sqlite.close();
	}
});

test('remote updateV2 changes persist and row addresses stay isolated', async () => {
	const context = setup();
	try {
		const first = new Y.Doc();
		const second = new Y.Doc();
		const firstLease = context.store.attach(address('first'), first);
		const secondLease = context.store.attach(address('second'), second);
		await Promise.all([firstLease.whenLoaded, secondLease.whenLoaded]);

		const remote = new Y.Doc();
		remote.get('editor').insert(0, 'remote value');
		Y.applyUpdateV2(first, Y.encodeStateAsUpdateV2(remote), 'network');
		second.get('editor').insert(0, 'second value');
		await Promise.all([firstLease.whenDurable(), secondLease.whenDurable()]);
		await Promise.all([firstLease.dispose(), secondLease.dispose()]);
		first.destroy();
		second.destroy();
		remote.destroy();

		const firstCapture = await context.store.capture(address('first'));
		const secondCapture = await context.store.capture(address('second'));
		const capturedFirst = new Y.Doc();
		const capturedSecond = new Y.Doc();
		Y.applyUpdateV2(capturedFirst, firstCapture!);
		Y.applyUpdateV2(capturedSecond, secondCapture!);
		expect(capturedFirst.get('editor').toString()).toBe('remote value');
		expect(capturedSecond.get('editor').toString()).toBe('second value');
		capturedFirst.destroy();
		capturedSecond.destroy();
	} finally {
		context.sqlite.close();
	}
});

test('capture includes an active lease cut', async () => {
	const context = setup();
	try {
		const document = new Y.Doc();
		const lease = context.store.attach(address('capture'), document);
		await lease.whenLoaded;
		document.get('editor').insert(0, 'captured');
		const bytes = await context.store.capture(address('capture'));
		const captured = new Y.Doc();
		Y.applyUpdateV2(captured, bytes!);
		expect(captured.get('editor').toString()).toBe('captured');
		await lease.dispose();
		document.destroy();
		captured.destroy();
	} finally {
		context.sqlite.close();
	}
});

test('delete and deleteAll reject active leases and clear closed rows', async () => {
	const context = setup();
	try {
		const document = new Y.Doc();
		const lease = context.store.attach(address('delete-one'), document);
		await lease.whenLoaded;
		document.get('editor').insert(0, 'remove');
		await expect(context.store.delete(address('delete-one'))).rejects.toThrow(
			'while its lease is active',
		);
		await expect(context.store.deleteAll()).rejects.toThrow(
			'while leases are active',
		);
		await lease.dispose();
		await context.store.delete(address('delete-one'));
		expect(await context.store.capture(address('delete-one'))).toBeUndefined();
		document.destroy();

		for (const rowId of ['all-a', 'all-b']) {
			const row = new Y.Doc();
			const rowLease = context.store.attach(address(rowId), row);
			await rowLease.whenLoaded;
			row.get('editor').insert(0, rowId);
			await rowLease.dispose();
			row.destroy();
		}
		await context.store.deleteAll();
		expect(await context.store.capture(address('all-a'))).toBeUndefined();
		expect(await context.store.capture(address('all-b'))).toBeUndefined();
	} finally {
		context.sqlite.close();
	}
});

test('bounded compaction replaces a covered prefix with one complete update', async () => {
	const context = setup({ compactionThreshold: 3 });
	try {
		const document = new Y.Doc();
		const lease = context.store.attach(address('compacted'), document);
		await lease.whenLoaded;
		for (const character of ['a', 'b', 'c']) {
			document.get('editor').insert(document.get('editor').length, character);
		}
		await lease.whenDurable();
		await lease.dispose();
		expect(countUpdates(context.database, address('compacted'))).toBe(1);
		document.destroy();

		const reopened = createNativeSqliteDocumentStore({
			database: context.database,
			compactionThreshold: 3,
		});
		const replayed = new Y.Doc();
		const replayedLease = reopened.attach(address('compacted'), replayed);
		await replayedLease.whenLoaded;
		expect(replayed.get('editor').toString()).toBe('abc');
		await replayedLease.dispose();
		replayed.destroy();
	} finally {
		context.sqlite.close();
	}
});

test('failed compaction rolls its whole covered transaction back', async () => {
	const sqlite = new Database(':memory:', { strict: true });
	const base = createBunSqliteAdapter(sqlite);
	let failAfterTransaction = false;
	const database: SqliteDatabase = {
		run: base.run,
		all: base.all,
		transaction(run) {
			return base.transaction(() => {
				const result = run();
				if (failAfterTransaction) {
					failAfterTransaction = false;
					throw new Error('injected crash before commit');
				}
				return result;
			});
		},
	};
	try {
		const store = createNativeSqliteDocumentStore({
			database,
			compactionThreshold: 3,
		});
		const document = new Y.Doc();
		const lease = store.attach(address('crash-safe'), document);
		await lease.whenLoaded;
		document.get('editor').insert(0, 'a');
		document.get('editor').insert(1, 'b');
		failAfterTransaction = true;
		document.get('editor').insert(2, 'c');
		await expect(lease.whenDurable()).rejects.toThrow(
			'injected crash before commit',
		);
		await expect(lease.dispose()).rejects.toThrow(
			'injected crash before commit',
		);
		document.destroy();

		const reopened = createNativeSqliteDocumentStore({ database: base });
		const captured = await reopened.capture(address('crash-safe'));
		const verified = new Y.Doc();
		Y.applyUpdateV2(verified, captured!);
		expect(verified.get('editor').toString()).toBe('ab');
		verified.destroy();
	} finally {
		sqlite.close();
	}
});

test('corrupt updates poison the store and every later operation', async () => {
	const context = setup();
	try {
		context.database.run(
			`INSERT INTO ${UPDATES_TABLE}(table_name, row_id, update_bytes)
			 VALUES (?, ?, ?)`,
			['notes', 'corrupt', new Uint8Array([255])],
		);
		const document = new Y.Doc();
		const lease = context.store.attach(address('corrupt'), document);
		await expect(lease.whenLoaded).rejects.toThrow();
		expect(() => context.store.attach(address('later'), new Y.Doc())).toThrow();
		await expect(context.store.capture(address('later'))).rejects.toThrow();
		document.destroy();
	} finally {
		context.sqlite.close();
	}
});

test('failed write transaction poisons durability and future reads', async () => {
	const sqlite = new Database(':memory:', { strict: true });
	const base = createBunSqliteAdapter(sqlite);
	let failNextTransaction = false;
	const database: SqliteDatabase = {
		run: base.run,
		all: base.all,
		transaction(run) {
			return base.transaction(() => {
				if (failNextTransaction) {
					failNextTransaction = false;
					throw new Error('injected native transaction failure');
				}
				return run();
			});
		},
	};
	try {
		const store = createNativeSqliteDocumentStore({ database });
		const document = new Y.Doc();
		const lease = store.attach(address('failure'), document);
		await lease.whenLoaded;
		failNextTransaction = true;
		document.get('editor').insert(0, 'not durable');
		await expect(lease.whenDurable()).rejects.toThrow(
			'injected native transaction failure',
		);
		await expect(store.capture(address('failure'))).rejects.toThrow(
			'injected native transaction failure',
		);
		await expect(lease.dispose()).rejects.toThrow(
			'injected native transaction failure',
		);
		document.destroy();
	} finally {
		sqlite.close();
	}
});

test('final lease disposal stops later document updates', async () => {
	const context = setup();
	try {
		const document = new Y.Doc();
		const lease = context.store.attach(address('teardown'), document);
		await lease.whenLoaded;
		document.get('editor').insert(0, 'durable');
		await lease.dispose();
		document.get('editor').insert(document.get('editor').length, ' ignored');
		document.destroy();

		const captured = await context.store.capture(address('teardown'));
		const verified = new Y.Doc();
		Y.applyUpdateV2(verified, captured!);
		expect(verified.get('editor').toString()).toBe('durable');
		verified.destroy();
	} finally {
		context.sqlite.close();
	}
});
