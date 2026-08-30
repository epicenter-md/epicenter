import 'fake-indexeddb/auto';
import { installTestLocks } from '@epicenter/data/test-locks';

installTestLocks();

import { expect, mock, test } from 'bun:test';
import type { AuthClient } from '@epicenter/auth';
import { readArtifact } from '@epicenter/data/artifact';
import { importGeneration } from '@epicenter/data/browser';
import { encodeFrame } from '@epicenter/data/sync';
import { InstantString } from '@epicenter/field';
import { honeycrispDefinition } from '@epicenter/honeycrisp';
import {
	openAccountDatabase,
	openLocalDatabase,
	resolveLocalGeneration,
} from './databases.js';

const reloads = mock();
(globalThis as unknown as { location: unknown }).location = {
	reload: reloads,
};

/** The generation every test here works in: the one a fresh device imports. */
const GEN = 1;
const LOCAL = `epicenter/v2/${honeycrispDefinition.id}/local/gen/${GEN}`;

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
	tables: { notes: { list(): { rows: unknown[] } } };
}): string[] {
	return data.tables.notes
		.list()
		.rows.map((row) => (row as { title: string }).title)
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

/** Import an empty generation into this account, the way a first run does. */
async function importEmptyAccountGeneration(auth: AuthClient): Promise<void> {
	const state = readArtifact(new Map(), honeycrispDefinition);
	if (state.error !== null) throw state.error;
	const principalId =
		auth.state.status === 'signed-out' ? undefined : auth.state.principalId;
	if (principalId === undefined) throw new Error('signed out');
	const created = await importGeneration(honeycrispDefinition, state.data, {
		account: {
			baseURL: auth.connection.baseURL,
			principalId,
			fetch: (input, init) => auth.fetch(input, init),
		},
	});
	if (created.error !== null) throw created.error;
}

async function until(condition: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 400; attempt += 1) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error('timed out');
}

test('the local opener owns only the local database', async () => {
	await resetStorage();
	// Resolving is what creates generation 1 on a device holding none: an
	// import of an empty folder, which is what "a new database here" means
	// when importing is the only way a generation comes into being (ADR-0293).
	expect(await resolveLocalGeneration()).toBe(GEN);

	const first = openLocalDatabase(GEN);
	(await first.ready).data.tables.notes.create(noteFields('local note'));
	await first[Symbol.asyncDispose]();

	const second = openLocalDatabase(GEN);
	expect(titles((await second.ready).data)).toEqual(['local note']);
	await second[Symbol.asyncDispose]();

	expect(await databaseNames()).toEqual([LOCAL]);
});

test('resolving twice reuses the generation rather than importing another', async () => {
	await resetStorage();
	expect(await resolveLocalGeneration()).toBe(GEN);
	expect(await resolveLocalGeneration()).toBe(GEN);
	expect(await databaseNames()).toEqual([LOCAL]);
});

test('a generation this device does not hold refuses to open', async () => {
	await resetStorage();
	// A number in a URL is an address, not an instruction to allocate, so a
	// route that lands on one nobody made renders a failure.
	const missing = openLocalDatabase(9);
	await expect(missing.ready).rejects.toMatchObject({
		name: 'GenerationNotFound',
	});
	await missing[Symbol.asyncDispose]();
});

test('the account opener owns only the account replica', async () => {
	await resetStorage();
	await resolveLocalGeneration();
	const local = openLocalDatabase(GEN);
	const localData = (await local.ready).data;
	localData.tables.notes.create(noteFields('local note'));

	const { auth } = connectingAuth('alice');
	await importEmptyAccountGeneration(auth);
	const account = openAccountDatabase({ auth, generation: GEN });
	const accountData = (await account.ready).data;
	accountData.tables.notes.create(noteFields('account note'));

	expect(titles(localData)).toEqual(['local note']);
	expect(titles(accountData)).toEqual(['account note']);

	await account[Symbol.asyncDispose]();
	await local[Symbol.asyncDispose]();
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
