import 'fake-indexeddb/auto';
import { installTestLocks } from '@epicenter/data/test-locks';

installTestLocks();
import { expect, mock, test } from 'bun:test';
import type { AuthClient } from '@epicenter/auth';
import { encodeFrame } from '@epicenter/data/sync';
import { InstantString } from '@epicenter/field';
import { honeycrispDefinition } from '@epicenter/honeycrisp';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { openAccountDatabase, openLocalDatabase } from './databases.js';

const reloads = mock();
(globalThis as unknown as { location: unknown }).location = {
	reload: reloads,
};

const LOCAL = `epicenter/v1/${honeycrispDefinition.id}/local`;

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
		preview: '',
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
		fetch: unused,
		getProfile: unused,
		openWebSocket,
		[Symbol.dispose]: () => undefined,
	} as unknown as AuthClient;
}

function announcingAuth(principalId: string, documentId: string) {
	const dials: ReturnType<typeof createFakeSocket>[] = [];
	const auth = createFakeAuth({
		status: 'signed-in',
		principalId,
		openWebSocket: async () => {
			const fake = createFakeSocket();
			dials.push(fake);
			setTimeout(() => {
				fake.open();
				fake.deliver({ kind: 'document', id: documentId });
			}, 0);
			return fake.socket;
		},
	});
	return { auth, dials };
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

	const first = expectOk(await openLocalDatabase());
	first.data.tables.notes.create(noteFields('local note'));
	await first[Symbol.asyncDispose]();

	const second = expectOk(await openLocalDatabase());
	expect(titles(second.data)).toEqual(['local note']);
	await second[Symbol.asyncDispose]();

	expect(await databaseNames()).toEqual([LOCAL]);
});

test('the account opener owns only the account replica', async () => {
	await resetStorage();
	const local = expectOk(await openLocalDatabase());
	local.data.tables.notes.create(noteFields('local note'));

	const { auth } = announcingAuth('alice', 'document-alice');
	const account = expectOk(await openAccountDatabase({ auth }));
	expect((await account.ready).error).toBeNull();
	account.data.tables.notes.create(noteFields('account note'));

	expect(titles(local.data)).toEqual(['local note']);
	expect(titles(account.data)).toEqual(['account note']);

	await account[Symbol.asyncDispose]();
	await local[Symbol.asyncDispose]();
});

test('a bound account replica opens from local storage before sync is available', async () => {
	await resetStorage();

	{
		const { auth } = announcingAuth('alice', 'document-alice');
		const account = expectOk(await openAccountDatabase({ auth }));
		await account.ready;
		account.data.tables.notes.create(noteFields('offline account note'));
		await account[Symbol.asyncDispose]();
	}

	const account = expectOk(
		await openAccountDatabase({
			auth: createFakeAuth({
				status: 'signed-in',
				principalId: 'alice',
				openWebSocket: () => Promise.reject(new Error('offline')),
			}),
		}),
	);
	expect((await account.ready).error).toBeNull();
	expect(titles(account.data)).toEqual(['offline account note']);
	await account[Symbol.asyncDispose]();
});

test('a fresh account reports credential refusal through readiness', async () => {
	await resetStorage();

	const account = expectOk(
		await openAccountDatabase({
			auth: createFakeAuth({
				status: 'reauth-required',
				principalId: 'alice',
				openWebSocket: () =>
					Promise.reject({
						name: 'OpenWebSocketDenied',
						permanence: 'permanent',
						code: 'reauth-required',
					}),
			}),
		}),
	);

	const failure = expectErr(await account.ready);
	expect(failure).toMatchObject({ name: 'CredentialRefused' });
	await account[Symbol.asyncDispose]();
});

test('an account without a principal is refused without opening a store', async () => {
	await resetStorage();

	const failure = expectErr(
		await openAccountDatabase({
			auth: createFakeAuth({ status: 'signed-out' }),
		}),
	);
	expect(failure).toMatchObject({ name: 'Unaddressable' });
	expect(await databaseNames()).toEqual([]);
});

test('supersession reloads without touching the local database', async () => {
	await resetStorage();
	reloads.mockClear();

	const local = expectOk(await openLocalDatabase());
	local.data.tables.notes.create(noteFields('kept local note'));
	const { auth, dials } = announcingAuth('alice', 'document-alice');
	const account = expectOk(await openAccountDatabase({ auth }));
	await account.ready;

	const socket = dials.at(-1);
	if (socket === undefined) throw new Error('account never dialled');
	socket.deliver({ kind: 'document', id: 'document-alice-two' });
	await until(() => reloads.mock.calls.length > 0);

	await account[Symbol.asyncDispose]();
	expect(titles(local.data)).toEqual(['kept local note']);
	await local[Symbol.asyncDispose]();
});
