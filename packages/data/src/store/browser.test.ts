/**
 * Browser Store Address Tests
 *
 * A browser application keeps one device document and one retained account
 * replica per account (ADR-0233). These tests pin the addresses that hold them
 * apart: `epicenter/<workspaceId>/device` and
 * `epicenter/<workspaceId>/account/<principal id>`, one IndexedDB database and
 * one open claim each.
 *
 * Key behaviors:
 * - The device document and two accounts' replicas open at once, into their
 *   own databases, seeing none of each other's rows
 * - A second open of one address is refused with AlreadyOpen, and another
 *   account's address is not that address
 * - Discarding one account replica deletes only that account's database
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
import { asPrincipalId } from '@epicenter/identity';
import { defineWorkspace } from '@epicenter/workspace';
import type { Result } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';

import { openAccount, openDevice } from './browser.js';
import { openMemory } from './bun.js';
import { STORE_FORMAT } from './log.js';
import { type DataOf, syncEngineOf, type WorkspaceStoreBase } from './store.js';

/** One workspaceId per concern, so tests share no IndexedDB state. */
function workspaceFor(label: string) {
	return defineWorkspace({
		id: `so.epicenter.browsertest.${label}`,
		tables: { notes: { title: 'string' } },
	});
}

const ALICE = asPrincipalId('alice');
const BOB = asPrincipalId('bob');

const deviceAddress = (workspaceId: string) =>
	`epicenter/${workspaceId}/device`;
const accountAddress = (workspaceId: string, principalId: string) =>
	`epicenter/${workspaceId}/account/${principalId}`;

const openDeviceData = (workspace: ReturnType<typeof workspaceFor>) =>
	openDevice(workspace);
const openAccountData = (
	workspace: ReturnType<typeof workspaceFor>,
	principalId: typeof ALICE,
) => openAccount(workspace, { principalId });

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
		.map((database) => database.name)
		.filter((name): name is string => name !== undefined)
		.sort();
}

describe('one device document and one account replica per account', () => {
	test('the device document and two accounts open at once, into their own databases', async () => {
		const workspace = workspaceFor('pair');
		const device = expectOk(await openDeviceData(workspace));
		const alice = expectOk(await openAccountData(workspace, ALICE));
		const bob = expectOk(await openAccountData(workspace, BOB));

		expectOk(device.tables.notes.create({ title: 'mine alone' }));
		expectOk(alice.tables.notes.create({ title: "alice's" }));
		expectOk(bob.tables.notes.create({ title: "bob's" }));
		expect(titles(device)).toEqual(['mine alone']);
		expect(titles(alice)).toEqual(["alice's"]);
		expect(titles(bob)).toEqual(["bob's"]);

		const names = await databaseNames();
		expect(names).toContain(deviceAddress(workspace.id));
		expect(names).toContain(accountAddress(workspace.id, ALICE));
		expect(names).toContain(accountAddress(workspace.id, BOB));

		await device[Symbol.asyncDispose]();
		await alice[Symbol.asyncDispose]();
		await bob[Symbol.asyncDispose]();
	});

	test('a second open of one address is refused, and another account is not that address', async () => {
		const workspace = workspaceFor('claim');
		const alice = expectOk(await openAccountData(workspace, ALICE));
		const again = expectErr(await openAccountData(workspace, ALICE));
		expect(again.name).toBe('AlreadyOpen');

		// Another account's replica is a different document, so it opens.
		const bob = expectOk(await openAccountData(workspace, BOB));
		await bob[Symbol.asyncDispose]();
		await alice[Symbol.asyncDispose]();

		// Disposal releases the claim, so the same address opens again.
		const reopened = expectOk(await openAccountData(workspace, ALICE));
		await reopened[Symbol.asyncDispose]();
	});

	test('every address survives a close-and-reopen under its own name', async () => {
		const workspace = workspaceFor('reopen');
		// Widened to the base store kind: a device document and an account
		// replica differ only in their `sync` value, which this test never
		// touches.
		const owners: [
			() => Promise<
				Result<
					DataOf<ReturnType<typeof workspaceFor>, WorkspaceStoreBase>,
					unknown
				>
			>,
			string,
		][] = [
			[() => openDeviceData(workspace), 'kept device work'],
			[() => openAccountData(workspace, ALICE), "kept alice's"],
			[() => openAccountData(workspace, BOB), "kept bob's"],
		];
		for (const [openDocument, title] of owners) {
			const opened = expectOk(await openDocument());
			expectOk(opened.tables.notes.create({ title }));
			await opened[Symbol.asyncDispose]();
		}

		// Retention is the whole reason the account is in the address: coming
		// back to an account finds that account's replica, not the last one to
		// have been open.
		const device = expectOk(await openDeviceData(workspace));
		const alice = expectOk(await openAccountData(workspace, ALICE));
		const bob = expectOk(await openAccountData(workspace, BOB));
		expect(titles(device)).toEqual(['kept device work']);
		expect(titles(alice)).toEqual(["kept alice's"]);
		expect(titles(bob)).toEqual(["kept bob's"]);
		await device[Symbol.asyncDispose]();
		await alice[Symbol.asyncDispose]();
		await bob[Symbol.asyncDispose]();
	});

	test('discarding one account replica deletes only that account database', async () => {
		const workspace = workspaceFor('discard');
		{
			const device = expectOk(await openDeviceData(workspace));
			expectOk(device.tables.notes.create({ title: 'device work' }));
			await device[Symbol.asyncDispose]();

			const bob = expectOk(await openAccountData(workspace, BOB));
			expectOk(bob.tables.notes.create({ title: "bob's work" }));
			await bob[Symbol.asyncDispose]();
		}

		const alice = expectOk(await openAccountData(workspace, ALICE));
		expectOk(alice.tables.notes.create({ title: 'doomed replica' }));
		expectOk(await alice.store.discard());

		const names = await databaseNames();
		expect(names).not.toContain(accountAddress(workspace.id, ALICE));
		expect(names).toContain(accountAddress(workspace.id, BOB));
		expect(names).toContain(deviceAddress(workspace.id));

		// Alice rejoins at zero; nobody else moved.
		const rejoined = expectOk(await openAccountData(workspace, ALICE));
		expect(titles(rejoined)).toEqual([]);
		await rejoined[Symbol.asyncDispose]();
		const bob = expectOk(await openAccountData(workspace, BOB));
		expect(titles(bob)).toEqual(["bob's work"]);
		await bob[Symbol.asyncDispose]();
		const device = expectOk(await openDeviceData(workspace));
		expect(titles(device)).toEqual(['device work']);
		await device[Symbol.asyncDispose]();
	});

	test('an account replica with no account id is refused, and no database is made for it', async () => {
		const workspace = workspaceFor('unaddressable');
		const before = await databaseNames();

		const refused = expectErr(
			await openAccount(workspace, { principalId: asPrincipalId('   ') }),
		);
		expect(refused.name).toBe('Unaddressable');
		expect(await databaseNames()).toEqual(before);

		// And the refusal held no claim, so a real account still opens.
		const alice = expectOk(await openAccountData(workspace, ALICE));
		await alice[Symbol.asyncDispose]();
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
				const database = request.result;
				const transaction = database.transaction('state', 'readwrite');
				transaction.objectStore('state').put(checkpoint, 'durable');
				transaction.oncomplete = () => {
					database.close();
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
				const database = request.result;
				const transaction = database.transaction(storeName, 'readonly');
				const count = transaction.objectStore(storeName).count();
				count.onsuccess = () => {
					database.close();
					resolve(count.result);
				};
				count.onerror = () => reject(count.error);
			};
			request.onerror = () => reject(request.error);
		});
	}

	test('a certified version-1 checkpoint migrates into the new object stores', async () => {
		const workspace = workspaceFor('migration');
		// Real update bytes for this workspace, authored by a store of the same shape.
		const author = openMemory(workspace);
		expectOk(author.tables.notes.create({ title: 'migrated note' }));
		const bytes = author.store.encodeStateSince();
		await author[Symbol.asyncDispose]();

		await seedVersionOne(`epicenter/${workspace.id}/device`, {
			updates: [{ seq: 1, bytes }],
			outbox: [],
			cursor: 0,
			format: STORE_FORMAT,
		});

		const device = expectOk(await openDeviceData(workspace));
		expect(titles(device)).toEqual(['migrated note']);
		await device[Symbol.asyncDispose]();

		// And the migrated record round-trips through the new layout.
		const reopened = expectOk(await openDeviceData(workspace));
		expect(titles(reopened)).toEqual(['migrated note']);
		await reopened[Symbol.asyncDispose]();
	});

	test('a version-1 checkpoint migrates its outbox, cursor, and identity too', async () => {
		const workspace = workspaceFor('migrationfacts');
		const author = openMemory(workspace);
		expectOk(author.tables.notes.create({ title: 'owed note' }));
		const bytes = author.store.encodeStateSince();
		await author[Symbol.asyncDispose]();

		await seedVersionOne(accountAddress(workspace.id, ALICE), {
			updates: [{ seq: 1, bytes }],
			outbox: [{ id: 3, bytes }],
			cursor: 5,
			format: STORE_FORMAT,
			document: 'doc-9',
		});

		const replica = expectOk(await openAccountData(workspace, ALICE));
		try {
			expect(titles(replica)).toEqual(['owed note']);
			// The replication facts crossed whole: what is owed, how far this
			// replica has read, and which document it is entangled with.
			expect(syncEngineOf(replica.store).cursor()).toBe(5);
			expect(syncEngineOf(replica.store).documentIdentity()).toBe('doc-9');
			expect(syncEngineOf(replica.store).coalesce()?.id).toBe(3);
		} finally {
			await replica[Symbol.asyncDispose]();
		}
	});

	test('an uncertified version-1 checkpoint is wiped whole, never merged (ADR-0231)', async () => {
		const workspace = workspaceFor('uncertified');
		const author = openMemory(workspace);
		expectOk(author.tables.notes.create({ title: 'pre-identity work' }));
		const bytes = author.store.encodeStateSince();
		await author[Symbol.asyncDispose]();

		await seedVersionOne(`epicenter/${workspace.id}/device`, {
			updates: [{ seq: 1, bytes }],
			outbox: [],
			cursor: 4,
			// No `format`: the record predates the document identity.
		});

		const device = expectOk(await openDeviceData(workspace));
		expect(titles(device)).toEqual([]);
		await device[Symbol.asyncDispose]();
	});

	test('the update log folds at the threshold instead of growing forever', async () => {
		const workspace = workspaceFor('fold');
		const address = `epicenter/${workspace.id}/device`;
		const device = expectOk(await openDeviceData(workspace));
		for (let index = 0; index < 70; index += 1) {
			expectOk(device.tables.notes.create({ title: `note ${index}` }));
		}
		await device.store.persistence.flush();
		expect(device.store.persistence.get()).toBe('saved');
		await device[Symbol.asyncDispose]();

		expect(await countRows(address, 'updates')).toBeLessThan(70);

		const reopened = expectOk(await openDeviceData(workspace));
		expect(titles(reopened)).toHaveLength(70);
		await reopened[Symbol.asyncDispose]();
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
				const database = request.result;
				const transaction = database.transaction('state', 'readwrite');
				transaction
					.objectStore('state')
					.put({ updates: [], outbox: [], cursor: 7 }, 'durable');
				transaction.oncomplete = () => {
					database.close();
					resolve();
				};
				transaction.onerror = () => reject(transaction.error);
			};
			request.onerror = () => reject(request.error);
		});
	}

	function supersededNames(workspaceId: string): string[] {
		return [
			`epicenter-store-${workspaceId}`,
			`epicenter-store-${workspaceId}#private`,
			`epicenter-store-${workspaceId}#workspace`,
		];
	}

	test('opening an owner deletes its superseded storage and reads nothing from it', async () => {
		const workspace = workspaceFor('superseded');
		for (const name of supersededNames(workspace.id)) {
			await seedSupersededDatabase(name);
		}
		const oldDevice = `epicenter/${workspace.id}/private`;
		await seedSupersededDatabase(oldDevice);
		expect(await databaseNames()).toEqual(
			expect.arrayContaining(supersededNames(workspace.id)),
		);

		const device = expectOk(await openDeviceData(workspace));
		expect(titles(device)).toEqual([]);
		for (const name of supersededNames(workspace.id)) {
			expect(await databaseNames()).not.toContain(name);
		}
		expect(await databaseNames()).not.toContain(oldDevice);
		await device[Symbol.asyncDispose]();

		// The deletion repeats at every open, so a superseded database
		// reappearing (an old tab writing after this one deleted) dies at the
		// next boot too.
		for (const name of supersededNames(workspace.id)) {
			await seedSupersededDatabase(name);
		}
		const oldAlice = `epicenter/${workspace.id}/workspace/${ALICE}`;
		await seedSupersededDatabase(oldAlice);
		const alice = expectOk(await openAccountData(workspace, ALICE));
		expect(titles(alice)).toEqual([]);
		for (const name of supersededNames(workspace.id)) {
			expect(await databaseNames()).not.toContain(name);
		}
		expect(await databaseNames()).not.toContain(oldAlice);
		await alice[Symbol.asyncDispose]();
	});
});
