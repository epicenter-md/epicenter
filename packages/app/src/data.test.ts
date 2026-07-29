/**
 * Installed App Data Lifecycle Tests
 *
 * Verifies the client owns the host surface it opens and reports traversal
 * failures through its declared Result errors.
 *
 * Key behaviors:
 * - A failed initial observation carrier releases the opened host surface
 * - A rejected scan returns the client's DataFailed variant
 */

import { afterEach, expect, test } from 'bun:test';
import { defineLens, defineTable, field } from '@epicenter/lens';
import { expectErr, expectOk } from 'wellcrafted/testing';

import { data } from './data.js';

const lens = defineLens({
	namespace: 'so.epicenter.app.data.tests',
	tables: {
		notes: defineTable({ fields: { title: field.string() } }),
	},
	values: {},
});

const originalDescriptors = new Map<string, PropertyDescriptor | undefined>();

afterEach(() => {
	for (const [name, descriptor] of originalDescriptors) {
		if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
		else Object.defineProperty(globalThis, name, descriptor);
	}
	originalDescriptors.clear();
});

test.each([
	['closes before opening', () => ClosingSocket],
	['throws while dialing', () => ThrowingSocket],
] as const)('a carrier that %s releases the surface opened by bind', async (_case, socketType) => {
	const operations: string[] = [];
	installHost({
		operations,
		socket: socketType(),
	});

	const error = expectErr(await data.bind(lens));

	expect(error.name).toBe('DataUnavailable');
	expect(operations).toEqual(['open', 'disconnect']);
});

test('scan returns DataFailed when the host rejects its traversal', async () => {
	installHost({
		operations: [],
		socket: OpeningSocket,
		answer(operation) {
			return operation === 'table-entries-page'
				? {
						data: null,
						error: { name: 'TraversalRefused', message: 'not readable' },
					}
				: { data: null, error: null };
		},
	});
	const bound = expectOk(await data.bind(lens));

	const error = expectErr(await bound.tables.notes.scan());

	expect(error.name).toBe('DataFailed');
	if (error.name === 'DataFailed') {
		expect(error.operation).toBe('table-entries-page');
	}
	await bound.close();
});

type SocketConstructor = new (url: string | URL) => TestSocket;

function installHost({
	operations,
	socket,
	answer = () => ({ data: null, error: null }),
}: {
	operations: string[];
	socket: SocketConstructor;
	answer?: (
		operation: string,
	) =>
		| { data: unknown; error: null }
		| { data: null; error: { name: string; message: string } };
}): void {
	defineGlobal('window', { __TAURI_INTERNALS__: {} });
	defineGlobal('location', { origin: 'http://epicenter.test' });
	defineGlobal('WebSocket', socket);
	defineGlobal(
		'fetch',
		async (_input: RequestInfo | URL, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as {
				operation: { kind: string };
			};
			operations.push(body.operation.kind);
			return Response.json(answer(body.operation.kind));
		},
	);
}

function defineGlobal(name: string, value: unknown): void {
	if (!originalDescriptors.has(name)) {
		originalDescriptors.set(
			name,
			Object.getOwnPropertyDescriptor(globalThis, name),
		);
	}
	Object.defineProperty(globalThis, name, {
		value,
		configurable: true,
		writable: true,
	});
}

class TestSocket {
	readonly listeners = new Map<string, (() => void)[]>();

	constructor(initialEvent: 'open' | 'close') {
		queueMicrotask(() => this.emit(initialEvent));
	}

	addEventListener(type: string, listener: () => void): void {
		const listeners = this.listeners.get(type) ?? [];
		listeners.push(listener);
		this.listeners.set(type, listeners);
	}

	close(): void {}

	private emit(type: string): void {
		for (const listener of this.listeners.get(type) ?? []) listener();
	}
}

class ClosingSocket extends TestSocket {
	constructor(_url: string | URL) {
		super('close');
	}
}

class OpeningSocket extends TestSocket {
	constructor(_url: string | URL) {
		super('open');
	}
}

class ThrowingSocket extends TestSocket {
	constructor(_url: string | URL) {
		super('close');
		throw new Error('dial failed');
	}
}
