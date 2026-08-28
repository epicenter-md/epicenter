import { field } from '@epicenter/data/definition';
/**
 * Browser Store Address Tests
 *
 * A browser application keeps one local document and one retained account
 * replica per server identity (ADR-0261). These tests pin the addresses that
 * hold them apart: `epicenter/v1/<dataId>/local` and
 * `epicenter/v1/<dataId>/account/<base URL>/<principal id>`, one IndexedDB
 * database and one open claim each.
 *
 * Key behaviors:
 * - The local document and two accounts' replicas open at once, into their
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
import { installTestLocks } from './test-locks.js';

installTestLocks();
import { describe, expect, test } from 'bun:test';
import { defineData } from '@epicenter/data/definition';
import { asPrincipalId } from '@epicenter/identity';
import type { Result } from 'wellcrafted/result';
import { expectErr, expectOk as expectOkResult } from 'wellcrafted/testing';

import { openAccount, openLocal } from './browser.js';
import { openMemory } from './memory.js';
import { type DataOf, type DataStoreBase, syncEngineOf } from './store.js';

/** One dataId per concern, so tests share no IndexedDB state. */
function databaseFor(label: string) {
	return defineData({
		id: `so.epicenter.browsertest.${label}`,
		kv: {},
		tables: { notes: { fields: { title: field.string() } } },
	});
}

const ALICE = asPrincipalId('alice');
const BOB = asPrincipalId('bob');
const CLOUD = 'https://api.epicenter.so';
const OTHER_SERVER = 'https://home.example.com';

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

const localAddress = (dataId: string) =>
	`epicenter/v1/${dataId}/local`;
const accountAddress = (
	dataId: string,
	baseURL: string,
	principalId: string,
) =>
	`epicenter/v1/${dataId}/account/${encodeURIComponent(baseURL)}/${encodeURIComponent(principalId)}`;

const openLocalData = (definition: ReturnType<typeof databaseFor>) =>
	openLocal(definition);
const openAccountData = (
	definition: ReturnType<typeof databaseFor>,
	principalId: typeof ALICE | typeof BOB,
	baseURL = CLOUD,
) => openAccount(definition, { baseURL, principalId });

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

describe('one local document and one account replica per account', () => {
	test('the local document and two accounts open at once, into their own databases', async () => {
		const database = databaseFor('pair');
		const local = expectOk(await openLocalData(database));
		const alice = expectOk(await openAccountData(database, ALICE));
		const bob = expectOk(await openAccountData(database, BOB));

		expectOk(local.tables.notes.create({ title: 'mine alone' }));
		expectOk(alice.tables.notes.create({ title: "alice's" }));
		expectOk(bob.tables.notes.create({ title: "bob's" }));
		expect(titles(local)).toEqual(['mine alone']);
		expect(titles(alice)).toEqual(["alice's"]);
		expect(titles(bob)).toEqual(["bob's"]);

		const names = await databaseNames();
		expect(names).toContain(localAddress(database.id));
		expect(names).toContain(accountAddress(database.id, CLOUD, ALICE));
		expect(names).toContain(accountAddress(database.id, CLOUD, BOB));

		await local.store[Symbol.asyncDispose]();
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

	test('the same principal on two servers gets two retained replicas', async () => {
		const database = databaseFor('servers');
		const cloud = expectOk(await openAccountData(database, ALICE, CLOUD));
		const selfHosted = expectOk(
			await openAccountData(database, ALICE, OTHER_SERVER),
		);

		expectOk(cloud.tables.notes.create({ title: 'cloud work' }));
		expectOk(selfHosted.tables.notes.create({ title: 'self-hosted work' }));
		expect(titles(cloud)).toEqual(['cloud work']);
		expect(titles(selfHosted)).toEqual(['self-hosted work']);

		const names = await databaseNames();
		expect(names).toContain(accountAddress(database.id, CLOUD, ALICE));
		expect(names).toContain(accountAddress(database.id, OTHER_SERVER, ALICE));

		await cloud.store[Symbol.asyncDispose]();
		await selfHosted.store[Symbol.asyncDispose]();
	});

	test('equivalent server URL spellings reuse one retained replica', async () => {
		const database = databaseFor('canonical-url');
		const first = expectOk(
			await openAccountData(database, ALICE, `${CLOUD}/?ignored=true#ignored`),
		);
		expectOk(first.tables.notes.create({ title: 'kept work' }));
		await first.store[Symbol.asyncDispose]();

		const equivalent = expectOk(
			await openAccountData(database, ALICE, `${CLOUD}/`),
		);
		expect(titles(equivalent)).toEqual(['kept work']);
		expect(await databaseNames()).toContain(
			accountAddress(database.id, CLOUD, ALICE),
		);
		await equivalent.store[Symbol.asyncDispose]();
	});

	test('every address survives a close-and-reopen under its own name', async () => {
		const database = databaseFor('reopen');
		// Widened to the base store kind: a local document and an account
		// replica differ only in their `sync` value, which this test never
		// touches.
		const owners: [
			() => Promise<
				Result<DataOf<ReturnType<typeof databaseFor>, DataStoreBase>, unknown>
			>,
			string,
		][] = [
			[() => openLocalData(database), 'kept local work'],
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
		const local = expectOk(await openLocalData(database));
		const alice = expectOk(await openAccountData(database, ALICE));
		const bob = expectOk(await openAccountData(database, BOB));
		expect(titles(local)).toEqual(['kept local work']);
		expect(titles(alice)).toEqual(["kept alice's"]);
		expect(titles(bob)).toEqual(["kept bob's"]);
		await local.store[Symbol.asyncDispose]();
		await alice.store[Symbol.asyncDispose]();
		await bob.store[Symbol.asyncDispose]();
	});

	test('discarding one account replica deletes only that account database', async () => {
		const database = databaseFor('discard');
		{
			const local = expectOk(await openLocalData(database));
			expectOk(local.tables.notes.create({ title: 'device work' }));
			await local.store[Symbol.asyncDispose]();

			const bob = expectOk(await openAccountData(database, BOB));
			expectOk(bob.tables.notes.create({ title: "bob's work" }));
			await bob.store[Symbol.asyncDispose]();
		}

		const alice = expectOk(await openAccountData(database, ALICE));
		expectOk(alice.tables.notes.create({ title: 'doomed replica' }));
		expectOk(await alice.store.discard());

		const names = await databaseNames();
		expect(names).not.toContain(accountAddress(database.id, CLOUD, ALICE));
		expect(names).toContain(accountAddress(database.id, CLOUD, BOB));
		expect(names).toContain(localAddress(database.id));

		// Alice rejoins at zero; nobody else moved.
		const rejoined = expectOk(await openAccountData(database, ALICE));
		expect(titles(rejoined)).toEqual([]);
		await rejoined.store[Symbol.asyncDispose]();
		const bob = expectOk(await openAccountData(database, BOB));
		expect(titles(bob)).toEqual(["bob's work"]);
		await bob.store[Symbol.asyncDispose]();
		const local = expectOk(await openLocalData(database));
		expect(titles(local)).toEqual(['device work']);
		await local.store[Symbol.asyncDispose]();
	});

	test('an account replica with no identity is refused, and no database is made for it', async () => {
		const database = databaseFor('unaddressable');
		const before = await databaseNames();

		const refused = expectErr(
			await openAccount(database, {
				baseURL: CLOUD,
				principalId: asPrincipalId('   '),
			}),
		);
		expect(refused.name).toBe('Unaddressable');
		expect(await databaseNames()).toEqual(before);

		const malformed = expectErr(
			await openAccount(database, {
				baseURL: 'not a URL',
				principalId: ALICE,
			}),
		);
		expect(malformed.name).toBe('Unaddressable');
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

		await seedVersionOne(accountAddress(database.id, CLOUD, ALICE), {
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

		await seedVersionOne(`epicenter/v1/${database.id}/local`, {
			updates: [{ seq: 1, bytes }],
			outbox: [],
			cursor: 4,
			// No `format`: the record predates the document identity.
		});

		const local = expectOk(await openLocalData(database));
		expect(titles(local)).toEqual([]);
		await local.store[Symbol.asyncDispose]();
	});

	test('the update log folds at the threshold instead of growing forever', async () => {
		const database = databaseFor('fold');
		const address = localAddress(database.id);
		const local = expectOk(await openLocalData(database));
		for (let index = 0; index < 70; index += 1) {
			expectOk(local.tables.notes.create({ title: `note ${index}` }));
		}
		await local.store.persistence.flush();
		expect(local.store.persistence.get()).toBe('saved');
		await local.store[Symbol.asyncDispose]();

		expect(await countRows(address, 'updates')).toBeLessThan(70);

		const reopened = expectOk(await openLocalData(database));
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

	function supersededNames(dataId: string): string[] {
		return [
			`epicenter-store-${dataId}`,
			`epicenter-store-${dataId}#private`,
			`epicenter-store-${dataId}#database`,
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

		const local = expectOk(await openLocalData(database));
		expect(titles(local)).toEqual([]);
		for (const name of supersededNames(database.id)) {
			expect(await databaseNames()).not.toContain(name);
		}
		expect(await databaseNames()).not.toContain(oldDevice);
		await local.store[Symbol.asyncDispose]();

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

describe('a boot that cannot proceed refuses, and holds no claim after it', () => {
	/**
	 * Write one undecodable update into a record certified under the current
	 * format, so the format rule keeps it and the hydration replay meets it.
	 */
	function seedCorruptChain(address: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const request = indexedDB.open(address, 4);
			request.onupgradeneeded = () => {
				for (const name of ['updates', 'tombstones', 'identity']) {
					request.result.createObjectStore(name);
				}
			};
			request.onsuccess = () => {
				const sqlite = request.result;
				const transaction = sqlite.transaction(['updates'], 'readwrite');
				transaction.objectStore('updates').put(
					{
						document: 'app',
						bytes: new Uint8Array([1, 2, 3, 4, 5]),
						authoritySeq: null,
					},
					1,
				);
				transaction.oncomplete = () => {
					sqlite.close();
					resolve();
				};
				transaction.onerror = () => reject(transaction.error);
			};
			request.onerror = () => reject(request.error);
		});
	}

	test('a definition that will not parse releases the id it claimed', async () => {
		const database = databaseFor('unparseable');
		// A declaration may arrive as data, so a refusal here is a boot outcome
		// rather than a programmer error. The store this half-opened must
		// release its address, or the application can never start.
		const refused = await openLocal({
			dataId: database.id,
			tables: { notes: { fields: {} } },
		} as never);
		expect(refused.error).not.toBeNull();

		const after = expectOk(await openLocalData(database));
		await after.store[Symbol.asyncDispose]();
	});

	test('a corrupt durable record refuses the boot and releases the claim', async () => {
		const database = databaseFor('corrupt');
		await seedCorruptChain(localAddress(database.id));

		const refused = await openLocal(database);
		expect(refused.data).toBeNull();
		expect(refused.error?.name).toBe('StorageFailed');

		// The claim went with the refusal: a retry reports the same honest
		// failure rather than `AlreadyOpen` for the life of the page.
		const again = await openLocal(database);
		expect(again.error?.name).toBe('StorageFailed');
	});
});

describe('the document a row inherently owns survives a reopen (ADR-0248)', () => {
	test('application-named roots come back with what was typed into them', async () => {
		const database = databaseFor('rowdocument');
		let rowId!: string;
		{
			const local = expectOk(await openLocalData(database));
			rowId = expectOk(local.tables.notes.create({ title: 'x' })).id;
			const opened = expectOk(await local.tables.notes.openDocument(rowId));
			if (opened === undefined) throw new Error('the row has no document');
			// The application names its root and picks its format. In Yjs 14
			// `change` hands back a fresh builder and `applyDelta` commits it.
			const editor = opened.get('editor', 'text');
			editor.applyDelta(editor.change.insert('buy milk') as never);
			opened.get('meta').setAttr('cursor' as never, 8 as never);
			opened[Symbol.dispose]();
			await local.store[Symbol.asyncDispose]();
		}

		const reopened = expectOk(await openLocalData(database));
		const opened = expectOk(await reopened.tables.notes.openDocument(rowId));
		expect(opened?.get('editor', 'text').toString()).toContain('buy milk');
		expect(opened?.get('meta').getAttr('cursor' as never)).toBe(8);
		opened?.[Symbol.dispose]();
		await reopened.store[Symbol.asyncDispose]();
	});
});
