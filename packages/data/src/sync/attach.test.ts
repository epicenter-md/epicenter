import { defineTable, field } from '@epicenter/data/definition';
/**
 * What the shared dial has to get right: the URL it asks for, and how it
 * classifies a rejection.
 *
 * The driver underneath is already covered by `connection.test.ts` against a
 * real hub and authority. What is only here is the translation layer, and it is
 * exactly where being wrong is expensive: calling a network blip permanent
 * gives up on a replica that would have recovered, and calling a refusal
 * transient spins the backoff against it forever.
 */

import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { defineData } from '@epicenter/data/definition';
import { asPrincipalId } from '@epicenter/principal';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { type AccountDocument, createAccountStore } from '../store/store.js';
import { attachStoreSync, type StoreSocketTransport } from './attach.js';

const database = defineData({
	id: 'so.epicenter.attach-test',
	kv: {},
	tables: { notes: defineTable({ scalars: { title: field.string() } }) },
});

type AddressedTestStore = AccountDocument & {
	baseURL: string;
	principalId: ReturnType<typeof asPrincipalId>;
};

function openStore(): AddressedTestStore {
	const live = new Database(':memory:');
	const db = createAccountStore({
		definition: database,
		sqlite: createBunSqliteAdapter(live),
		dispose: () => live.close(),
	});
	const addressed = Object.create(db) as AddressedTestStore;
	Object.defineProperties(addressed, {
		baseURL: { value: 'https://api.epicenter.test' },
		principalId: { value: asPrincipalId('alice') },
	});
	return addressed;
}

/** Record every dial and settle it however the test says. */
function createTransport(open: (url: string) => Promise<WebSocket>) {
	const urls: string[] = [];
	const transport: StoreSocketTransport = {
		openWebSocket(url) {
			urls.push(String(url));
			return open(String(url));
		},
	};
	return { transport, urls };
}

test('the first dial names the dataId and a cursor of zero', async () => {
	const store = openStore();
	await using _store = store;
	const { transport, urls } = createTransport(
		() => new Promise<WebSocket>(() => {}),
	);
	const connection = attachStoreSync({
		store,
		dataId: database.id,
		generation: 1,
		transport,
		onTransportError: (cause) => {
			throw cause;
		},
	});
	using _ = connection;

	expect(urls).toHaveLength(1);
	const url = new URL(urls[0] as string);
	expect(url.protocol).toBe('wss:');
	expect(url.pathname).toBe('/api/store/v1/sync');
	expect(url.searchParams.get('dataId')).toBe(database.id);
	expect(url.searchParams.get('cursor')).toBe('0');
	// A replica that has never synced belongs to no document yet, so it must
	// not claim one (ADR-0231).
	expect(url.searchParams.has('document')).toBe(false);
});

test('a permanent denial stops the driver and is not a transport error', async () => {
	const store = openStore();
	await using _store = store;
	const denial = {
		name: 'OpenWebSocketDenied',
		message: 'signed out',
		permanence: 'permanent',
		code: 'SignedOut',
	};
	const { transport, urls } = createTransport(() => Promise.reject(denial));
	let denials = 0;
	const transportErrors: unknown[] = [];
	const connection = attachStoreSync({
		store,
		dataId: database.id,
		generation: 1,
		transport,
		onDenied: () => denials++,
		onTransportError: (cause) => transportErrors.push(cause),
	});
	using _ = connection;

	await Bun.sleep(1);
	expect(denials).toBe(1);
	expect(transportErrors).toEqual([]);
	expect(connection.status().denied).toBe(true);
	// Stopped for good: no backoff can produce a second dial.
	expect(urls).toHaveLength(1);
});

test('a transient denial is reported and left to the backoff', async () => {
	const store = openStore();
	await using _store = store;
	const denial = {
		name: 'OpenWebSocketDenied',
		message: 'verification unreachable',
		permanence: 'transient',
		code: 'Unreachable',
	};
	const { transport } = createTransport(() => Promise.reject(denial));
	let denials = 0;
	const transportErrors: unknown[] = [];
	const connection = attachStoreSync({
		store,
		dataId: database.id,
		generation: 1,
		transport,
		onDenied: () => denials++,
		onTransportError: (cause) => transportErrors.push(cause),
	});
	using _ = connection;

	await Bun.sleep(1);
	expect(denials).toBe(0);
	expect(transportErrors).toEqual([denial]);
	expect(connection.status().denied).toBe(false);
});

test('an unrecognised rejection is a close, never a denial', async () => {
	const store = openStore();
	await using _store = store;
	const cause = new TypeError('Failed to fetch');
	const { transport } = createTransport(() => Promise.reject(cause));
	let denials = 0;
	const transportErrors: unknown[] = [];
	const connection = attachStoreSync({
		store,
		dataId: database.id,
		generation: 1,
		transport,
		onDenied: () => denials++,
		onTransportError: (error) => transportErrors.push(error),
	});
	using _ = connection;

	await Bun.sleep(1);
	expect(denials).toBe(0);
	expect(transportErrors).toEqual([cause]);
	expect(connection.status().denied).toBe(false);
});

test('abandoning an attempt closes a socket that arrives late', async () => {
	const store = openStore();
	await using _store = store;
	let closes = 0;
	const socket = {
		binaryType: '',
		addEventListener: () => {},
		close: () => closes++,
	} as unknown as WebSocket;
	const arrival = Promise.withResolvers<WebSocket>();
	const { transport } = createTransport(() => arrival.promise);
	const connection = attachStoreSync({
		store,
		dataId: database.id,
		generation: 1,
		transport,
		onTransportError: (cause) => {
			throw cause;
		},
	});

	connection[Symbol.dispose]();
	arrival.resolve(socket);
	await Bun.sleep(1);
	expect(closes).toBe(1);
});
