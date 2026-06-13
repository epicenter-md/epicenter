/**
 * `attachLocalStorage` and `wipeLocalStorage` behavior tests.
 *
 * Covers the identity-scoped pairing of encrypted IDB persistence and
 * cross-tab BroadcastChannel, keyed by `(server, ownerId, ydoc.guid)`. Pins
 * the durable storage shape so any accidental change to the layout is
 * caught here:
 *
 *   epicenter/<server>/owners/<ownerId>/<guid>
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	base64ToBytes,
	bytesToBase64,
	decryptBytes,
	deriveWorkspaceKey,
	type EncryptedBlob,
	type Keyring,
} from '@epicenter/encryption';
import { asOwnerId } from '@epicenter/identity';
import { randomBytes } from '@noble/ciphers/utils.js';
import { IDBKeyRange, indexedDB } from 'fake-indexeddb';
import * as Y from 'yjs';
import { attachLocalStorage } from './attach-local-storage.js';
import {
	clearLocalStorageForDoc,
	wipeLocalStorage,
} from './wipe-local-storage.js';

Object.assign(globalThis, { indexedDB, IDBKeyRange });

const SERVER = 'api.epicenter.so';

function toKeyring(key: Uint8Array): Keyring {
	return [{ version: 1, keyBytesBase64: bytesToBase64(key) }];
}

const noKeys: () => Keyring = () => toKeyring(randomBytes(32));

function tick(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

async function readEncryptedUpdates(dbName: string): Promise<EncryptedBlob[]> {
	const db = await new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(dbName);
		request.onerror = () => reject(request.error);
		request.onsuccess = () => resolve(request.result);
	});
	try {
		const transaction = db.transaction(['updates'], 'readonly');
		const store = transaction.objectStore('updates');
		return await new Promise<EncryptedBlob[]>((resolve, reject) => {
			const request = store.getAll();
			request.onerror = () => reject(request.error);
			request.onsuccess = () => resolve(request.result as EncryptedBlob[]);
		});
	} finally {
		db.close();
	}
}

function keyringForGuid(
	keyring: Keyring,
	guid: string,
): Map<number, Uint8Array> {
	return new Map(
		keyring.map(({ version, keyBytesBase64 }) => [
			version,
			deriveWorkspaceKey(base64ToBytes(keyBytesBase64), guid),
		]),
	);
}

async function createDatabase(name: string): Promise<void> {
	const database = await new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(name);
		request.onerror = () => reject(request.error);
		request.onsuccess = () => resolve(request.result);
	});
	database.close();
}

async function deleteDatabase(name: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const request = indexedDB.deleteDatabase(name);
		request.onerror = () => reject(request.error);
		request.onsuccess = () => resolve();
		request.onblocked = () => reject(new Error(`Delete blocked for ${name}`));
	});
}

async function databaseNames(): Promise<string[]> {
	const databases = await indexedDB.databases();
	return databases
		.map((database) => database.name)
		.filter((name): name is string => typeof name === 'string');
}

describe('attachLocalStorage', () => {
	test('throws when keyring throws', () => {
		const ydoc = new Y.Doc({ guid: 'encrypted-idb-no-keys', gc: true });
		expect(() =>
			attachLocalStorage(ydoc, {
				server: SERVER,
				ownerId: asOwnerId('user-no-keys'),
				keyring: () => {
					throw new Error('not signed-in');
				},
			}),
		).toThrow('not signed-in');
		ydoc.destroy();
	});

	test('round trips encrypted Yjs updates through IndexedDB at the owner prefix', async () => {
		const userId = `user-${crypto.randomUUID()}`;
		const databaseName = `epicenter/${SERVER}/owners/${userId}/encrypted-idb-roundtrip`;
		const keyring = toKeyring(randomBytes(32));

		const firstDoc = new Y.Doc({
			guid: 'encrypted-idb-roundtrip',
			gc: true,
		});
		const firstIdb = attachLocalStorage(firstDoc, {
			server: SERVER,
			ownerId: asOwnerId(userId),
			keyring: () => keyring,
		});
		await firstIdb.whenLoaded;
		firstDoc.getText('body').insert(0, 'stored ciphertext');
		await tick();
		firstDoc.destroy();
		await firstIdb.whenDisposed;

		const rawUpdates = await readEncryptedUpdates(databaseName);
		expect(rawUpdates.length).toBeGreaterThan(0);
		expect(rawUpdates.every((update) => update[0] === 1)).toBe(true);

		const secondDoc = new Y.Doc({
			guid: 'encrypted-idb-roundtrip',
			gc: true,
		});
		const secondIdb = attachLocalStorage(secondDoc, {
			server: SERVER,
			ownerId: asOwnerId(userId),
			keyring: () => keyring,
		});
		await secondIdb.whenLoaded;

		expect(secondDoc.getText('body').toString()).toBe('stored ciphertext');
		secondDoc.destroy();
		await secondIdb.whenDisposed;
		await secondIdb.clearLocal();
	});

	test('target guid changes the derived storage key', async () => {
		const userId = `user-${crypto.randomUUID()}`;
		const databaseName = `epicenter/${SERVER}/owners/${userId}/encrypted-idb-guid-a`;
		const keyring = toKeyring(randomBytes(32));
		const ydoc = new Y.Doc({ guid: 'encrypted-idb-guid-a', gc: true });
		const idb = attachLocalStorage(ydoc, {
			server: SERVER,
			ownerId: asOwnerId(userId),
			keyring: () => keyring,
		});
		await idb.whenLoaded;
		ydoc.getText('body').insert(0, 'guid bound');
		await tick();
		ydoc.destroy();
		await idb.whenDisposed;

		const rawUpdates = await readEncryptedUpdates(databaseName);
		const updateWithContent = rawUpdates.at(-1);
		expect(updateWithContent).toBeDefined();
		expect(() =>
			decryptBytes({
				keyring: keyringForGuid(keyring, 'encrypted-idb-guid-b'),
				blob: updateWithContent as EncryptedBlob,
				aad: new TextEncoder().encode('yjs-update-v2:encrypted-idb-guid-a'),
			}),
		).toThrow();
		await idb.clearLocal();
	});

	test('snapshots the keyring exactly once at attach', async () => {
		const userId = `user-${crypto.randomUUID()}`;
		const keyring = toKeyring(randomBytes(32));
		let reads = 0;

		const ydoc = new Y.Doc({ guid: 'encrypted-idb-snapshot', gc: true });
		const idb = attachLocalStorage(ydoc, {
			server: SERVER,
			ownerId: asOwnerId(userId),
			keyring: () => {
				reads += 1;
				return keyring;
			},
		});
		await idb.whenLoaded;
		ydoc.getText('body').insert(0, 'one');
		await tick();
		ydoc.getText('body').insert(3, ' two');
		await tick();

		expect(reads).toBe(1);
		ydoc.destroy();
		await idb.whenDisposed;
		await idb.clearLocal();
	});

	test('rotated keyring is picked up on the next attach; pre-rotation rows stay readable', async () => {
		const userId = `user-${crypto.randomUUID()}`;
		const databaseName = `epicenter/${SERVER}/owners/${userId}/encrypted-idb-rotation`;
		const entryV1 = {
			version: 1,
			keyBytesBase64: bytesToBase64(randomBytes(32)),
		};

		const firstDoc = new Y.Doc({ guid: 'encrypted-idb-rotation', gc: true });
		const firstIdb = attachLocalStorage(firstDoc, {
			server: SERVER,
			ownerId: asOwnerId(userId),
			keyring: () => [entryV1],
		});
		await firstIdb.whenLoaded;
		firstDoc.getText('body').insert(0, 'before rotation');
		await tick();
		firstDoc.destroy();
		await firstIdb.whenDisposed;

		// Rotation appends version 2 as the newest entry; version 1 stays in
		// the keyring per the Keyring contract so old rows remain readable.
		const rotatedKeyring: Keyring = [
			entryV1,
			{ version: 2, keyBytesBase64: bytesToBase64(randomBytes(32)) },
		];

		const secondDoc = new Y.Doc({ guid: 'encrypted-idb-rotation', gc: true });
		const secondIdb = attachLocalStorage(secondDoc, {
			server: SERVER,
			ownerId: asOwnerId(userId),
			keyring: () => rotatedKeyring,
		});
		await secondIdb.whenLoaded;

		expect(secondDoc.getText('body').toString()).toBe('before rotation');
		secondDoc.getText('body').insert('before rotation'.length, ' and after');
		await tick();
		secondDoc.destroy();
		await secondIdb.whenDisposed;

		const rawUpdates = await readEncryptedUpdates(databaseName);
		// Blob byte 1 is the key version. First-session rows still carry
		// version 1; everything the second attach wrote carries version 2.
		const versions = rawUpdates.map((update) => update[1]);
		expect(versions).toContain(1);
		expect(versions).toContain(2);
		expect(versions.at(-1)).toBe(2);
		await secondIdb.clearLocal();
	});

	test('clearLocal clears the encrypted IndexedDB database', async () => {
		const userId = `user-${crypto.randomUUID()}`;
		const keyring = toKeyring(randomBytes(32));

		const firstDoc = new Y.Doc({ guid: 'encrypted-idb-clear', gc: true });
		const firstIdb = attachLocalStorage(firstDoc, {
			server: SERVER,
			ownerId: asOwnerId(userId),
			keyring: () => keyring,
		});
		await firstIdb.whenLoaded;
		firstDoc.getText('body').insert(0, 'clear me');
		await tick();
		firstDoc.destroy();
		await firstIdb.whenDisposed;
		await firstIdb.clearLocal();

		const secondDoc = new Y.Doc({ guid: 'encrypted-idb-clear', gc: true });
		const secondIdb = attachLocalStorage(secondDoc, {
			server: SERVER,
			ownerId: asOwnerId(userId),
			keyring: () => keyring,
		});
		await secondIdb.whenLoaded;

		expect(secondDoc.getText('body').toString()).toBe('');
		secondDoc.destroy();
		await secondIdb.whenDisposed;
		await secondIdb.clearLocal();
	});
});

const originalBroadcastChannel = globalThis.BroadcastChannel;

class FakeBroadcastChannel {
	static names: string[] = [];
	onmessage: ((event: MessageEvent) => void) | null = null;

	constructor(public name: string) {
		FakeBroadcastChannel.names.push(name);
	}

	postMessage(_message: unknown): void {}
	close(): void {}
}

describe('attachLocalStorage BroadcastChannel naming', () => {
	beforeEach(() => {
		FakeBroadcastChannel.names = [];
		Object.assign(globalThis, {
			BroadcastChannel:
				FakeBroadcastChannel as unknown as typeof BroadcastChannel,
		});
	});

	afterEach(() => {
		Object.assign(globalThis, { BroadcastChannel: originalBroadcastChannel });
	});

	test('uses an owner-scoped channel key without changing ydoc.guid', () => {
		const ydoc = new Y.Doc({ guid: 'epicenter-fuji' });

		attachLocalStorage(ydoc, {
			server: SERVER,
			ownerId: asOwnerId('user-123'),
			keyring: noKeys,
		});

		// y-indexeddb compatibility: attachBroadcastChannel prepends `yjs.` so
		// channels coordinate with the same name y-indexeddb writes for the
		// shared database. The owner-scoped portion is everything after.
		expect(FakeBroadcastChannel.names).toEqual([
			`yjs.epicenter/${SERVER}/owners/user-123/epicenter-fuji`,
		]);
		expect(ydoc.guid).toBe('epicenter-fuji');
		ydoc.destroy();
	});
});

describe('wipeLocalStorage', () => {
	afterEach(async () => {
		await Promise.all(
			(await databaseNames()).map((name) => deleteDatabase(name)),
		);
	});

	test('clears every database under the (server, ownerId) prefix', async () => {
		await createDatabase(`epicenter/${SERVER}/owners/user-1/doc-a`);
		await createDatabase(`epicenter/${SERVER}/owners/user-1/doc-b`);

		await wipeLocalStorage({
			server: SERVER,
			ownerId: asOwnerId('user-1'),
		});

		const remaining = await databaseNames();
		expect(remaining).not.toContain(`epicenter/${SERVER}/owners/user-1/doc-a`);
		expect(remaining).not.toContain(`epicenter/${SERVER}/owners/user-1/doc-b`);
	});

	test('leaves other owners and unscoped databases alone', async () => {
		await createDatabase(`epicenter/${SERVER}/owners/user-1/doc-a`);
		await createDatabase(`epicenter/${SERVER}/owners/user-2/doc-c`);
		await createDatabase('unscoped-doc');

		await wipeLocalStorage({
			server: SERVER,
			ownerId: asOwnerId('user-1'),
		});

		const remaining = await databaseNames();
		expect(remaining).not.toContain(`epicenter/${SERVER}/owners/user-1/doc-a`);
		expect(remaining).toContain(`epicenter/${SERVER}/owners/user-2/doc-c`);
		expect(remaining).toContain('unscoped-doc');
	});
});

describe('clearLocalStorageForDoc', () => {
	afterEach(async () => {
		await Promise.all(
			(await databaseNames()).map((name) => deleteDatabase(name)),
		);
	});

	test('deletes exactly the one database for the guid', async () => {
		await createDatabase(`epicenter/${SERVER}/owners/user-1/doc-a`);
		await createDatabase(`epicenter/${SERVER}/owners/user-1/doc-b`);

		await clearLocalStorageForDoc({
			server: SERVER,
			ownerId: asOwnerId('user-1'),
			guid: 'doc-a',
		});

		const remaining = await databaseNames();
		expect(remaining).not.toContain(`epicenter/${SERVER}/owners/user-1/doc-a`);
		expect(remaining).toContain(`epicenter/${SERVER}/owners/user-1/doc-b`);
	});

	test('is idempotent: clearing an absent database is a no-op', async () => {
		await expect(
			clearLocalStorageForDoc({
				server: SERVER,
				ownerId: asOwnerId('user-1'),
				guid: 'never-existed',
			}),
		).resolves.toBeUndefined();
	});
});
