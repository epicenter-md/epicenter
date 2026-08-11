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
import { defineLens } from '@epicenter/lens';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { createReplicaStore, type ReplicaStore } from '../store/store.js';
import { attachStoreSync, type StoreSocketTransport } from './attach.js';

const lens = defineLens({
	namespace: 'so.epicenter.attach-test',
	tables: { notes: { title: 'string' } },
});

function openStore(): ReplicaStore {
	const live = new Database(':memory:');
	const store = createReplicaStore({
		database: createBunSqliteAdapter(live),
		dispose: () => live.close(),
	});
	const view = store.bind(lens);
	if (view.error !== null) throw view.error;
	return store;
}

/** Record every dial and settle it however the test says. */
function createTransport(open: (url: string) => Promise<WebSocket>) {
	const urls: string[] = [];
	const transport: StoreSocketTransport = {
		baseURL: 'https://api.epicenter.test',
		openWebSocket(url) {
			urls.push(String(url));
			return open(String(url));
		},
	};
	return { transport, urls };
}

test('the first dial names the namespace and a cursor of zero', async () => {
	await using store = openStore();
	const { transport, urls } = createTransport(
		() => new Promise<WebSocket>(() => {}),
	);
	const connection = attachStoreSync({
		store,
		namespace: lens.namespace,
		transport,
		onSuperseded: () => {},
		onTransportError: (cause) => {
			throw cause;
		},
	});
	using _ = connection;

	expect(urls).toHaveLength(1);
	const url = new URL(urls[0] as string);
	expect(url.protocol).toBe('wss:');
	expect(url.pathname).toBe('/api/store/v1/sync');
	expect(url.searchParams.get('namespace')).toBe(lens.namespace);
	expect(url.searchParams.get('cursor')).toBe('0');
	// A replica that has never synced belongs to no document yet, so it must
	// not claim one (ADR-0231).
	expect(url.searchParams.has('document')).toBe(false);
});

test('a permanent denial stops the driver and is not a transport error', async () => {
	await using store = openStore();
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
		namespace: lens.namespace,
		transport,
		onSuperseded: () => {},
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
	await using store = openStore();
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
		namespace: lens.namespace,
		transport,
		onSuperseded: () => {},
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
	await using store = openStore();
	const cause = new TypeError('Failed to fetch');
	const { transport } = createTransport(() => Promise.reject(cause));
	let denials = 0;
	const transportErrors: unknown[] = [];
	const connection = attachStoreSync({
		store,
		namespace: lens.namespace,
		transport,
		onSuperseded: () => {},
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
	await using store = openStore();
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
		namespace: lens.namespace,
		transport,
		onSuperseded: () => {},
		onTransportError: (cause) => {
			throw cause;
		},
	});

	connection[Symbol.dispose]();
	arrival.resolve(socket);
	await Bun.sleep(1);
	expect(closes).toBe(1);
});
