/**
 * Open one application's store in a browser page.
 *
 * The store runs HERE, on the main thread, over an in-memory SQLite, and its
 * durable state is three small relations in IndexedDB.
 *
 * ## Why an in-memory database is not a compromise
 *
 * The store needs a synchronous HANDLE, not synchronous DURABILITY. It touches
 * SQLite in three places, the schema and the replay at construction and then
 * `transaction` and `all`, and every read a person makes (`get`, `list`, `ids`,
 * `document`) comes from the `Y.Doc` already in memory. SQLite is a
 * write-behind log and a query cache, never the read path.
 *
 * ## Why there is no worker
 *
 * There was one, holding the same database on OPFS and fed every statement, so
 * that reopening restored the file whole. It was justified by the projection
 * "coming back for free", and that is false: `bind` rebuilds every projected
 * table unconditionally, because the CRDT is the truth and a projection is a
 * cache. So the restored projection was thrown away every time.
 *
 * What actually has to survive is `_updates`, `_outbox` and `_cursor`, and all
 * three are small: `appendUpdate` collapses the log at `COMPACTION_THRESHOLD`
 * (64) into one baseline, the outbox is coalesced before it is sent, and the
 * cursor is one row. That is an IndexedDB record, not a file, and IndexedDB is
 * reachable from the page. `createSyncAccessHandle` being dedicated-worker-only
 * (`evidence/browser/sync-access-handle.ts`) decided where a FILE could live,
 * and once nothing needs a file it decides nothing at all.
 *
 * Deleted with it: a second sqlite-wasm instance, the OPFS SAH pool and its
 * exclusive-per-origin retry loop, a message protocol, and the mirroring of
 * every statement including the projection writes it turned out nobody wanted.
 */
import { createBrowserSqliteAdapter } from '@epicenter/sqlite/browser';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';

import {
	APP_DOCUMENT,
	applyStoreSchema,
	copyBytes,
} from './persistence.js';
import { createStore, StoreError, type Store } from './store.js';

/**
 * Whether this device's durable copy is keeping up with its live one.
 *
 * The one thing a browser store has that a Bun store does not. On Bun the
 * durable write IS the write, so `persist` can poison the store the moment
 * storage refuses. IndexedDB is asynchronous, so a refusal arrives after the
 * write already returned `Ok` and there is nothing left to fail.
 *
 * Nothing is lost when this fires. The `Y.Doc` still holds the work and the
 * outbox still owes it to the authority, so it reaches every other device
 * normally. What is lost is the guarantee that a RELOAD of this device sees it.
 * That makes it an alarm an application shows rather than an error a call
 * returns, in the same shape as `hasUnresolvedDependencies`.
 */
export type StoreDurability =
	| { readonly healthy: true }
	| { readonly healthy: false; readonly name: string; readonly message: string };

export type BrowserStore = Store & {
	/** Whether the durable copy has fallen behind, and why. */
	durability(): StoreDurability;
	/** Resolve once every write so far has reached durable storage. */
	whenDurable(): Promise<Result<void, StoreError>>;
};

/** The three relations that have to survive a reload. */
type DurableState = {
	updates: { seq: number; bytes: Uint8Array }[];
	outbox: { id: number; bytes: Uint8Array }[];
	cursor: number;
};

const STORE_NAME = 'state';
const STATE_KEY = 'durable';

function openIndexedDb(name: string): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(`epicenter-store-${name}`, 1);
		request.onupgradeneeded = () => {
			const database = request.result;
			if (!database.objectStoreNames.contains(STORE_NAME)) {
				database.createObjectStore(STORE_NAME);
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error('indexedDB.open failed'));
	});
}

function readDurable(database: IDBDatabase): Promise<DurableState | undefined> {
	return new Promise((resolve, reject) => {
		const request = database
			.transaction(STORE_NAME, 'readonly')
			.objectStore(STORE_NAME)
			.get(STATE_KEY);
		request.onsuccess = () => resolve(request.result as DurableState | undefined);
		request.onerror = () => reject(request.error ?? new Error('read failed'));
	});
}

function writeDurable(database: IDBDatabase, state: DurableState): Promise<void> {
	return new Promise((resolve, reject) => {
		const transaction = database.transaction(STORE_NAME, 'readwrite');
		transaction.objectStore(STORE_NAME).put(state, STATE_KEY);
		transaction.oncomplete = () => resolve();
		transaction.onerror = () =>
			reject(transaction.error ?? new Error('write failed'));
		transaction.onabort = () =>
			reject(transaction.error ?? new Error('write aborted'));
	});
}

function describe(cause: unknown): { name: string; message: string } {
	if (cause instanceof Error) return { name: cause.name, message: cause.message };
	return { name: 'Error', message: String(cause) };
}

export async function openBrowserStore({
	name,
}: {
	/**
	 * This application's durable state, inside the origin's private storage.
	 *
	 * Named by the application rather than derived, because an origin can host
	 * more than one and ADR-0215's "one document per application" is a statement
	 * about documents rather than about origins.
	 */
	name: string;
}): Promise<Result<BrowserStore, StoreError>> {
	const opened = await tryAsync({
		try: async () => {
			const durable = await openIndexedDb(name);
			return { durable, saved: await readDurable(durable) };
		},
		catch: (cause) => StoreError.StorageFailed({ cause }),
	});
	if (opened.error !== null) return Err(opened.error);
	const { durable, saved } = opened.data;

	const built = await tryAsync({
		try: async () => {
			const sqlite3 = await sqlite3InitModule();
			const database = createBrowserSqliteAdapter(
				new sqlite3.oo1.DB(':memory:') as never,
			);
			applyStoreSchema(database);
			if (saved !== undefined) {
				// Seeded BEFORE `createStore`, because the replay that hydrates the
				// document reads `_updates` out of exactly this handle. From there
				// the browser is indistinguishable from Bun.
				database.transaction(() => {
					for (const update of saved.updates) {
						database.run(
							'INSERT INTO _updates (document, seq, bytes) VALUES (?, ?, ?)',
							[APP_DOCUMENT, update.seq, copyBytes(update.bytes)],
						);
					}
					for (const owed of saved.outbox) {
						database.run('INSERT INTO _outbox (id, bytes) VALUES (?, ?)', [
							owed.id,
							copyBytes(owed.bytes),
						]);
					}
					if (saved.cursor > 0) {
						database.run('INSERT INTO _cursor (document, seq) VALUES (?, ?)', [
							APP_DOCUMENT,
							saved.cursor,
						]);
					}
				});
			}
			return database;
		},
		catch: (cause) => StoreError.StorageFailed({ cause }),
	});
	if (built.error !== null) {
		durable.close();
		return Err(built.error);
	}
	const database = built.data;

	function snapshot(): DurableState {
		const updates = database.all<{ seq: number; bytes: Uint8Array }>(
			'SELECT seq, bytes FROM _updates WHERE document = ? ORDER BY seq',
			[APP_DOCUMENT],
		);
		const outbox = database.all<{ id: number; bytes: Uint8Array }>(
			'SELECT id, bytes FROM _outbox ORDER BY id',
		);
		const cursor = database.all<{ seq: number }>(
			'SELECT seq FROM _cursor WHERE document = ?',
			[APP_DOCUMENT],
		);
		return {
			updates: updates.map((row) => ({ seq: row.seq, bytes: copyBytes(row.bytes) })),
			outbox: outbox.map((row) => ({ id: row.id, bytes: copyBytes(row.bytes) })),
			cursor: cursor[0]?.seq ?? 0,
		};
	}

	let durability: StoreDurability = { healthy: true };
	let writing: Promise<void> | undefined;
	let again = false;

	/**
	 * Write the current durable state, coalescing bursts into one write.
	 *
	 * Latest-wins rather than a queue. Every write carries the WHOLE of the
	 * three relations, so a write that is superseded before it starts had
	 * nothing in it the next one does not, and a person typing produces one
	 * commit per transaction rather than one durable write per transaction.
	 *
	 * Whole rather than incremental because the whole is small: `_updates` is
	 * bounded at `COMPACTION_THRESHOLD`, and compaction renumbers it from 1, so
	 * an incremental writer would need to notice that its positions had come to
	 * mean different updates. There is no version of that which is worth 64 rows.
	 */
	function persistDurable(): void {
		if (writing !== undefined) {
			again = true;
			return;
		}
		const state = snapshot();
		writing = writeDurable(durable, state)
			.catch((cause) => {
				// First failure wins: a durable copy that has fallen behind stays
				// behind, so later failures are consequences.
				if (durability.healthy) durability = { healthy: false, ...describe(cause) };
			})
			.finally(() => {
				writing = undefined;
				if (again) {
					again = false;
					persistDurable();
				}
			});
	}

	const store = createStore({
		database,
		dispose: () => {
			durable.close();
		},
	});

	// Every committed change, local or arrived, and nothing else. `onLocalWork`
	// alone would miss a remote update, which is durable state too.
	const stopLocal = store.onLocalWork(persistDurable);
	const stopRemote = store.onCommitted(persistDurable);

	return Ok(
		Object.freeze({
			...store,
			get sync() {
				return store.sync;
			},
			durability: () => durability,
			async whenDurable(): Promise<Result<void, StoreError>> {
				while (writing !== undefined) await writing;
				return durability.healthy
					? Ok(undefined)
					: StoreError.StorageFailed({
							cause: new Error(`${durability.name}: ${durability.message}`),
						});
			},
			async [Symbol.asyncDispose]() {
				stopLocal();
				stopRemote();
				while (writing !== undefined) await writing;
				await store[Symbol.asyncDispose]();
			},
		}) as BrowserStore,
	);
}
