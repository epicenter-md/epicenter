import { field } from '@epicenter/data/definition';
/**
 * Browser Store Address Tests
 *
 * A browser application keeps one device document and one retained account
 * replica per account (ADR-0233). These tests pin the addresses that hold them
 * apart: `epicenter/<databaseId>/device` and
 * `epicenter/<databaseId>/account/<principal id>`, one IndexedDB database and
 * one open claim each.
 *
 * Key behaviors:
 * - The device document and two accounts' replicas open at once, into their
 *   own databases, seeing none of each other's rows
 * - A second open of one address is refused with AlreadyOpen, and another
 *   account's address is not that address
 * - Discarding one account replica deletes only that account's sqlite
 * - Every address survives a close-and-reopen, which is the retention that
 *   makes the account scope necessary
 * - An account replica with no account id is refused, never addressed
 * - Both superseded storage shapes are deleted at open, never read
 *
 * Runs under bun with `fake-indexeddb` supplying `indexedDB`; the durability
 * evidence in `evidence/browser/durable-store.ts` proves the same store in a
 * real Chromium across a real reload.
 */
import 'fake-indexeddb/auto';
import { describe, expect, test } from 'bun:test';
import { defineData } from '@epicenter/data/definition';
import { asPrincipalId } from '@epicenter/identity';
import type { Result } from 'wellcrafted/result';
import { expectErr, expectOk as expectOkResult } from 'wellcrafted/testing';

import { openAccount, openDevice } from './browser.js';
import { openMemory } from './bun.js';
import { type DataStoreBase, type DataOf, syncEngineOf } from './store.js';

/** One databaseId per concern, so tests share no IndexedDB state. */
function databaseFor(label: string) {
	return defineData({
		id: `so.epicenter.browsertest.${label}`,
		kv: {},
		tables: { notes: { title: field.string() } },
	});
}

const ALICE = asPrincipalId('alice');
const BOB = asPrincipalId('bob');

function expectOk<TValue, TError>(
	result: Result<TValue, TError> | TValue,
): TValue {
	if (
		typeof result === 'object' &&
		result !== null &&
		'data' in result &&
		'error' in result
	) {
		return expectOkResult(result as Result<TValue, TError>);
	}
	return result as TValue;
}

const deviceAddress = (databaseId: string) => `epicenter/${databaseId}/device`;
const accountAddress = (databaseId: string, principalId: string) =>
	`epicenter/${databaseId}/account/${principalId}`;

const openDeviceData = (definition: ReturnType<typeof databaseFor>) =>
	openDevice(definition);
const openAccountData = (
	definition: ReturnType<typeof databaseFor>,
	principalId: typeof ALICE,
) => openAccount(definition, { principalId });

function titles(app: {
	tables: {
		notes: { list(): { rows: { title: string }[] } };
	};
}): string[] {
	return app.tables.notes
		.list()
		.rows.map((row) => row.title)
		.sort();
}

async function databaseNames(): Promise<string[]> {
	const databases = await indexedDB.databases();
	return databases
		.map((sqlite) => sqlite.name)
		.filter((name): name is string => name !== undefined)
		.sort();
}

describe('one device document and one account replica per account', () => {
	test('the device document and two accounts open at once, into their own databases', async () => {
		const database = databaseFor('pair');
		const device = expectOk(await openDeviceData(database));
		const alice = expectOk(await openAccountData(database, ALICE));
		const bob = expectOk(await openAccountData(database, BOB));

		expectOk(device.tables.notes.create({ title: 'mine alone' }));
		expectOk(alice.tables.notes.create({ title: "alice's" }));
		expectOk(bob.tables.notes.create({ title: "bob's" }));
		expect(titles(device)).toEqual(['mine alone']);
		expect(titles(alice)).toEqual(["alice's"]);
		expect(titles(bob)).toEqual(["bob's"]);

		const names = await databaseNames();
		expect(names).toContain(deviceAddress(database.id));
		expect(names).toContain(accountAddress(database.id, ALICE));
		expect(names).toContain(accountAddress(database.id, BOB));

		await device.store[Symbol.asyncDispose]();
		await alice.store[Symbol.asyncDispose]();
		await bob.store[Symbol.asyncDispose]();
	});

	test('a second open of one address is refused, and another account is not that address', async () => {
		const database = databaseFor('claim');
		const alice = expectOk(await openAccountData(database, ALICE));
		const again = expectErr(await openAccountData(database, ALICE));
		expect(again.name).toBe('AlreadyOpen');

		// Another account's replica is a different document, so it opens.
		const bob = expectOk(await openAccountData(database, BOB));
		await bob.store[Symbol.asyncDispose]();
		await alice.store[Symbol.asyncDispose]();

		// Disposal releases the claim, so the same address opens again.
		const reopened = expectOk(await openAccountData(database, ALICE));
		await reopened.store[Symbol.asyncDispose]();
	});

	test('every address survives a close-and-reopen under its own name', async () => {
		const database = databaseFor('reopen');
		// Widened to the base store kind: a device document and an account
		// replica differ only in their `sync` value, which this test never
		// touches.
		const owners: [
			() => Promise<
				Result<
					DataOf<ReturnType<typeof databaseFor>, DataStoreBase>,
					unknown
				>
			>,
			string,
		][] = [
			[() => openDeviceData(database), 'kept device work'],
			[() => openAccountData(database, ALICE), "kept alice's"],
			[() => openAccountData(database, BOB), "kept bob's"],
		];
		for (const [openDocument, title] of owners) {
			const opened = expectOk(await openDocument());
			expectOk(opened.tables.notes.create({ title }));
			await opened.store[Symbol.asyncDispose]();
		}

		// Retention is the whole reason the account is in the address: coming
		// back to an account finds that account's replica, not the last one to
		// have been open.
		const device = expectOk(await openDeviceData(database));
		const alice = expectOk(await openAccountData(database, ALICE));
		const bob = expectOk(await openAccountData(database, BOB));
		expect(titles(device)).toEqual(['kept device work']);
		expect(titles(alice)).toEqual(["kept alice's"]);
		expect(titles(bob)).toEqual(["kept bob's"]);
		await device.store[Symbol.asyncDispose]();
		await alice.store[Symbol.asyncDispose]();
		await bob.store[Symbol.asyncDispose]();
	});

	test('discarding one account replica deletes only that account database', async () => {
		const database = databaseFor('discard');
		{
			const device = expectOk(await openDeviceData(database));
			expectOk(device.tables.notes.create({ title: 'device work' }));
			await device.store[Symbol.asyncDispose]();

			const bob = expectOk(await openAccountData(database, BOB));
			expectOk(bob.tables.notes.create({ title: "bob's work" }));
			await bob.store[Symbol.asyncDispose]();
		}

		const alice = expectOk(await openAccountData(database, ALICE));
		expectOk(alice.tables.notes.create({ title: 'doomed replica' }));
		expectOk(await alice.store.discard());

		const names = await databaseNames();
		expect(names).not.toContain(accountAddress(database.id, ALICE));
		expect(names).toContain(accountAddress(database.id, BOB));
		expect(names).toContain(deviceAddress(database.id));

		// Alice rejoins at zero; nobody else moved.
		const rejoined = expectOk(await openAccountData(database, ALICE));
		expect(titles(rejoined)).toEqual([]);
		await rejoined.store[Symbol.asyncDispose]();
		const bob = expectOk(await openAccountData(database, BOB));
		expect(titles(bob)).toEqual(["bob's work"]);
		await bob.store[Symbol.asyncDispose]();
		const device = expectOk(await openDeviceData(database));
		expect(titles(device)).toEqual(['device work']);
		await device.store[Symbol.asyncDispose]();
	});

	test('an account replica with no account id is refused, and no database is made for it', async () => {
		const database = databaseFor('unaddressable');
		const before = await databaseNames();

		const refused = expectErr(
			await openAccount(database, { principalId: asPrincipalId('   ') }),
		);
		expect(refused.name).toBe('Unaddressable');
		expect(await databaseNames()).toEqual(before);

		// And the refusal held no claim, so a real account still opens.
		const alice = expectOk(await openAccountData(database, ALICE));
		await alice.store[Symbol.asyncDispose]();
	});
});

describe('the durable facts live in IndexedDB directly (ADR-0238)', () => {
	/** Fabricate the superseded version-1 checkpoint record at an address. */
	function seedVersionOne(
		address: string,
		checkpoint: Record<string, unknown>,
	): Promise<void> {
		return new Promise((resolve, reject) => {
			const request = indexedDB.open(address, 1);
			request.onupgradeneeded = () => {
				request.result.createObjectStore('state');
			};
			request.onsuccess = () => {
				const sqlite = request.result;
				const transaction = sqlite.transaction('state', 'readwrite');
				transaction.objectStore('state').put(checkpoint, 'durable');
				transaction.oncomplete = () => {
					sqlite.close();
					resolve();
				};
				transaction.onerror = () => reject(transaction.error);
			};
			request.onerror = () => reject(request.error);
		});
	}

	/** How many rows one object store holds, read outside any store handle. */
	function countRows(address: string, storeName: string): Promise<number> {
		return new Promise((resolve, reject) => {
			const request = indexedDB.open(address);
			request.onsuccess = () => {
				const sqlite = request.result;
				const transaction = sqlite.transaction(storeName, 'readonly');
				const count = transaction.objectStore(storeName).count();
				count.onsuccess = () => {
					sqlite.close();
					resolve(count.result);
				};
				count.onerror = () => reject(count.error);
			};
			request.onerror = () => reject(request.error);
		});
	}

	test('a record certified under an earlier format is wiped whole, never migrated (ADR-0248)', async () => {
		// The clean break: format '2' kept row documents nested inside the
		// application document and its outbox rows carry no document address,
		// so nothing from it is readable under '3'. The wipe is the cutover,
		// and a replica refills from its authority.
		const database = databaseFor('formatbreak');
		const author = openMemory(database);
		expectOk(author.tables.notes.create({ title: 'pre-break note' }));
		const bytes = author.store.encodeStateSince();
		await author.store[Symbol.asyncDispose]();

		await seedVersionOne(accountAddress(database.id, ALICE), {
			updates: [{ seq: 1, bytes }],
			outbox: [{ id: 3, bytes }],
			cursor: 5,
			format: '2',
			document: 'doc-9',
		});

		const replica = expectOk(await openAccountData(database, ALICE));
		try {
			expect(titles(replica)).toEqual([]);
			expect(syncEngineOf(replica.store).cursor()).toBe(0);
			expect(syncEngineOf(replica.store).documentIdentity()).toBeUndefined();
			expect(syncEngineOf(replica.store).coalesce()).toBeUndefined();
		} finally {
			await replica.store[Symbol.asyncDispose]();
		}
	});

	test('an uncertified version-1 checkpoint is wiped whole, never merged (ADR-0231)', async () => {
		const database = databaseFor('uncertified');
		const author = openMemory(database);
		expectOk(author.tables.notes.create({ title: 'pre-identity work' }));
		const bytes = author.store.encodeStateSince();
		await author.store[Symbol.asyncDispose]();

		await seedVersionOne(`epicenter/${database.id}/device`, {
			updates: [{ seq: 1, bytes }],
			outbox: [],
			cursor: 4,
			// No `format`: the record predates the document identity.
		});

		const device = expectOk(await openDeviceData(database));
		expect(titles(device)).toEqual([]);
		await device.store[Symbol.asyncDispose]();
	});

	test('the update log folds at the threshold instead of growing forever', async () => {
		const database = databaseFor('fold');
		const address = `epicenter/${database.id}/device`;
		const device = expectOk(await openDeviceData(database));
		for (let index = 0; index < 70; index += 1) {
			expectOk(device.tables.notes.create({ title: `note ${index}` }));
		}
		await device.store.persistence.flush();
		expect(device.store.persistence.get()).toBe('saved');
		await device.store[Symbol.asyncDispose]();

		expect(await countRows(address, 'updates')).toBeLessThan(70);

		const reopened = expectOk(await openDeviceData(database));
		expect(titles(reopened)).toHaveLength(70);
		await reopened.store[Symbol.asyncDispose]();
	});
});

describe('the clean break: storage from before the account-scoped address', () => {
	/** Fabricate one superseded database with something inside it. */
	function seedSupersededDatabase(name: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const request = indexedDB.open(name, 1);
			request.onupgradeneeded = () => {
				request.result.createObjectStore('state');
			};
			request.onsuccess = () => {
				const sqlite = request.result;
				const transaction = sqlite.transaction('state', 'readwrite');
				transaction
					.objectStore('state')
					.put({ updates: [], outbox: [], cursor: 7 }, 'durable');
				transaction.oncomplete = () => {
					sqlite.close();
					resolve();
				};
				transaction.onerror = () => reject(transaction.error);
			};
			request.onerror = () => reject(request.error);
		});
	}

	function supersededNames(databaseId: string): string[] {
		return [
			`epicenter-store-${databaseId}`,
			`epicenter-store-${databaseId}#private`,
			`epicenter-store-${databaseId}#database`,
		];
	}

	test('opening an owner deletes its superseded storage and reads nothing from it', async () => {
		const database = databaseFor('superseded');
		for (const name of supersededNames(database.id)) {
			await seedSupersededDatabase(name);
		}
		const oldDevice = `epicenter/${database.id}/private`;
		await seedSupersededDatabase(oldDevice);
		expect(await databaseNames()).toEqual(
			expect.arrayContaining(supersededNames(database.id)),
		);

		const device = expectOk(await openDeviceData(database));
		expect(titles(device)).toEqual([]);
		for (const name of supersededNames(database.id)) {
			expect(await databaseNames()).not.toContain(name);
		}
		expect(await databaseNames()).not.toContain(oldDevice);
		await device.store[Symbol.asyncDispose]();

		// The deletion repeats at every open, so a superseded database
		// reappearing (an old tab writing after this one deleted) dies at the
		// next boot too.
		for (const name of supersededNames(database.id)) {
			await seedSupersededDatabase(name);
		}
		const oldAlice = `epicenter/${database.id}/database/${ALICE}`;
		await seedSupersededDatabase(oldAlice);
		const alice = expectOk(await openAccountData(database, ALICE));
		expect(titles(alice)).toEqual([]);
		for (const name of supersededNames(database.id)) {
			expect(await databaseNames()).not.toContain(name);
		}
		expect(await databaseNames()).not.toContain(oldAlice);
		await alice.store[Symbol.asyncDispose]();
	});
});
