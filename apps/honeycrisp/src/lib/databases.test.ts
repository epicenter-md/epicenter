import 'fake-indexeddb/auto';
import { installTestLocks } from '@epicenter/data/test-locks';

installTestLocks();

import { expect, mock, test } from 'bun:test';
import type { AuthClient } from '@epicenter/auth';
import { createGeneration } from '@epicenter/data/browser';
import { InstantString } from '@epicenter/data/field';
import { encodeFrame } from '@epicenter/data/sync';
import { honeycrispDefinition } from '@epicenter/honeycrisp';
import { eraseNotesOnThisDevice, openAccountDatabase } from './databases.js';

const reloads = mock();
(globalThis as unknown as { location: unknown }).location = {
	reload: reloads,
};

/** The generation every test here works in: the one a fresh device imports. */
const GEN = 1;

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

function noteFields(title: string) {
	const timestamp = InstantString.fromDate(
		new Date('2026-08-10T00:00:00.000Z'),
	);
	return {
		title,
		pinned: false,
		createdAt: timestamp,
		updatedAt: timestamp,
		folderId: null,
		deletedAt: null,
	};
}

function titles(data: {
	tables: { notes: { readonly rows: readonly unknown[] } };
}): string[] {
	return data.tables.notes.rows
		.map((row) => (row as { title: string }).title)
		.sort();
}

function createFakeSocket() {
	const listeners = new Map<string, Set<(event: unknown) => void>>();
	const dispatch = (type: string, event: unknown) => {
		for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
	};
	const socket = {
		binaryType: 'blob' as BinaryType,
		addEventListener(type: string, listener: (event: unknown) => void) {
			const set = listeners.get(type) ?? new Set();
			set.add(listener);
			listeners.set(type, set);
		},
		send: () => undefined,
		close: () => dispatch('close', {}),
	};
	return {
		socket: socket as unknown as WebSocket,
		open: () => dispatch('open', {}),
		deliver(frame: Parameters<typeof encodeFrame>[0]) {
			const bytes = encodeFrame(frame);
			dispatch('message', { data: bytes.slice().buffer });
		},
	};
}

/**
 * The generations collection, in memory, per fake account.
 *
 * The one HTTP surface opening touches (ADR-0292, ADR-0293): a POST that
 * assigns a number and a GET that hands the state back. Held per auth client
 * so two fake accounts are two accounts.
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
		throw new Error('not part of database opening');
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

/**
 * An account whose socket opens and says nothing.
 *
 * There is nothing for it to say on connect any more. It used to announce the
 * document this replica's state had to belong to, and a replica was
 * unavailable until it heard one; the generation is in the address, so the
 * store is usable the moment it opens (ADR-0292).
 */
function connectingAuth(principalId: string) {
	const dials: ReturnType<typeof createFakeSocket>[] = [];
	const auth = createFakeAuth({
		status: 'signed-in',
		principalId,
		openWebSocket: async () => {
			const fake = createFakeSocket();
			dials.push(fake);
			setTimeout(() => fake.open(), 0);
			return fake.socket;
		},
	});
	return { auth, dials };
}

/** Create an empty generation in this account, the way a first run does. */
async function importEmptyAccountGeneration(auth: AuthClient): Promise<void> {
	const principalId =
		auth.state.status === 'signed-out' ? undefined : auth.state.principalId;
	if (principalId === undefined) throw new Error('signed out');
	const created = await createGeneration(honeycrispDefinition, {
		appId: 'so.epicenter.honeycrisp',
		account: {
			baseURL: auth.connection.baseURL,
			principalId,
			fetch: (input, init) => auth.fetch(input, init),
		},
	});
	if (created.error !== null) throw created.error;
}

test('the account opener owns only the account replica', async () => {
	await resetStorage();
	const { auth } = connectingAuth('alice');
	await importEmptyAccountGeneration(auth);
	const account = openAccountDatabase({ auth, generation: GEN });
	const accountData = (await account.ready).data;
	accountData.tables.notes.create(noteFields('account note'));

	expect(titles(accountData)).toEqual(['account note']);

	await account[Symbol.asyncDispose]();
});

test('a bound account replica opens from local storage before sync is available', async () => {
	await resetStorage();

	{
		const { auth } = connectingAuth('alice');
		await importEmptyAccountGeneration(auth);
		const account = openAccountDatabase({ auth, generation: GEN });
		(await account.ready).data.tables.notes.create(
			noteFields('offline account note'),
		);
		await account[Symbol.asyncDispose]();
	}

	const account = openAccountDatabase({
		generation: GEN,
		auth: createFakeAuth({
			status: 'signed-in',
			principalId: 'alice',
			openWebSocket: () => Promise.reject(new Error('offline')),
		}),
	});
	expect(titles((await account.ready).data)).toEqual(['offline account note']);
	await account[Symbol.asyncDispose]();
});

test('a cached account generation opens even when the credential is refused', async () => {
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
	await importEmptyAccountGeneration(refusing);

	// The reversal ADR-0292 bought. A refused credential used to REJECT the
	// boot, because a fresh replica was unavailable until the authority stamped
	// it; the store now opens from local state before a socket is attempted, so
	// a denial costs sync and not the notes.
	const account = openAccountDatabase({ auth: refusing, generation: GEN });
	const opened = await account.ready;
	expect(titles(opened.data)).toEqual([]);
	expect(opened.syncStatus()).toBeUndefined();
	await account[Symbol.asyncDispose]();
});

test('an account without a principal is refused without opening a store', async () => {
	await resetStorage();

	const account = openAccountDatabase({
		generation: GEN,
		auth: createFakeAuth({ status: 'signed-out' }),
	});
	await expect(account.ready).rejects.toMatchObject({ name: 'Unaddressable' });
	expect(await databaseNames()).toEqual([]);
	// Disposing something that never opened is a no-op rather than a throw: a
	// route registers the teardown before it knows which way the open went.
	await account[Symbol.asyncDispose]();
});

test("another account's notes are refused, and erasing is what clears them", async () => {
	await resetStorage();
	{
		const { auth } = connectingAuth('alice');
		await importEmptyAccountGeneration(auth);
		const account = openAccountDatabase({ auth, generation: GEN });
		(await account.ready).data.tables.notes.create(noteFields("alice's note"));
		await account[Symbol.asyncDispose]();
	}

	// Bob signs into the same machine. The address stopped carrying who owns a
	// store (ADR-0324), so what refuses him is the binding written inside it
	// (ADR-0325), and nothing merges Alice's notes into his account.
	const { auth: bobAuth } = connectingAuth('bob');
	const refused = openAccountDatabase({ auth: bobAuth, generation: GEN });
	await expect(refused.ready).rejects.toMatchObject({
		name: 'BoundElsewhere',
	});
	await refused[Symbol.asyncDispose]();

	// And nothing was deleted to say so (ADR-0281). Alice comes back to hers.
	const { auth: aliceAgain } = connectingAuth('alice');
	const back = openAccountDatabase({ auth: aliceAgain, generation: GEN });
	expect(titles((await back.ready).data)).toEqual(["alice's note"]);
	await back[Symbol.asyncDispose]();

	// The person invokes the erase, and only then is the copy gone.
	await eraseNotesOnThisDevice();
	expect(await databaseNames()).toEqual([]);
});
