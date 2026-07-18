/**
 * Browser IndexedDB Document Store Tests
 *
 * Verifies workspace-scoped Yjs 14 persistence, cross-tab propagation,
 * destructive-operation safety, bounded compaction, and fail-closed storage.
 */

import { expect, test } from 'bun:test';
import * as Y from '@y/y';
import { IDBKeyRange, indexedDB } from 'fake-indexeddb';
import {
	createBrowserIndexedDbDocumentStore,
	type DocumentBroadcastChannel,
} from './browser-indexed-db.js';
import type { RowAddress } from './persistence.js';

const UPDATES_STORE = 'updates';
const ADDRESS_INDEX = 'address';
let databaseSequence = 0;

class FakeBroadcastChannel implements DocumentBroadcastChannel {
	static readonly channels = new Map<string, Set<FakeBroadcastChannel>>();

	onmessage: ((event: { data: unknown }) => void) | null = null;
	readonly #name: string;

	constructor(name: string) {
		this.#name = name;
		const peers = FakeBroadcastChannel.channels.get(name) ?? new Set();
		peers.add(this);
		FakeBroadcastChannel.channels.set(name, peers);
	}

	postMessage(value: unknown): void {
		for (const peer of FakeBroadcastChannel.channels.get(this.#name) ?? []) {
			if (peer === this) continue;
			const data = structuredClone(value);
			queueMicrotask(() => peer.onmessage?.({ data }));
		}
	}

	close(): void {
		const peers = FakeBroadcastChannel.channels.get(this.#name);
		peers?.delete(this);
		if (peers?.size === 0) FakeBroadcastChannel.channels.delete(this.#name);
		this.onmessage = null;
	}
}

function address(rowId: string): RowAddress {
	return { table: 'notes', rowId };
}

function addressKey(value: RowAddress): string {
	return JSON.stringify([value.table, value.rowId]);
}

function createStore({
	databaseName = `epicenter-y14-document-test-${databaseSequence++}`,
	compactionThreshold,
}: {
	databaseName?: string;
	compactionThreshold?: number;
} = {}) {
	return {
		databaseName,
		store: createBrowserIndexedDbDocumentStore({
			databaseName,
			indexedDb: indexedDB,
			keyRange: IDBKeyRange,
			...(compactionThreshold === undefined ? {} : { compactionThreshold }),
			createBroadcastChannel: (name) => new FakeBroadcastChannel(name),
		}),
	};
}

function openDatabase(
	databaseName: string,
	version?: number,
): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request =
			version === undefined
				? indexedDB.open(databaseName)
				: indexedDB.open(databaseName, version);
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onerror = () => reject(transaction.error);
		transaction.onabort = () => reject(transaction.error);
	});
}

async function rawUpdates(
	databaseName: string,
	rowAddress: RowAddress,
): Promise<Array<{ id: number; address: string; update: Uint8Array }>> {
	const database = await openDatabase(databaseName);
	try {
		const transaction = database.transaction(UPDATES_STORE, 'readonly');
		const completed = transactionComplete(transaction);
		const request = transaction
			.objectStore(UPDATES_STORE)
			.index(ADDRESS_INDEX)
			.getAll(IDBKeyRange.only(addressKey(rowAddress)));
		const rows = await new Promise<
			Array<{ id: number; address: string; update: Uint8Array }>
		>((resolve, reject) => {
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		await completed;
		return rows;
	} finally {
		database.close();
	}
}

async function insertRawUpdate(
	databaseName: string,
	rowAddress: RowAddress,
	update: Uint8Array,
): Promise<void> {
	const database = await openDatabase(databaseName);
	try {
		const transaction = database.transaction(UPDATES_STORE, 'readwrite');
		const completed = transactionComplete(transaction);
		transaction.objectStore(UPDATES_STORE).add({
			address: addressKey(rowAddress),
			update,
		});
		await completed;
	} finally {
		database.close();
	}
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error('Condition did not become true');
}

test('one workspace database replays independent structured row addresses', async () => {
	const { databaseName, store } = createStore();
	const first = new Y.Doc();
	const second = new Y.Doc();
	const firstLease = store.attach(address('first'), first);
	const secondLease = store.attach(address('second'), second);
	await Promise.all([firstLease.whenLoaded, secondLease.whenLoaded]);
	first.get('editor').insert(0, 'first value');
	second.get('editor').insert(0, 'second value');
	await Promise.all([firstLease.whenDurable(), secondLease.whenDurable()]);
	await Promise.all([firstLease.dispose(), secondLease.dispose()]);
	first.destroy();
	second.destroy();

	const reopened = createStore({ databaseName }).store;
	const reopenedFirst = new Y.Doc();
	const reopenedSecond = new Y.Doc();
	const reopenedFirstLease = reopened.attach(address('first'), reopenedFirst);
	const reopenedSecondLease = reopened.attach(
		address('second'),
		reopenedSecond,
	);
	await Promise.all([
		reopenedFirstLease.whenLoaded,
		reopenedSecondLease.whenLoaded,
	]);
	expect(reopenedFirst.get('editor').toString()).toBe('first value');
	expect(reopenedSecond.get('editor').toString()).toBe('second value');
	await Promise.all([
		reopenedFirstLease.dispose(),
		reopenedSecondLease.dispose(),
	]);
	reopenedFirst.destroy();
	reopenedSecond.destroy();
});

test('whenDurable captures the update tail present at invocation', async () => {
	const { store } = createStore();
	const document = new Y.Doc();
	const lease = store.attach(address('fixed-cut'), document);
	await lease.whenLoaded;

	document.get('editor').insert(0, 'a');
	const firstCut = lease.whenDurable();
	document.get('editor').insert(1, 'b');
	expect(lease.whenDurable()).not.toBe(firstCut);
	await firstCut;
	await lease.whenDurable();
	await lease.dispose();
	document.destroy();
});

test('persisted hydration and an immediate local edit both survive', async () => {
	const { databaseName, store } = createStore();
	const seeded = new Y.Doc();
	const seededLease = store.attach(address('hydration-race'), seeded);
	await seededLease.whenLoaded;
	seeded.get('persisted').insert(0, 'stored');
	await seededLease.dispose();
	seeded.destroy();

	const reopened = createStore({ databaseName }).store;
	const document = new Y.Doc();
	const lease = reopened.attach(address('hydration-race'), document);
	document.get('immediate').insert(0, 'local');
	await lease.whenDurable();
	expect(document.get('persisted').toString()).toBe('stored');
	expect(document.get('immediate').toString()).toBe('local');
	await lease.dispose();
	document.destroy();
});

test('BroadcastChannel propagates committed updateV2 changes across tabs', async () => {
	const { databaseName, store: firstStore } = createStore();
	const secondStore = createStore({ databaseName }).store;
	const first = new Y.Doc();
	const second = new Y.Doc();
	const firstLease = firstStore.attach(address('shared'), first);
	const secondLease = secondStore.attach(address('shared'), second);
	await Promise.all([firstLease.whenLoaded, secondLease.whenLoaded]);

	first.get('editor').insert(0, 'shared value');
	await firstLease.whenDurable();
	await waitFor(() => second.get('editor').toString() === 'shared value');

	await Promise.all([firstLease.dispose(), secondLease.dispose()]);
	first.destroy();
	second.destroy();
	const captured = await secondStore.capture(address('shared'));
	expect(captured).toBeDefined();
	const verified = new Y.Doc();
	Y.applyUpdateV2(verified, captured!);
	expect(verified.get('editor').toString()).toBe('shared value');
	verified.destroy();
});

test('capture includes the active lease durability cut', async () => {
	const { store } = createStore();
	const document = new Y.Doc();
	const lease = store.attach(address('capture'), document);
	await lease.whenLoaded;
	document.get('editor').insert(0, 'captured now');
	const bytes = await store.capture(address('capture'));
	const captured = new Y.Doc();
	Y.applyUpdateV2(captured, bytes!);
	expect(captured.get('editor').toString()).toBe('captured now');
	await lease.dispose();
	document.destroy();
	captured.destroy();
});

test('delete and deleteAll refuse active leases and clear closed logs', async () => {
	const { store } = createStore();
	const first = new Y.Doc();
	const firstLease = store.attach(address('delete-one'), first);
	await firstLease.whenLoaded;
	first.get('editor').insert(0, 'remove');
	await expect(store.delete(address('delete-one'))).rejects.toThrow(
		'while its lease is active',
	);
	await expect(store.deleteAll()).rejects.toThrow('while leases are active');
	await firstLease.dispose();
	await store.delete(address('delete-one'));
	expect(await store.capture(address('delete-one'))).toBeUndefined();
	first.destroy();

	for (const rowId of ['all-a', 'all-b']) {
		const document = new Y.Doc();
		const lease = store.attach(address(rowId), document);
		await lease.whenLoaded;
		document.get('editor').insert(0, rowId);
		await lease.dispose();
		document.destroy();
	}
	await store.deleteAll();
	expect(await store.capture(address('all-a'))).toBeUndefined();
	expect(await store.capture(address('all-b'))).toBeUndefined();
});

test('final lease teardown stops persistence and releases channel resources', async () => {
	const { databaseName, store } = createStore();
	const document = new Y.Doc();
	const lease = store.attach(address('teardown'), document);
	await lease.whenLoaded;
	document.get('editor').insert(0, 'durable');
	await lease.dispose();
	document.get('editor').insert(document.get('editor').length, ' ignored');
	expect(FakeBroadcastChannel.channels.size).toBe(0);
	document.destroy();

	const reopened = createStore({ databaseName }).store;
	const replayed = new Y.Doc();
	const replayedLease = reopened.attach(address('teardown'), replayed);
	await replayedLease.whenLoaded;
	expect(replayed.get('editor').toString()).toBe('durable');
	await replayedLease.dispose();
	replayed.destroy();
});

test('bounded prefix compaction atomically preserves document state', async () => {
	const { databaseName, store } = createStore({ compactionThreshold: 3 });
	const document = new Y.Doc();
	const lease = store.attach(address('compacted'), document);
	await lease.whenLoaded;
	for (const character of ['a', 'b', 'c']) {
		document.get('editor').insert(document.get('editor').length, character);
	}
	await lease.whenDurable();
	await lease.dispose();
	expect(await rawUpdates(databaseName, address('compacted'))).toHaveLength(1);
	document.destroy();

	const reopened = createStore({ databaseName, compactionThreshold: 3 }).store;
	const replayed = new Y.Doc();
	const replayedLease = reopened.attach(address('compacted'), replayed);
	await replayedLease.whenLoaded;
	expect(replayed.get('editor').toString()).toBe('abc');
	await replayedLease.dispose();
	replayed.destroy();
});

test('corrupt persisted bytes poison the whole workspace document store', async () => {
	const { databaseName, store } = createStore();
	const initialized = new Y.Doc();
	const initializedLease = store.attach(address('corrupt'), initialized);
	await initializedLease.whenLoaded;
	await initializedLease.dispose();
	initialized.destroy();
	await insertRawUpdate(
		databaseName,
		address('corrupt'),
		new Uint8Array([255]),
	);

	const corrupted = new Y.Doc();
	const lease = store.attach(address('corrupt'), corrupted);
	await expect(lease.whenLoaded).rejects.toThrow();
	expect(() => store.attach(address('later'), new Y.Doc())).toThrow();
	await expect(store.capture(address('later'))).rejects.toThrow();
	corrupted.destroy();
});

test('foreign versionchange poisons current and future operations', async () => {
	const { databaseName, store } = createStore();
	const document = new Y.Doc();
	const lease = store.attach(address('evicted'), document);
	await lease.whenLoaded;

	const upgraded = await openDatabase(databaseName, 2);
	await expect(lease.whenDurable()).rejects.toThrow(
		'changed or was deleted by another connection',
	);
	document.get('editor').insert(0, 'not persisted');
	await expect(lease.whenDurable()).rejects.toThrow(
		'changed or was deleted by another connection',
	);
	await expect(store.delete(address('other'))).rejects.toThrow(
		'changed or was deleted by another connection',
	);
	upgraded.close();
	await expect(lease.dispose()).rejects.toThrow(
		'changed or was deleted by another connection',
	);
	document.destroy();
});

test('a failed append transaction permanently poisons the store', async () => {
	const { databaseName, store } = createStore();
	const document = new Y.Doc();
	const lease = store.attach(address('transaction-failure'), document);
	await lease.whenLoaded;

	const raw = await openDatabase(databaseName);
	const objectStore = raw
		.transaction(UPDATES_STORE, 'readonly')
		.objectStore(UPDATES_STORE);
	const prototype = Object.getPrototypeOf(objectStore) as {
		add: IDBObjectStore['add'];
	};
	const originalAdd = prototype.add;
	prototype.add = () => {
		throw new Error('injected append transaction failure');
	};
	try {
		document.get('editor').insert(0, 'fails');
		await expect(lease.whenDurable()).rejects.toThrow(
			'injected append transaction failure',
		);
	} finally {
		prototype.add = originalAdd;
		raw.close();
	}
	await expect(store.capture(address('transaction-failure'))).rejects.toThrow(
		'injected append transaction failure',
	);
	await expect(lease.dispose()).rejects.toThrow(
		'injected append transaction failure',
	);
	document.destroy();
});
