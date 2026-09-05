import 'fake-indexeddb/auto';
import { installTestLocks } from '@epicenter/data/test-locks';

installTestLocks();

import { expect, test } from 'bun:test';
import type { AuthClient } from '@epicenter/auth';
import { createGeneration, openDatabase } from '@epicenter/data/browser';
import {
	defineData,
	defineTable,
	field,
	plainText,
} from '@epicenter/data/definition';
import { createBrowserBinding } from './browser.js';
import { createEpicenter } from './index.js';

/**
 * What an application gets when it passes a definition and an account.
 *
 * These were `apps/honeycrisp/src/lib/databases.test.ts`, against the opener
 * that application wrote for itself. The opener is here now (ADR-0339), so the
 * coverage is too: a store opens and holds rows, a second boot reads them
 * offline, a refused credential costs sync and not the notes, a signed-out
 * account is refused without creating anything, two accounts on one device
 * hold two replicas, and `eraseReplica` clears the one that asked.
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
	return createEpicenter({
		appId: APP_ID,
		definition,
		account,
		binding: createBrowserBinding(),
	});
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
	const opened = await epicenter.open();
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

test('construction acquires nothing, and opening is what does', async () => {
	await resetStorage();
	const account = createFakeAuth({ status: 'signed-in', principalId: 'alice' });
	await importEmptyGeneration(account);

	// The whole of the reason `data` stopped being a getter. Building the
	// handle claims no Web Lock, opens no IndexedDB, and makes no round trip,
	// and there is no property whose READ would.
	const before = await databaseNames();
	const epicenter = handleFor(account);
	expect(epicenter.state).toEqual({ status: 'closed' });
	// Reading every member, which is what a spread or a devtools panel does.
	// None of them is a getter that opens.
	expect({ ...epicenter }.appId).toBe(APP_ID);
	expect(epicenter.state).toEqual({ status: 'closed' });
	expect(await databaseNames()).toEqual(before);

	// Another handle can still take the claim, because nobody has taken it.
	const other = await openedBy(account);
	await other.close();

	const opened = await epicenter.open();
	expect(opened.error).toBeNull();
	expect(epicenter.state.status).toBe('ready');
	await epicenter.close();
});

test('opening twice is one open, and a second handle is refused', async () => {
	await resetStorage();
	const account = createFakeAuth({ status: 'signed-in', principalId: 'alice' });
	await importEmptyGeneration(account);

	// Two calls while it is opening join one attempt, which is what keeps a
	// second caller from claiming a Web Lock the first one is taking.
	const epicenter = handleFor(account);
	const [first, second] = await Promise.all([
		epicenter.open(),
		epicenter.open(),
	]);
	if (first.error !== null) throw first.error;
	if (second.error !== null) throw second.error;
	expect(second.data).toBe(first.data);

	// A call once it is ready acquires nothing and answers the same store.
	expect((await epicenter.open()).data).toBe(first.data);

	// A SECOND handle is a second claim, and the store refuses it. That is the
	// dev-time shape of this: an application constructs one handle per page,
	// and hot-reloading the module that constructs it meets this until the
	// first one is closed.
	const other = await handleFor(account).open();
	expect(other.error?.name).toBe('AlreadyOpen');

	await epicenter.close();
});

test('opening a ready session answers it and publishes nothing', async () => {
	await resetStorage();
	const account = createFakeAuth({ status: 'signed-in', principalId: 'alice' });
	await importEmptyGeneration(account);

	const epicenter = handleFor(account);
	const first = await epicenter.open();
	if (first.error !== null) throw first.error;

	// That a repeat open answers the SAME store is asserted above. This is the
	// other half of "acquires nothing", and it is the half a surface can see: a
	// repeat must publish no transition at all. `fromEpicenter` mirrors every
	// published state into a rune and runs `fromData` on each `ready`, so a
	// republished `opening` would take an open UI back to its loading screen and
	// a republished `ready` would build a second projection of every table over
	// the one store.
	const seen: string[] = [];
	const stop = epicenter.onStateChange((state) => seen.push(state.status));
	const again = await epicenter.open();
	stop();

	if (again.error !== null) throw again.error;
	expect(again.data).toBe(first.data);
	expect(seen).toEqual([]);
	expect(epicenter.state.status).toBe('ready');

	await epicenter.close();
});

test('the states a session reports are the transitions it makes', async () => {
	await resetStorage();
	const account = createFakeAuth({ status: 'signed-in', principalId: 'alice' });
	await importEmptyGeneration(account);

	const epicenter = handleFor(account);
	const seen: string[] = [];
	const stop = epicenter.onStateChange((state) => seen.push(state.status));

	await epicenter.open();
	await epicenter.close();
	stop();
	// Nothing after the unsubscribe reaches it.
	await epicenter.open();
	await epicenter.close();

	expect(seen).toEqual(['opening', 'ready', 'closed']);
});

test('the data a ready session hands over cannot end the session', async () => {
	await resetStorage();
	const account = createFakeAuth({ status: 'signed-in', principalId: 'alice' });
	await importEmptyGeneration(account);

	const epicenter = handleFor(account);
	await epicenter.open();
	if (epicenter.state.status !== 'ready') throw new Error('not ready');
	const { data } = epicenter.state;

	// The lock, the socket, and the listener were acquired together and are
	// released together (ADR-0340). A store that could free one of the three
	// would leave a connection dialling against a dead document, so the store
	// carries no way to try.
	for (const verb of ['close', 'open', 'erase', 'eraseReplica', 'dispose']) {
		expect(verb in data).toBe(false);
	}
	expect(Symbol.dispose in data).toBe(false);
	expect(Symbol.asyncDispose in data).toBe(false);

	await epicenter.close();
});

test('closing releases the claim, and the same handle opens again', async () => {
	await resetStorage();
	const account = createFakeAuth({ status: 'signed-in', principalId: 'alice' });
	await importEmptyGeneration(account);

	const epicenter = handleFor(account);
	const first = await epicenter.open();
	if (first.error !== null) throw first.error;
	first.data.tables.notes.create({ title: 'before' });

	// `close` ends all three things opening acquired: the socket, the page-hide
	// listener, and the document holding the Web Lock. Twice is once.
	await Promise.all([epicenter.close(), epicenter.close()]);
	expect(epicenter.state).toEqual({ status: 'closed' });
	expect(() => first.data.tables.notes.rows).toThrow();

	// `closed` after a close is the same `closed` a fresh handle starts in, so
	// the verb that acquires works from it. What comes back is a NEW store over
	// the durable record the first one left.
	const again = await epicenter.open();
	if (again.error !== null) throw again.error;
	expect(again.data).not.toBe(first.data);
	expect(titles(again.data)).toEqual(['before']);
	await epicenter.close();
});

test('a close that races an open ends what the open acquired', async () => {
	await resetStorage();
	const account = createFakeAuth({ status: 'signed-in', principalId: 'alice' });
	await importEmptyGeneration(account);

	// The hot-reload shape: the module that built the handle is replaced while
	// its open is still in flight. The close must not return while a lock is
	// still being taken, and the session must never report `ready` for a store
	// nobody can reach.
	const epicenter = handleFor(account);
	const opening = epicenter.open();
	await epicenter.close();
	expect(epicenter.state).toEqual({ status: 'closed' });

	// The caller who awaited the open is TOLD, rather than handed `Ok` over a
	// store whose every verb throws. `state` says `closed` and the promise says
	// why: two channels for one fact have to agree.
	const opened = await opening;
	expect(opened.error?.name).toBe('SessionClosed');

	// And the claim it took is free, which is the whole point of awaiting it.
	const next = await openedBy(account);
	expect(titles(next.data)).toEqual([]);
	await next.close();

	// The other half of the same race: an open that starts while the closed one
	// is still letting go must not meet a conflict with no other window in it.
	const again = handleFor(account);
	const racing = again.open();
	const ending = again.close();
	const reopened = again.open();
	await Promise.all([racing, ending]);
	const settled = await reopened;
	if (settled.error !== null) throw settled.error;
	expect(again.state.status).toBe('ready');
	await again.close();
});

test('a second close awaits the first rather than reporting it done', async () => {
	await resetStorage();
	const account = createFakeAuth({ status: 'signed-in', principalId: 'alice' });
	await importEmptyGeneration(account);

	const epicenter = handleFor(account);
	await epicenter.open();

	// Not `Promise.all`, deliberately: awaiting only the SECOND close is the
	// case that used to resolve while the first was still letting go of the
	// lock, because the second found `held` already cleared and had nothing to
	// wait on. A caller that then opened met a conflict with no other window.
	const first = epicenter.close();
	await epicenter.close();
	expect(epicenter.state).toEqual({ status: 'closed' });
	const next = handleFor(account);
	expect((await next.open()).error).toBeNull();
	await next.close();
	await first;
});

test('a listener told about `opening` joins the attempt rather than starting one', async () => {
	await resetStorage();
	const account = createFakeAuth({ status: 'signed-in', principalId: 'alice' });
	await importEmptyGeneration(account);

	// A subscriber is free to call `open` while it is being told, and the
	// state is published only after the attempt is recorded, so what it gets is
	// the attempt already running. Publishing first meant a second claim on one
	// address, answered as a conflict.
	const epicenter = handleFor(account);
	let joined: ReturnType<typeof epicenter.open> | undefined;
	const stop = epicenter.onStateChange((next) => {
		if (next.status === 'opening') joined = epicenter.open();
	});

	const opened = await epicenter.open();
	stop();
	if (opened.error !== null) throw opened.error;
	expect((await joined)?.data).toBe(opened.data);
	expect(epicenter.state.status).toBe('ready');
	await epicenter.close();
});

test('a failed open leaks nothing, and opening again is the retry', async () => {
	await resetStorage();
	const account = createFakeAuth({ status: 'signed-in', principalId: 'alice' });
	await importEmptyGeneration(account);

	// The live failure a person meets: another context holds the document. It
	// is repaired by that context letting go, which is a repair nobody can
	// perform if the answer is memoized.
	const holder = handleFor(account);
	await holder.open();

	const epicenter = handleFor(account);
	const refused = await epicenter.open();
	expect(refused.error?.name).toBe('AlreadyOpen');
	const failed: { status: string; error?: unknown } = epicenter.state;
	expect(failed.status).toBe('failed');
	expect(failed.error).toBe(refused.error);

	await holder.close();

	const retried = await epicenter.open();
	if (retried.error !== null) throw retried.error;
	expect(epicenter.state.status).toBe('ready');
	await epicenter.close();
});

test('an opener that rejects fails the session rather than wedging it', async () => {
	await resetStorage();

	// Nothing is known to reach this arm: `openReplica` resolves a `Result` and
	// contains its own throws. It exists because a promise that breaks that
	// contract anyway would leave the in-flight attempt recorded forever, and
	// then every later `open` replays one rejection, `close` rethrows it, and the
	// session has no way out of `opening`.
	//
	// A client carrying no connection is the cheapest way to make the opener
	// throw instead of resolve: the address is read before anything is claimed or
	// created, so this reaches the containment and nothing else.
	const broken = {
		...createFakeAuth({ status: 'signed-in', principalId: 'alice' }),
		connection: undefined,
	} as unknown as AuthClient;
	const epicenter = handleFor(broken);

	const threw = await epicenter.open();
	expect(threw.error?.name).toBe('OpenerThrew');
	const failed: { status: string; error?: unknown } = epicenter.state;
	expect(failed.status).toBe('failed');
	expect(failed.error).toBe(threw.error);

	// The way out, and it is the same way out every other failure has: opening
	// again runs a second attempt rather than replaying the first one's
	// rejection, which is what a memoized in-flight attempt would have done.
	const again = await epicenter.open();
	expect(again.error?.name).toBe('OpenerThrew');
	expect(again.error).not.toBe(threw.error);

	// And closing returns rather than rethrowing what the attempt rejected with.
	await epicenter.close();
	expect(epicenter.state).toEqual({ status: 'closed' });
	expect(await databaseNames()).toEqual([]);
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
				code: 'reauth-required',
			}),
	});
	await importEmptyGeneration(refusing);

	// The reversal ADR-0292 bought. A fresh replica used to be unavailable
	// until the authority stamped it; the store opens from local state before a
	// socket is attempted, so a refusal is a quiet status line and the notes
	// still read.
	const { data, close } = await openedBy(refusing);
	await Bun.sleep(1);
	expect(data.sync.status()?.refusal).toBe('reauth-required');

	// The notes half, and the whole of what "costs sync, not the notes" claims:
	// a store whose every dial is refused still takes a write and reads it back.
	data.tables.notes.create({ title: 'written while refused' });
	expect(titles(data)).toEqual(['written while refused']);
	await close();
});

test('a signed-out account is refused without creating anything', async () => {
	await resetStorage();

	// It RESOLVES the refusal rather than throwing it (ADR-0339): the boot node
	// switches on the name, and a rejection would hand it an `unknown`.
	const opened = await handleFor(
		createFakeAuth({ status: 'signed-out' }),
	).open();
	expect(opened.error?.name).toBe('Unaddressable');
	expect(await databaseNames()).toEqual([]);
});

test('two accounts on one device hold two replicas', async () => {
	await resetStorage();
	{
		const alice = createFakeAuth({ status: 'signed-in', principalId: 'alice' });
		await importEmptyGeneration(alice);
		const { data, close } = await openedBy(alice);
		data.tables.notes.create({ title: "alice's note" });
		await close();
	}

	// Bob signs into the same machine. The principal is a segment of the
	// address, so cache-first resolution never hands him Alice's copy: he asks
	// his own account, mints his own generation, and opens it. There is no
	// refusal to render and nothing for a person to repair.
	const bob = createFakeAuth({ status: 'signed-in', principalId: 'bob' });
	await importEmptyGeneration(bob);
	const bobOpened = await openedBy(bob);
	expect(titles(bobOpened.data)).toEqual([]);
	bobOpened.data.tables.notes.create({ title: "bob's note" });
	await bobOpened.close();

	// And neither replica saw the other. Alice comes back to hers.
	const alice = createFakeAuth({ status: 'signed-in', principalId: 'alice' });
	const back = await openedBy(alice);
	expect(titles(back.data)).toEqual(["alice's note"]);
	await back.close();

	// Alice forgets this device. Bob's copy is untouched, because an erase
	// reaches only the account that asked for it.
	const erased = await handleFor(alice).eraseReplica();
	expect(erased.error).toBeNull();
	const remaining = await databaseNames();
	expect(remaining.some((name) => name.includes('/bob/'))).toBe(true);
	expect(remaining.some((name) => name.includes('/alice/'))).toBe(false);
});

test('a ready session erases itself: it closes first', async () => {
	await resetStorage();
	const account = createFakeAuth({ status: 'signed-in', principalId: 'alice' });
	await importEmptyGeneration(account);

	const epicenter = handleFor(account);
	await epicenter.open();
	expect(epicenter.state.status).toBe('ready');

	// The live path: a person invokes this from an account surface while their
	// data is open. Erasing takes the Web Lock this session is holding, and the
	// handle is the one thing that can let it go, so the verb closes rather than
	// refusing itself with `AlreadyOpen`.
	const erased = await epicenter.eraseReplica();
	expect(erased.error).toBeNull();
	expect(epicenter.state.status).toBe('closed');
	expect(await databaseNames()).toEqual([]);
});

test('a ready session whose erase fails is ready again', async () => {
	await resetStorage();
	const account = createFakeAuth({ status: 'signed-in', principalId: 'alice' });
	// Two generations, so one can be held open by something this handle does not
	// own. Erasing claims every generation under the prefix before deleting any,
	// so a second window on the older one refuses the whole erase (ADR-0281).
	await importEmptyGeneration(account);
	await importEmptyGeneration(account);

	const epicenter = handleFor(account);
	await epicenter.open();
	expect(epicenter.state.status).toBe('ready');

	const other = await openDatabase(definition, {
		appId: APP_ID,
		generation: 1,
		account: {
			baseURL: account.connection.baseURL,
			principalId: 'alice' as never,
			fetch: (input, init) => account.fetch(input, init),
		},
	});
	if (other.error !== null) throw other.error;

	// Closing is what the deletion needs, not the deletion. When the deletion
	// does not happen, a session that was serving data has to be serving it
	// again: otherwise the surface that invoked this unmounts, the failure is
	// reported to nobody, and the person is left with no data and no button.
	const refused = await epicenter.eraseReplica();
	expect(refused.error?.name).toBe('AlreadyOpen');
	// The reopen is in flight rather than awaited, so what the caller must never
	// see is `closed`: that is the dead state, the one nothing leaves on its own
	// and no boot node offers a button for. `opening` resolves itself.
	expect(epicenter.state.status).toBe('opening');
	// And it resolves to the session that was there before. Joining the
	// in-flight attempt is what a second `open` does, so this waits rather than
	// starting a rival.
	expect((await epicenter.open()).error).toBeNull();
	expect(epicenter.state.status).toBe('ready');
	expect(await databaseNames()).not.toEqual([]);

	await other.data.close();
	await epicenter.close();
});
