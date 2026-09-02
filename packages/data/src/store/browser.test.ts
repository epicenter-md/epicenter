import { field, plainText } from '@epicenter/data/definition';
/**
 * Browser Store Address Tests
 *
 * A browser store is addressed by the application that opened it, the data it
 * holds, and which history it is (ADR-0324), at an exact generation
 * (ADR-0292): `epicenter/v4/<app-id>/<data-id>/<n>`, one IndexedDB database
 * and one open claim per GENERATION.
 *
 * Key behaviors:
 * - The address is composed of exactly those four parts, under the format
 *   version, and nothing about who owns the store
 * - Two applications naming one data id keep their own replicas (ADR-0304)
 * - A second open of one address is refused with AlreadyOpen
 * - A second generation is a second address, and the first is untouched
 * - An application id, a generation number, or an account that cannot be named
 *   is refused before anything is claimed or created
 * - Every address survives a close-and-reopen
 * - Both superseded storage shapes are stranded at open, never read
 *
 * Isolation between two accounts is no longer in the address. It is the binding
 * ADR-0325 writes inside the database at creation and compares at open, and the
 * "a generation belongs to the account it was created for" block below is where
 * that is pinned.
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
import type { Result } from 'wellcrafted/result';
import { expectErr, expectOk as expectOkResult } from 'wellcrafted/testing';

import {
	createGeneration,
	type DatabaseAccount,
	eraseGenerations,
	openDatabase,
	resolveGeneration,
} from './browser.js';
import { openMemory } from './memory.js';
import { syncEngineOf } from './store.js';

/** One dataId per concern, so tests share no IndexedDB state. */
function databaseFor(label: string) {
	return defineData({
		id: `so.epicenter.browsertest.${label}`,
		kv: {},
		tables: {
			notes: defineTable({
				title: field.string(),
				content: plainText(),
			}),
		},
	});
}

const ALICE = asPrincipalId('alice');
const BOB = asPrincipalId('bob');
const CLOUD = 'https://api.epicenter.so';

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

/** The application every test here opens as, unless it is testing the segment. */
const APP = 'so.epicenter.browsertest';

const storeAddress = (dataId: string, generation = GEN, appId = APP) =>
	`epicenter/v4/${appId}/${dataId}/${generation}`;

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

async function openAccountData(
	definition: ReturnType<typeof databaseFor>,
	principalId: typeof ALICE | typeof BOB,
	baseURL = CLOUD,
	appId = APP,
) {
	const account = accountFor(principalId, baseURL);
	await createGeneration(definition, { appId, account });
	return openDatabase(definition, { appId, generation: GEN, account });
}

function titles(app: {
	tables: { notes: { readonly rows: readonly { title: string }[] } };
}): string[] {
	return app.tables.notes.rows.map((row) => row.title).sort();
}

/** Erase one address, so the next open of it is the miss a test needs. */
function deleteDatabase(name: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.deleteDatabase(name);
		request.onsuccess = () => resolve();
		request.onerror = () => reject(request.error);
	});
}

async function databaseNames(): Promise<string[]> {
	const databases = await indexedDB.databases();
	return databases
		.map((sqlite) => sqlite.name)
		.filter((name): name is string => name !== undefined)
		.sort();
}

describe('one address per application, data id, and generation (ADR-0324)', () => {
	test('the address is the app id, the data id, and the number, under v4', async () => {
		const database = databaseFor('address');
		const opened = expectOk(await openAccountData(database, ALICE));
		expect(await databaseNames()).toContain(storeAddress(database.id));
		// And nothing about who owns it. The server and the principal used to be
		// four segments here; they are what the store REPORTS now, and ADR-0325
		// stamps the same pair inside it.
		expect(storeAddress(database.id)).not.toContain(encodeURIComponent(CLOUD));
		expect(opened.baseURL).toBe(CLOUD);
		expect(opened.principalId).toBe(ALICE);
		await opened[Symbol.asyncDispose]();
	});

	test('two applications naming one data id keep their own replicas', async () => {
		// The live defect ADR-0324 corrects. Every application in the desktop
		// WebView shares one loopback origin, so without this segment the second
		// one to open a shared data id was refused by a claim it had no way to
		// interpret, and sequentially the two interleaved histories into one
		// record with nothing to surface it.
		const database = databaseFor('twoapps');
		const notes = expectOk(
			await openAccountData(database, ALICE, CLOUD, 'so.epicenter.notes'),
		);
		const reader = expectOk(
			await openAccountData(database, ALICE, CLOUD, 'so.epicenter.reader'),
		);
		notes.tables.notes.create({ title: 'written in notes' });
		reader.tables.notes.create({ title: 'written in reader' });
		expect(titles(notes)).toEqual(['written in notes']);
		expect(titles(reader)).toEqual(['written in reader']);

		const names = await databaseNames();
		expect(names).toContain(
			storeAddress(database.id, GEN, 'so.epicenter.notes'),
		);
		expect(names).toContain(
			storeAddress(database.id, GEN, 'so.epicenter.reader'),
		);

		await notes[Symbol.asyncDispose]();
		await reader[Symbol.asyncDispose]();
	});

	test('a second open of one address is refused while the first holds it', async () => {
		const database = databaseFor('claim');
		const alice = expectOk(await openAccountData(database, ALICE));
		const again = expectErr(await openAccountData(database, ALICE));
		expect(again.name).toBe('AlreadyOpen');
		await alice[Symbol.asyncDispose]();

		// Disposal releases the claim, so the same address opens again.
		const reopened = expectOk(await openAccountData(database, ALICE));
		await reopened[Symbol.asyncDispose]();
	});

	test('an address survives a close-and-reopen under its own name', async () => {
		const database = databaseFor('reopen');
		const first = expectOk(await openAccountData(database, ALICE));
		first.tables.notes.create({ title: 'kept work' });
		await first[Symbol.asyncDispose]();

		const reopened = expectOk(await openAccountData(database, ALICE));
		expect(titles(reopened)).toEqual(['kept work']);
		await reopened[Symbol.asyncDispose]();
	});

	test('a second generation is a second address, and the first is untouched', async () => {
		// What replaced `discard`. One address used to hold whatever the
		// authority currently was, so moving on meant deleting it; a generation
		// is created once and never mutated in place, so moving on is opening a
		// different address and the old one is an older copy (ADR-0292).
		const database = databaseFor('generations');
		const account = accountFor(ALICE);
		await createGeneration(database, { appId: APP, account });
		const first = expectOk(
			await openDatabase(database, { appId: APP, generation: 1, account }),
		);
		first.tables.notes.create({ title: 'in generation one' });
		await first[Symbol.asyncDispose]();

		await createGeneration(database, {
			appId: APP,
			account: accountFor(ALICE),
		});
		const names = await databaseNames();
		expect(names).toContain(storeAddress(database.id, 1));

		// And generation one still holds what was written into it.
		const reopened = expectOk(
			await openDatabase(database, { appId: APP, generation: 1, account }),
		);
		expect(titles(reopened)).toEqual(['in generation one']);
		await reopened[Symbol.asyncDispose]();
	});

	test('a generation number that is not one is refused as unaddressable', async () => {
		const database = databaseFor('badgeneration');
		const account = accountFor(ALICE, CLOUD);
		for (const generation of [0, -1, 1.5, Number.NaN]) {
			const refused = expectErr(
				await openDatabase(database, { appId: APP, generation, account }),
			);
			expect(refused.name).toBe('Unaddressable');
		}
	});

	test('an application id that is not one is refused, and makes no database', async () => {
		// Self-claimed and never verified, because a deployed app is a trusted
		// app (ADR-0334). What the grammar buys is that a claim cannot contain a
		// `/` and be read as somebody else's address.
		const database = databaseFor('badappid');
		const before = await databaseNames();
		for (const appId of ['so.epicenter/other', '', '.hidden']) {
			const refused = expectErr(
				await openDatabase(database, {
					appId,
					generation: GEN,
					account: accountFor(ALICE),
				}),
			);
			expect(refused.name).toBe('Unaddressable');
		}
		expect(await databaseNames()).toEqual(before);
	});

	test('an account miss bootstraps from the authority and hydrates it', async () => {
		// The second device. It holds nothing, so it fetches the generation
		// whole, writes it in one transaction, and only then returns; a fresh
		// account database never renders empty while its state is arriving.
		const database = databaseFor('bootstrap');
		const author = expectOk(await openAccountData(database, ALICE));
		author.tables.notes.create({ title: 'made elsewhere' });
		const state = author.encodeStateSince();
		await author[Symbol.asyncDispose]();
		// The author's own record is deleted, so the reopen below is the miss it
		// says it is rather than a cache hit at the same address.
		await deleteDatabase(storeAddress(database.id));

		const account = accountFor(BOB, CLOUD, { bytes: state, position: 4 });
		const arrived = expectOk(
			await openDatabase(database, { appId: APP, generation: GEN, account }),
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
			await openDatabase(database, { appId: APP, generation: GEN, account }),
		);
		// Unavailable, never not-found: a retry can fix one and never the
		// other, and a boot surface that conflates them tells a person their
		// data is gone when their wifi is off.
		expect(refused.name).toBe('GenerationUnavailable');
		expect(await databaseNames()).toEqual(before);
	});

	test('an account that names no server or principal is refused, and makes no database', async () => {
		const database = databaseFor('unaddressable');
		const before = await databaseNames();

		const refused = expectErr(
			await openDatabase(database, {
				appId: APP,
				generation: GEN,
				account: accountFor(asPrincipalId('   ') as typeof ALICE),
			}),
		);
		expect(refused.name).toBe('Unaddressable');
		expect(await databaseNames()).toEqual(before);

		const malformed = expectErr(
			await openDatabase(database, {
				appId: APP,
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

describe('which generation to open (ADR-0292, ADR-0293)', () => {
	/** An authority that answers a listing, and refuses to be asked for more. */
	function authorityHolding(
		generations: readonly number[] | string,
		options: { status?: number; onPost?: () => void } = {},
	): DatabaseAccount {
		return {
			baseURL: CLOUD,
			principalId: ALICE,
			fetch: async (_input, init) => {
				if (init?.method === 'POST') {
					options.onPost?.();
					return new Response(JSON.stringify({ generation: 9, position: 0 }), {
						headers: { 'content-type': 'application/json' },
					});
				}
				if (options.status !== undefined) {
					return new Response(null, { status: options.status });
				}
				return new Response(JSON.stringify({ generations }), {
					headers: { 'content-type': 'application/json' },
				});
			},
		};
	}

	test("this device's own copy is the answer, and the account is never asked", async () => {
		const database = databaseFor('resolvecache');
		const opened = expectOk(await openAccountData(database, ALICE));
		await opened[Symbol.asyncDispose]();

		const account: DatabaseAccount = {
			baseURL: CLOUD,
			principalId: ALICE,
			fetch: async () => {
				throw new Error('a cached generation asks nobody');
			},
		};
		const resolved = expectOk(
			await resolveGeneration(database, { appId: APP, account }),
		);
		expect(resolved.generation).toBe(GEN);
	});

	test('a second device joins the account it found rather than minting a rival', async () => {
		// The fork this function exists to refuse. A device holding nothing used
		// to mint whenever its own cache was empty, which put one account's notes
		// in two generations that never meet.
		const database = databaseFor('resolvejoin');
		let minted = false;
		const resolved = expectOk(
			await resolveGeneration(database, {
				appId: APP,
				account: authorityHolding([1, 4, 2], { onPost: () => (minted = true) }),
			}),
		);
		// The highest, not the last one listed.
		expect(resolved.generation).toBe(4);
		expect(minted).toBe(false);
	});

	test('an empty listing is a first run, and only then is one minted', async () => {
		const database = databaseFor('resolvefirst');
		let minted = false;
		const resolved = expectOk(
			await resolveGeneration(database, {
				appId: APP,
				account: authorityHolding([], { onPost: () => (minted = true) }),
			}),
		);
		expect(minted).toBe(true);
		expect(resolved.generation).toBe(9);
	});

	test('a listing that cannot be read mints nothing', async () => {
		// Three shapes of "the account did not answer", and none of them may be
		// read as empty: a refusal, a body that is not a listing, and a listing
		// whose entries are not generations. A captive portal answering 200 with
		// HTML is the third one in the wild.
		const database = databaseFor('resolveunavailable');
		let minted = false;
		const refusals = [
			authorityHolding([], { status: 503, onPost: () => (minted = true) }),
			authorityHolding('not a listing', { onPost: () => (minted = true) }),
			authorityHolding(['1', '2'] as never, { onPost: () => (minted = true) }),
		];
		for (const account of refusals) {
			const refused = expectErr(
				await resolveGeneration(database, { appId: APP, account }),
			);
			expect(refused.name).toBe('GenerationUnavailable');
		}
		expect(minted).toBe(false);
		expect(await databaseNames()).not.toContain(storeAddress(database.id));
	});
});

describe('a generation belongs to the account it was created for (ADR-0325)', () => {
	test('a second account is refused the copy the first one left here', async () => {
		// The hazard, and it is quiet rather than loud: two authorities mint
		// numbers independently, so a `1` exists under both, and Yjs converges
		// instead of erroring. Without the binding Bob would open Alice's rows,
		// report himself as their principal, and offer her owed appends to his
		// authority.
		const database = databaseFor('binding');
		const alice = expectOk(await openAccountData(database, ALICE));
		alice.tables.notes.create({ title: "alice's note" });
		await alice[Symbol.asyncDispose]();

		const refused = expectErr(
			await openDatabase(database, {
				appId: APP,
				generation: GEN,
				account: accountFor(BOB),
			}),
		);
		expect(refused.name).toBe('BoundElsewhere');

		// And the refusal left the record and the claim alone: nothing is
		// deleted as a step in a protocol (ADR-0281), and Alice comes back to
		// what she wrote.
		expect(await databaseNames()).toContain(storeAddress(database.id));
		const back = expectOk(await openAccountData(database, ALICE));
		expect(titles(back)).toEqual(["alice's note"]);
		await back[Symbol.asyncDispose]();
	});

	test('the same principal on a second server is a different account', async () => {
		// The half an address could never carry alone: the same principal
		// identifier can exist on two independent servers.
		const database = databaseFor('twoservers');
		const cloud = expectOk(await openAccountData(database, ALICE, CLOUD));
		await cloud[Symbol.asyncDispose]();

		const refused = expectErr(
			await openDatabase(database, {
				appId: APP,
				generation: GEN,
				account: accountFor(ALICE, 'https://home.example.com'),
			}),
		);
		expect(refused.name).toBe('BoundElsewhere');
	});

	test('a trailing slash is not a different account', async () => {
		// Which is why `canonicalBaseURL` survived the address collapse. It
		// normalizes what is compared, not what is named.
		const database = databaseFor('spelling');
		const first = expectOk(await openAccountData(database, ALICE, CLOUD));
		first.tables.notes.create({ title: 'kept work' });
		await first[Symbol.asyncDispose]();

		const equivalent = expectOk(
			await openAccountData(database, ALICE, `${CLOUD}/?ignored=true#ignored`),
		);
		expect(titles(equivalent)).toEqual(['kept work']);
		await equivalent[Symbol.asyncDispose]();
	});

	test("erasing is the person's, and it takes every generation at once", async () => {
		// Plural because the refusal is: erasing only the one that was refused
		// would refuse the next number down and ask again.
		const database = databaseFor('erase');
		for (const generation of [1, 2]) {
			// The stub authority mints the number this iteration asks for, which
			// is what a real one does across an import and a re-import.
			const account: DatabaseAccount = {
				baseURL: CLOUD,
				principalId: ALICE,
				fetch: async () =>
					new Response(JSON.stringify({ generation, position: 0 }), {
						headers: { 'content-type': 'application/json' },
					}),
			};
			await createGeneration(database, { appId: APP, account });
			const opened = expectOk(
				await openDatabase(database, { appId: APP, generation, account }),
			);
			await opened[Symbol.asyncDispose]();
		}
		expect(await databaseNames()).toContain(storeAddress(database.id, 2));

		const erased = expectOk(
			await eraseGenerations({ appId: APP, dataId: database.id }),
		);
		expect(erased.erased).toBe(2);
		expect(await databaseNames()).not.toContain(storeAddress(database.id, 1));
		expect(await databaseNames()).not.toContain(storeAddress(database.id, 2));

		// And the account that was refused can now make its own.
		const bob = expectOk(await openAccountData(database, BOB));
		expect(titles(bob)).toEqual([]);
		await bob[Symbol.asyncDispose]();
	});

	test('an erase with a generation still open deletes nothing at all', async () => {
		// All or nothing, and the reason is what half of it would leave: a person
		// told the erase failed while some of their notes are already gone. Every
		// generation is claimed before any is deleted, so a window holding one
		// answers with the claim that refuses an open.
		const database = databaseFor('erasebusy');
		const held = expectOk(await openAccountData(database, ALICE));
		held.tables.notes.create({ title: 'still open' });

		const refused = expectErr(
			await eraseGenerations({ appId: APP, dataId: database.id }),
		);
		expect(refused.name).toBe('AlreadyOpen');
		expect(await databaseNames()).toContain(storeAddress(database.id));
		expect(titles(held)).toEqual(['still open']);

		// Closing it is the repair, and the claims the refusal took are released.
		await held[Symbol.asyncDispose]();
		const erased = expectOk(
			await eraseGenerations({ appId: APP, dataId: database.id }),
		);
		expect(erased.erased).toBe(1);
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
		// beside them; a database is one document now (ADR-0295). A `v2` record
		// wrote a local store's own appends with a NULL position, which now means
		// "owed to an authority" on every store kind (ADR-0301). A `v3` record
		// named the server and principal it belonged to, so read under this
		// shape it could be offered to an authority its address never scoped it
		// to (ADR-0324). None is a shape this reader can honestly interpret. It
		// does not detect and wipe them. It does not address them.
		expect(storeAddress('so.epicenter.x')).toContain('/v4/');
	});

	test('a superseded record at the same logical address is not opened', async () => {
		const database = databaseFor('generation');
		const author = await openMemory(database);
		author.tables.notes.create({ title: 'pre-break note' });
		const bytes = author.encodeStateSince();
		await author[Symbol.asyncDispose]();

		// Spelled as `v1`, because that is the shape this payload is: a `state`
		// object store holding one checkpoint. What the test pins is the version
		// segment, and every superseded spelling of it sits at a name the v4
		// reader never enumerates.
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

	// Owed work only. The strong fold, a whole-document re-encode that realizes
	// `gc: true`, needs rows the authority has given positions, and nothing
	// here acknowledges. That case is untested and should not stay that way:
	// this pins the bound, not the reclamation.
	test('owed work collapses at the threshold instead of growing forever', async () => {
		const database = databaseFor('fold');
		const address = storeAddress(database.id);
		const local = expectOk(await openAccountData(database, ALICE));
		for (let index = 0; index < 70; index += 1) {
			local.tables.notes.create({ title: `note ${index}` });
			// Flushed as they land, the way a live store does. `mergeOwed`
			// reads the DURABLE outbox, so a burst that never reaches disk has
			// nothing for it to collapse.
			await local.persistence.flush();
		}
		expect(local.persistence.get()).toBe('saved');
		await local[Symbol.asyncDispose]();

		expect(await countRows(address, 'updates')).toBeLessThan(70);

		const reopened = expectOk(await openAccountData(database, ALICE));
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

		const local = expectOk(await openAccountData(database, ALICE));
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
			{ dataId: database.id, tables: { notes: {} } } as never,
			{ appId: APP, generation: GEN, account: accountFor(ALICE, CLOUD) },
		);
		expect(refused.error).not.toBeNull();

		const after = expectOk(await openAccountData(database, ALICE));
		await after[Symbol.asyncDispose]();
	});

	test('a corrupt durable record refuses the boot and releases the claim', async () => {
		const database = databaseFor('corrupt');
		await seedCorruptChain(storeAddress(database.id));

		const account = accountFor(ALICE, CLOUD);
		const refused = await openDatabase(database, {
			appId: APP,
			generation: GEN,
			account,
		});
		expect(refused.data).toBeNull();
		expect(refused.error?.name).toBe('StorageFailed');

		// The claim went with the refusal: a retry reports the same honest
		// failure rather than `AlreadyOpen` for the life of the page.
		const again = await openDatabase(database, {
			appId: APP,
			generation: GEN,
			account,
		});
		expect(again.error?.name).toBe('StorageFailed');
	});
});

describe("a row's content node survives a reopen (ADR-0295)", () => {
	test('what was typed into a content node comes back attached', async () => {
		const database = databaseFor('richfield');
		let rowId!: string;
		{
			const local = expectOk(await openAccountData(database, ALICE));
			rowId = local.tables.notes.create({ title: 'x' }).id;
			const row = local.tables.notes.get(rowId);
			if (row === undefined) throw new Error('the row has no content');
			// The application picks the node's format. In Yjs 14 `change` hands
			// back a fresh builder and `applyDelta` commits it.
			const { content } = row;
			content.applyDelta(content.change.insert('buy milk') as never);
			content.setAttr('cursor' as never, 8 as never);
			await local[Symbol.asyncDispose]();
		}

		const reopened = expectOk(await openAccountData(database, ALICE));
		const content = reopened.tables.notes.get(rowId)?.content;
		expect(content?.toString()).toContain('buy milk');
		expect(content?.getAttr('cursor' as never)).toBe(8);
		await reopened[Symbol.asyncDispose]();
	});
});
