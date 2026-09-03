import 'fake-indexeddb/auto';
import { installTestLocks } from '@epicenter/data/test-locks';

installTestLocks();

import { expect, test } from 'bun:test';
import type { AuthClient } from '@epicenter/auth';
import { createGeneration } from '@epicenter/data/browser';
import {
	defineData,
	defineTable,
	field,
	plainText,
} from '@epicenter/data/definition';
import { createEpicenter } from './browser.js';

/**
 * What an application gets when it passes a definition and an account.
 *
 * These were `apps/honeycrisp/src/lib/databases.test.ts`, against the opener
 * that application wrote for itself. The opener is here now (ADR-0339), so the
 * coverage is too: a store opens and holds rows, a second boot reads them
 * offline, a refused credential costs sync and not the notes, a signed-out
 * account is refused without creating anything, another account's copy is
 * refused rather than merged, and `eraseReplica` is what clears it.
 */

const APP_ID = 'so.epicenter.test';

const definition = defineData({
	id: 'so.epicenter.test',
	title: 'Test',
	kv: {},
	tables: {
		notes: defineTable({ title: field.string(), content: plainText() }),
	},
});

async function databaseNames(): Promise<string[]> {
	const databases = await indexedDB.databases();
	return databases
		.map((database) => database.name)
		.filter((name): name is string => name !== undefined);
}

async function resetStorage(): Promise<void> {
	for (const name of await databaseNames()) {
		await new Promise<void>((resolve, reject) => {
			const request = indexedDB.deleteDatabase(name);
			request.onsuccess = () => resolve();
			request.onerror = () => reject(request.error);
		});
	}
}

function titles(data: {
	tables: { notes: { readonly rows: readonly { title: string }[] } };
}): string[] {
	return data.tables.notes.rows.map((row) => row.title).sort();
}

/**
 * The generations collection, in memory, per fake account.
 *
 * The one HTTP surface opening touches (ADR-0292): a POST that assigns a
 * number and a GET that hands the state back. Held per client, so two fake
 * accounts are two accounts.
 */
function createFakeGenerations() {
	const held = new Map<number, Uint8Array>();
	return {
		held,
		async fetch(input: Request | string | URL, init?: RequestInit) {
			const url = new URL(String(input instanceof Request ? input.url : input));
			const item = /\/generations\/(\d+)$/.exec(url.pathname);
			if (init?.method === 'POST') {
				const generation = held.size + 1;
				held.set(generation, new Uint8Array(init.body as ArrayBuffer));
				return Response.json({ generation, position: 1 });
			}
			if (item !== null) {
				const bytes = held.get(Number(item[1]));
				if (bytes === undefined) return new Response(null, { status: 404 });
				return new Response(bytes as unknown as BodyInit, {
					headers: { 'epicenter-log-position': '1' },
				});
			}
			return Response.json({ generations: [...held.keys()].sort() });
		},
	};
}

function createFakeAuth({
	status,
	principalId = 'principal-under-test',
	openWebSocket = () => Promise.reject(new Error('not connected')),
}: {
	status: 'signed-out' | 'signed-in' | 'reauth-required';
	principalId?: string;
	openWebSocket?: () => Promise<WebSocket>;
}): AuthClient {
	const unused = () => {
		throw new Error('not part of opening a store');
	};
	const generations = createFakeGenerations();
	return {
		state: status === 'signed-out' ? { status } : { status, principalId },
		connection: {
			baseURL: 'https://api.test',
			status: 'connected',
			onChange: () => () => undefined,
		},
		onStateChange: () => () => undefined,
		startSignIn: unused,
		signOut: unused,
		fetch: (input: Request | string | URL, init?: RequestInit) =>
			generations.fetch(input, init),
		getProfile: unused,
		openWebSocket,
		[Symbol.dispose]: () => undefined,
	} as unknown as AuthClient;
}

/** Create an empty generation in this account, the way a first run does. */
async function importEmptyGeneration(account: AuthClient): Promise<void> {
	if (account.state.status === 'signed-out') throw new Error('signed out');
	const created = await createGeneration(definition, {
		appId: APP_ID,
		account: {
			baseURL: account.connection.baseURL,
			principalId: account.state.principalId,
			fetch: (input, init) => account.fetch(input, init),
		},
	});
	if (created.error !== null) throw created.error;
}

function handleFor(account: AuthClient) {
	return createEpicenter({ appId: APP_ID, definition, account });
}

/**
 * One handle, opened, and the one thing that ends it.
 *
 * A test needs the release the page would otherwise perform: the store an
 * application holds cannot close itself (ADR-0340), and the handle holds all
 * three things opening acquired.
 */
async function openedBy(account: AuthClient) {
	const epicenter = handleFor(account);
	const opened = await epicenter.data;
	if (opened.error !== null) throw opened.error;
	return { data: opened.data, close: () => epicenter.close() };
}

test('the store opens as a replica of the account that was passed in', async () => {
	await resetStorage();
	const account = createFakeAuth({ status: 'signed-in', principalId: 'alice' });
	await importEmptyGeneration(account);

	const { data, close } = await openedBy(account);
	data.tables.notes.create({ title: 'a note' });
	expect(titles(data)).toEqual(['a note']);
	// The address is on the store, and the generation is the one the account
	// listed rather than a number anybody chose (ADR-0339, ADR-0340).
	expect(data.appId).toBe(APP_ID);
	expect(data.dataId).toBe(definition.id);
	expect(data.generation).toBe(1);

	await close();
});

test('one handle memoizes its open, and a second handle is refused', async () => {
	await resetStorage();
	const account = createFakeAuth({ status: 'signed-in', principalId: 'alice' });
	await importEmptyGeneration(account);

	// Two reads of one handle are one promise, which is what makes a second
	// reader join rather than claim a Web Lock the first one holds.
	const epicenter = handleFor(account);
	expect(epicenter.data).toBe(epicenter.data);

	// A SECOND handle is a second claim, and the store refuses it. That is the
	// dev-time shape of this: an application constructs one handle per page,
	// and hot-reloading the module that constructs it meets this until the
	// document is replaced.
	const second = await handleFor(account).data;
	expect(second.error?.name).toBe('AlreadyOpen');

	const opened = await epicenter.data;
	if (opened.error !== null) throw opened.error;
	await epicenter.close();
});

test('closing is terminal, and the claim it held is free for the next handle', async () => {
	await resetStorage();
	const account = createFakeAuth({ status: 'signed-in', principalId: 'alice' });
	await importEmptyGeneration(account);

	const epicenter = handleFor(account);
	const first = await epicenter.data;
	if (first.error !== null) throw first.error;
	first.data.tables.notes.create({ title: 'before' });

	// `close` ends all three things opening acquired: the socket, the page-hide
	// listener, and the document holding the Web Lock. Twice is once.
	await Promise.all([epicenter.close(), epicenter.close()]);

	// The handle does not forget its open, so it never opens a second store: it
	// resolves the same one, closed, and a closed store throws on every verb.
	// Reopening is a NEW handle, which is what a fresh page is.
	const after = await epicenter.data;
	if (after.error !== null) throw after.error;
	expect(() => after.data.tables.notes.rows).toThrow();

	const reopened = await openedBy(account);
	expect(titles(reopened.data)).toEqual(['before']);
	await reopened.close();
});

test('a held copy opens from local storage before sync is available', async () => {
	await resetStorage();
	{
		const account = createFakeAuth({
			status: 'signed-in',
			principalId: 'alice',
		});
		await importEmptyGeneration(account);
		const { data, close } = await openedBy(account);
		data.tables.notes.create({ title: 'offline note' });
		await close();
	}

	const { data, close } = await openedBy(
		createFakeAuth({
			status: 'signed-in',
			principalId: 'alice',
			openWebSocket: () => Promise.reject(new Error('offline')),
		}),
	);
	expect(titles(data)).toEqual(['offline note']);
	await close();
});

test('a refused credential costs sync, not the notes', async () => {
	await resetStorage();
	const refusing = createFakeAuth({
		status: 'reauth-required',
		principalId: 'alice',
		openWebSocket: () =>
			Promise.reject({
				name: 'OpenWebSocketDenied',
				permanence: 'permanent',
				code: 'reauth-required',
			}),
	});
	await importEmptyGeneration(refusing);

	// The reversal ADR-0292 bought. A fresh replica used to be unavailable
	// until the authority stamped it; the store opens from local state before a
	// socket is attempted, so a denial is a quiet status line.
	const { data, close } = await openedBy(refusing);
	expect(titles(data)).toEqual([]);
	await Bun.sleep(1);
	expect(data.sync.status()?.denied).toBe(true);
	await close();
});

test('a signed-out account is refused without creating anything', async () => {
	await resetStorage();

	// It RESOLVES the refusal rather than throwing it (ADR-0339): the boot gate
	// switches on the name, and a rejection would hand it an `unknown`.
	const opened = await handleFor(createFakeAuth({ status: 'signed-out' })).data;
	expect(opened.error?.name).toBe('Unaddressable');
	expect(await databaseNames()).toEqual([]);
});

test("another account's notes are refused, and erasing is what clears them", async () => {
	await resetStorage();
	{
		const alice = createFakeAuth({ status: 'signed-in', principalId: 'alice' });
		await importEmptyGeneration(alice);
		const { data, close } = await openedBy(alice);
		data.tables.notes.create({ title: "alice's note" });
		await close();
	}

	// Bob signs into the same machine. The address stopped carrying who owns a
	// store (ADR-0324), so what refuses him is the binding written inside it
	// (ADR-0325), and nothing merges Alice's notes into his account.
	// Bob's device holds Alice's copy, and cache-first resolution is what hands
	// him her address: nothing asks his account, because this device already
	// has a generation 1.
	const bob = createFakeAuth({ status: 'signed-in', principalId: 'bob' });
	const refused = await handleFor(bob).data;
	expect(refused.error?.name).toBe('BoundElsewhere');

	// And nothing was deleted to say so (ADR-0281). Alice comes back to hers.
	const alice = createFakeAuth({ status: 'signed-in', principalId: 'alice' });
	const back = await openedBy(alice);
	expect(titles(back.data)).toEqual(["alice's note"]);
	await back.close();

	// The person invokes the erase, and only then is the copy gone.
	const erased = await handleFor(alice).eraseReplica();
	expect(erased.error).toBeNull();
	expect(await databaseNames()).toEqual([]);
});
