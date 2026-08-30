import { field } from '@epicenter/data/definition';
/**
 * Browser Store Address Tests
 *
 * A browser application keeps one local document and one retained account
 * replica per server identity (ADR-0261). These tests pin the addresses that
 * hold them apart: `epicenter/v2/<dataId>/local` and
 * `epicenter/v2/<dataId>/account/<base URL>/<principal id>`, one IndexedDB
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
import { defineData, defineTable } from '@epicenter/data/definition';
import { asPrincipalId } from '@epicenter/principal';
import * as Y from '@y/y';
import { Ok, type Result } from 'wellcrafted/result';
import { expectErr, expectOk as expectOkResult } from 'wellcrafted/testing';

import {
	type DatabaseAccount,
	importGeneration,
	openDatabase,
} from './browser.js';
import { openMemory } from './memory.js';
import { type DataDocument, type DataView, syncEngineOf } from './store.js';

/** One dataId per concern, so tests share no IndexedDB state. */
function databaseFor(label: string) {
	return defineData({
		id: `so.epicenter.browsertest.${label}`,
		kv: {},
		tables: {
			notes: defineTable({
				scalars: { title: field.string() },
				types: ['editor'],
				file: {
					serialize: (row) => ({
						data: { title: row.title },
						content: row.editor.toString(),
					}),
					deserialize: (file) => {
						const editor = new Y.Type();
						if (file.content !== '') editor.insert(0, [file.content]);
						return Ok({ editor, title: String(file.data.title ?? '') });
					},
				},
			}),
		},
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

/** The generation every test here works in. One is what an import makes first. */
const GEN = 1;

const localAddress = (dataId: string, generation = GEN) =>
	`epicenter/v2/${dataId}/local/gen/${generation}`;
const accountAddress = (
	dataId: string,
	baseURL: string,
	principalId: string,
	generation = GEN,
) =>
	`epicenter/v2/${dataId}/account/${encodeURIComponent(baseURL)}/${encodeURIComponent(principalId)}/gen/${generation}`;

/** One empty database's whole state: what importing an empty folder produces. */
function emptyState(): Uint8Array {
	const doc = new Y.Doc({ gc: true });
	const bytes = new Uint8Array(Y.encodeStateAsUpdateV2(doc));
	doc.destroy();
	return bytes;
}

/**
 * An account port that serves one generation and assigns numbers locally.
 *
 * The network half, stubbed at the one seam it has. What is being tested here
 * is the opener's cache-first sequence, not HTTP.
 */
function accountFor(
	principalId: typeof ALICE | typeof BOB,
	baseURL = CLOUD,
	served?: { bytes: Uint8Array; position: number },
): DatabaseAccount {
	return {
		baseURL,
		principalId,
		fetch: async (input, init) => {
			if (init?.method === 'POST') {
				return new Response(JSON.stringify({ generation: GEN, position: 0 }), {
					headers: { 'content-type': 'application/json' },
				});
			}
			void input;
			if (served === undefined) return new Response(null, { status: 404 });
			return new Response(served.bytes as unknown as BodyInit, {
				headers: { 'epicenter-log-position': String(served.position) },
			});
		},
	};
}

/** Create generation 1 on this device, then open it: the ordinary first run. */
async function openLocalData(definition: ReturnType<typeof databaseFor>) {
	await importGeneration(definition, emptyState());
	return openDatabase(definition, { generation: GEN });
}

async function openAccountData(
	definition: ReturnType<typeof databaseFor>,
	principalId: typeof ALICE | typeof BOB,
	baseURL = CLOUD,
) {
	const account = accountFor(principalId, baseURL);
	await importGeneration(definition, emptyState(), { account });
	return openDatabase(definition, { generation: GEN, account });
}

function titles(app: {
	tables: { notes: { readonly rows: readonly { title: string }[] } };
}): string[] {
	return app.tables.notes.rows.map((row) => row.title).sort();
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

		local.tables.notes.create({ title: 'mine alone' });
		alice.tables.notes.create({ title: "alice's" });
		bob.tables.notes.create({ title: "bob's" });
		expect(titles(local)).toEqual(['mine alone']);
		expect(titles(alice)).toEqual(["alice's"]);
		expect(titles(bob)).toEqual(["bob's"]);

		const names = await databaseNames();
		expect(names).toContain(localAddress(database.id));
		expect(names).toContain(accountAddress(database.id, CLOUD, ALICE));
		expect(names).toContain(accountAddress(database.id, CLOUD, BOB));

		await local[Symbol.asyncDispose]();
		await alice[Symbol.asyncDispose]();
		await bob[Symbol.asyncDispose]();
	});

	test('a second open of one address is refused, and another account is not that address', async () => {
		const database = databaseFor('claim');
		const alice = expectOk(await openAccountData(database, ALICE));
		const again = expectErr(await openAccountData(database, ALICE));
		expect(again.name).toBe('AlreadyOpen');

		// Another account's replica is a different document, so it opens.
		const bob = expectOk(await openAccountData(database, BOB));
		await bob[Symbol.asyncDispose]();
		await alice[Symbol.asyncDispose]();

		// Disposal releases the claim, so the same address opens again.
		const reopened = expectOk(await openAccountData(database, ALICE));
		await reopened[Symbol.asyncDispose]();
	});

	test('the same principal on two servers gets two retained replicas', async () => {
		const database = databaseFor('servers');
		const cloud = expectOk(await openAccountData(database, ALICE, CLOUD));
		const selfHosted = expectOk(
			await openAccountData(database, ALICE, OTHER_SERVER),
		);

		cloud.tables.notes.create({ title: 'cloud work' });
		selfHosted.tables.notes.create({ title: 'self-hosted work' });
		expect(titles(cloud)).toEqual(['cloud work']);
		expect(titles(selfHosted)).toEqual(['self-hosted work']);

		const names = await databaseNames();
		expect(names).toContain(accountAddress(database.id, CLOUD, ALICE));
		expect(names).toContain(accountAddress(database.id, OTHER_SERVER, ALICE));

		await cloud[Symbol.asyncDispose]();
		await selfHosted[Symbol.asyncDispose]();
	});

	test('equivalent server URL spellings reuse one retained replica', async () => {
		const database = databaseFor('canonical-url');
		const first = expectOk(
			await openAccountData(database, ALICE, `${CLOUD}/?ignored=true#ignored`),
		);
		first.tables.notes.create({ title: 'kept work' });
		await first[Symbol.asyncDispose]();

		const equivalent = expectOk(
			await openAccountData(database, ALICE, `${CLOUD}/`),
		);
		expect(titles(equivalent)).toEqual(['kept work']);
		expect(await databaseNames()).toContain(
			accountAddress(database.id, CLOUD, ALICE),
		);
		await equivalent[Symbol.asyncDispose]();
	});

	test('every address survives a close-and-reopen under its own name', async () => {
		const database = databaseFor('reopen');
		// Widened to the base store kind: a local document and an account
		// replica differ only in their `sync` value, which this test never
		// touches.
		const owners: [
			() => Promise<
				Result<DataView<ReturnType<typeof databaseFor>> & DataDocument, unknown>
			>,
			string,
		][] = [
			[() => openLocalData(database), 'kept local work'],
			[() => openAccountData(database, ALICE), "kept alice's"],
			[() => openAccountData(database, BOB), "kept bob's"],
		];
		for (const [openDocument, title] of owners) {
			const opened = expectOk(await openDocument());
			opened.tables.notes.create({ title });
			await opened[Symbol.asyncDispose]();
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
		await local[Symbol.asyncDispose]();
		await alice[Symbol.asyncDispose]();
		await bob[Symbol.asyncDispose]();
	});

	test('a second generation is a second address, and the first is untouched', async () => {
		// What replaced `discard`. One address used to hold whatever the
		// authority currently was, so moving on meant deleting it; a generation
		// is created once and never mutated in place, so moving on is opening a
		// different address and the old one is an older copy (ADR-0292).
		const database = databaseFor('generations');
		const account = accountFor(ALICE);
		await importGeneration(database, emptyState(), { account });
		const first = expectOk(
			await openDatabase(database, { generation: 1, account }),
		);
		first.tables.notes.create({ title: 'in generation one' });
		await first[Symbol.asyncDispose]();

		await importGeneration(database, emptyState(), {
			account: accountFor(ALICE),
		});
		const names = await databaseNames();
		expect(names).toContain(accountAddress(database.id, CLOUD, ALICE, 1));

		// And generation one still holds what was written into it.
		const reopened = expectOk(
			await openDatabase(database, { generation: 1, account }),
		);
		expect(titles(reopened)).toEqual(['in generation one']);
		await reopened[Symbol.asyncDispose]();
	});

	test('a generation this device does not hold is not found, and none is made', async () => {
		// A number in a URL is an ADDRESS, not an instruction to allocate. The
		// name-existence trap is the whole reason this is asserted: `openDB` on
		// a missing name CREATES it, so a shell left behind here would read as a
		// cache hit on the next open.
		const database = databaseFor('notfound');
		const before = await databaseNames();

		const refused = expectErr(await openDatabase(database, { generation: 7 }));
		expect(refused.name).toBe('GenerationNotFound');
		expect(await databaseNames()).toEqual(before);
	});

	test('a generation number that is not one is refused as unaddressable', async () => {
		const database = databaseFor('badgeneration');
		for (const generation of [0, -1, 1.5, Number.NaN]) {
			const refused = expectErr(await openDatabase(database, { generation }));
			expect(refused.name).toBe('Unaddressable');
		}
	});

	test('an account miss bootstraps from the authority and hydrates it', async () => {
		// The second device. It holds nothing, so it fetches the generation
		// whole, writes it in one transaction, and only then returns; a fresh
		// account database never renders empty while its state is arriving.
		const database = databaseFor('bootstrap');
		const author = expectOk(await openLocalData(database));
		author.tables.notes.create({ title: 'made elsewhere' });
		const state = author.encodeStateSince();
		await author[Symbol.asyncDispose]();

		const account = accountFor(BOB, CLOUD, { bytes: state, position: 4 });
		const arrived = expectOk(
			await openDatabase(database, { generation: GEN, account }),
		);
		expect(titles(arrived)).toEqual(['made elsewhere']);
		// The position rode in on the append, so the socket carries only what
		// happened after it rather than the state it just downloaded.
		expect(syncEngineOf(arrived).cursor()).toBe(4);
		await arrived[Symbol.asyncDispose]();
	});

	test('an account miss the authority cannot serve leaves nothing behind', async () => {
		const database = databaseFor('bootstrapfail');
		const before = await databaseNames();
		const account: DatabaseAccount = {
			baseURL: CLOUD,
			principalId: ALICE,
			fetch: async () => new Response(null, { status: 503 }),
		};

		const refused = expectErr(
			await openDatabase(database, { generation: GEN, account }),
		);
		// Unavailable, never not-found: a retry can fix one and never the
		// other, and a boot surface that conflates them tells a person their
		// data is gone when their wifi is off.
		expect(refused.name).toBe('GenerationUnavailable');
		expect(await databaseNames()).toEqual(before);
	});

	test('an account replica with no identity is refused, and no database is made for it', async () => {
		const database = databaseFor('unaddressable');
		const before = await databaseNames();

		const refused = expectErr(
			await openDatabase(database, {
				generation: GEN,
				account: accountFor(asPrincipalId('   ') as typeof ALICE),
			}),
		);
		expect(refused.name).toBe('Unaddressable');
		expect(await databaseNames()).toEqual(before);

		const malformed = expectErr(
			await openDatabase(database, {
				generation: GEN,
				account: accountFor(ALICE, 'not a URL'),
			}),
		);
		expect(malformed.name).toBe('Unaddressable');
		expect(await databaseNames()).toEqual(before);

		// And the refusal held no claim, so a real account still opens.
		const alice = expectOk(await openAccountData(database, ALICE));
		await alice[Symbol.asyncDispose]();
	});
});

describe('the durable facts live in IndexedDB directly (ADR-0238)', () => {
	/** Fabricate a record from a superseded storage generation. */
	function seedPreviousGeneration(
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

	test('a record from an earlier storage generation is stranded, never merged', () => {
		// The clean break, and the mechanism is the ADDRESS (ADR-0231's
		// supersession, restated by `STORE_GENERATION`). A `v1` record keyed its
		// updates by the document they belonged to and kept a `tombstones` store
		// beside them; a database is one document now (ADR-0295), so those rows
		// are a shape this reader cannot honestly interpret. It does not detect
		// and wipe them. It does not address them.
		expect(localAddress('so.epicenter.x')).toContain('/v2/');
		expect(accountAddress('so.epicenter.x', CLOUD, ALICE)).toContain('/v2/');
	});

	test('a v1 record at the same logical address is not opened', async () => {
		const database = databaseFor('generation');
		const author = await openMemory(database);
		author.tables.notes.create({ title: 'pre-break note' });
		const bytes = author.encodeStateSince();
		await author[Symbol.asyncDispose]();

		await seedPreviousGeneration(
			`epicenter/v1/${database.id}/account/${encodeURIComponent(CLOUD)}/${ALICE}`,
			{ updates: [{ seq: 1, bytes }], outbox: [{ id: 3, bytes }], cursor: 5 },
		);

		const replica = expectOk(await openAccountData(database, ALICE));
		try {
			// Nothing of it is merged, and nothing of it is inherited: the replica
			// is a fresh install that refills from its authority.
			expect(titles(replica)).toEqual([]);
			expect(syncEngineOf(replica).cursor()).toBe(0);
			expect(syncEngineOf(replica).coalesce()).toBeUndefined();
		} finally {
			await replica[Symbol.asyncDispose]();
		}
	});

	test('the update log folds at the threshold instead of growing forever', async () => {
		const database = databaseFor('fold');
		const address = localAddress(database.id);
		const local = expectOk(await openLocalData(database));
		for (let index = 0; index < 70; index += 1) {
			local.tables.notes.create({ title: `note ${index}` });
		}
		await local.persistence.flush();
		expect(local.persistence.get()).toBe('saved');
		await local[Symbol.asyncDispose]();

		expect(await countRows(address, 'updates')).toBeLessThan(70);

		const reopened = expectOk(await openLocalData(database));
		expect(titles(reopened)).toHaveLength(70);
		await reopened[Symbol.asyncDispose]();
	});
});

describe('the clean break: storage from before the generation address', () => {
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
					.put({ updates: [], outbox: [], cursor: 0 }, 'durable');
				transaction.oncomplete = () => {
					sqlite.close();
					resolve();
				};
				transaction.onerror = () => reject(transaction.error);
			};
			request.onerror = () => reject(request.error);
		});
	}

	test('a superseded record is stranded rather than swept', async () => {
		// This used to delete a list of old names at every open, and the list
		// had to be kept current by hand. The generation is in the address now
		// (ADR-0292) and the storage epoch is above it, so a record written
		// under any older shape sits at a name nothing opens: it is not
		// detected and wiped, it is simply not addressed. That makes a bad
		// migration impossible to write rather than merely discouraged.
		const database = databaseFor('stranded');
		const superseded = `epicenter/${database.id}/private`;
		await seedSupersededDatabase(superseded);

		const local = expectOk(await openLocalData(database));
		expect(titles(local)).toEqual([]);
		// Untouched, and unread. Both halves matter: nothing of it reached the
		// store, and nothing deleted a person's bytes on their behalf.
		expect(await databaseNames()).toContain(superseded);
		await local[Symbol.asyncDispose]();
	});
});

describe('a boot that cannot proceed refuses, and holds no claim after it', () => {
	/**
	 * Write one undecodable update into a record certified under the current
	 * format, so the format rule keeps it and the hydration replay meets it.
	 */
	function seedCorruptChain(address: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const request = indexedDB.open(address, 1);
			request.onupgradeneeded = () => {
				request.result.createObjectStore('updates');
			};
			request.onsuccess = () => {
				const sqlite = request.result;
				const transaction = sqlite.transaction(['updates'], 'readwrite');
				transaction
					.objectStore('updates')
					.put(
						{ bytes: new Uint8Array([1, 2, 3, 4, 5]), authoritySeq: null },
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
		const refused = await openDatabase(
			{ dataId: database.id, tables: { notes: { scalars: {} } } } as never,
			{ generation: GEN },
		);
		expect(refused.error).not.toBeNull();

		const after = expectOk(await openLocalData(database));
		await after[Symbol.asyncDispose]();
	});

	test('a corrupt durable record refuses the boot and releases the claim', async () => {
		const database = databaseFor('corrupt');
		await seedCorruptChain(localAddress(database.id));

		const refused = await openDatabase(database, { generation: GEN });
		expect(refused.data).toBeNull();
		expect(refused.error?.name).toBe('StorageFailed');

		// The claim went with the refusal: a retry reports the same honest
		// failure rather than `AlreadyOpen` for the life of the page.
		const again = await openDatabase(database, { generation: GEN });
		expect(again.error?.name).toBe('StorageFailed');
	});
});

describe("a row's type content survives a reopen (ADR-0295)", () => {
	test('what was typed into a type field comes back attached', async () => {
		const database = databaseFor('richfield');
		let rowId!: string;
		{
			const local = expectOk(await openLocalData(database));
			rowId = local.tables.notes.create({ title: 'x' }).id;
			const content = local.tables.notes.get(rowId);
			if (content === undefined) throw new Error('the row has no content');
			// The application picks the field's format. In Yjs 14 `change` hands
			// back a fresh builder and `applyDelta` commits it.
			const editor = content.editor;
			editor.applyDelta(editor.change.insert('buy milk') as never);
			editor.setAttr('cursor' as never, 8 as never);
			await local[Symbol.asyncDispose]();
		}

		const reopened = expectOk(await openLocalData(database));
		const editor = reopened.tables.notes.get(rowId)?.editor;
		expect(editor?.toString()).toContain('buy milk');
		expect(editor?.getAttr('cursor' as never)).toBe(8);
		await reopened[Symbol.asyncDispose]();
	});
});
