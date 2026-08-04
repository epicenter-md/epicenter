/**
 * Installed App Data Lifecycle Tests
 *
 * Verifies the observation transport a document owns: it is opened once for
 * however many Lenses are bound, it heals every binding after a carrier gap, it
 * releases the host surface it opened when a bind cannot be completed, and it
 * can be opened again afterwards.
 *
 * The real host answers these operations in
 * `apps/epicenter/src/app-client-data-parity.test.ts`. What is faked here is
 * timing: a socket that fails its dial, and a socket that drops after opening,
 * are not things a healthy host will do on request.
 *
 * Key behaviors:
 * - A failed initial observation carrier releases the opened host surface
 * - A later bind retries rather than replaying the refusal
 * - Two binds share one host surface and one socket; the last one closes it
 * - A carrier gap invalidates handles from every live binding
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
});

/** A second contract, because one app may declare more than one namespace. */
const otherLens = defineLens({
	namespace: 'so.epicenter.app.other.tests',
	tables: {
		tags: defineTable({ fields: { label: field.string() } }),
		settings: defineTable({ fields: { theme: field.string() } }),
	},
});

/** Every dial succeeds. */
const dialOpens = (socket: TestSocket) => socket.open();
/** Every dial reaches a socket that closes before it ever opens. */
const dialCloses = (socket: TestSocket) => socket.drop();
/** No socket is ever constructed, the way a missing `WebSocket` fails. */
const dialThrows = () => {
	throw new Error('dial failed');
};
/**
 * The first dial opens and every redial waits to be opened by hand, so a test
 * can hold the carrier in the gap and inspect it there.
 */
const dialOpensThenWaits = (socket: TestSocket, attempt: number) => {
	if (attempt === 0) socket.open();
};

const originalDescriptors = new Map<string, PropertyDescriptor | undefined>();

afterEach(() => {
	for (const [name, descriptor] of originalDescriptors) {
		if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
		else Object.defineProperty(globalThis, name, descriptor);
	}
	originalDescriptors.clear();
});

test.each([
	['closes before opening', dialCloses],
	['throws while dialing', dialThrows],
] as const)('a carrier that %s releases the surface opened by bind', async (_case, dial) => {
	const host = installHost({ dial });

	const error = expectErr(await data.bind(lens));

	expect(error.name).toBe('DataUnavailable');
	expect(host.operations).toEqual(['open', 'disconnect']);
});

test('a bind after a failed acquisition opens a new surface instead of replaying it', async () => {
	const failed = installHost({ dial: dialCloses });
	expectErr(await data.bind(lens));

	const host = installHost({ dial: dialOpens });
	const bound = expectOk(await data.bind(lens));

	expect(host.operations).toEqual(['open']);
	// A retry is a new surface, never the one the failed bind gave back.
	expect([...host.surfaceIds]).not.toEqual([...failed.surfaceIds]);
	await bound[Symbol.asyncDispose]();
});

test('binds in one document share one host surface until the last one closes', async () => {
	const host = installHost({ dial: dialOpens });

	// Started in the same tick, so they race for the transport the way two
	// modules of one app would.
	const [first, second] = await Promise.all([
		data.bind(lens),
		data.bind(otherLens),
	]);
	const notes = expectOk(first);
	const tags = expectOk(second);

	expect(host.operations).toEqual(['open']);
	expect(host.surfaceIds.size).toBe(1);
	expect(host.sockets.length).toBe(1);

	await notes[Symbol.asyncDispose]();
	// One binding letting go is not the document letting go.
	expect(host.operations).toEqual(['open']);
	expect(host.sockets[0]?.isClosed).toBeFalse();
	// Its handles refuse further use rather than reaching a surface it gave up.
	expect(expectErr(await notes.notes.scan()).name).toBe('DataFailed');

	await tags[Symbol.asyncDispose]();
	expect(host.operations).toEqual(['open', 'disconnect']);
	expect(host.sockets[0]?.isClosed).toBeTrue();
});

test('a carrier gap invalidates the handles of every live binding', async () => {
	const host = installHost({ dial: dialOpensThenWaits });
	const notes = expectOk(await data.bind(lens));
	const tags = expectOk(await data.bind(otherLens));

	const notesScopes: string[] = [];
	const tagScopes: string[] = [];
	let themeInvalidations = 0;
	notes.notes.subscribe((each) => notesScopes.push(each.scope));
	tags.tags.subscribe((each) => tagScopes.push(each.scope));
	tags.settings.subscribe(() => {
		themeInvalidations += 1;
	});

	// The carrier drops. Nothing on the wire says what was missed, so the
	// strongest honest statement is that everything reachable may be stale.
	host.sockets[0]?.drop();
	await waitFor(() => host.sockets.length > 1);
	expect(notesScopes).toEqual([]);

	host.sockets[1]?.open();
	await waitFor(() => notesScopes.length > 0 && tagScopes.length > 0);
	expect(notesScopes).toEqual(['table']);
	expect(tagScopes).toEqual(['table']);
	expect(themeInvalidations).toBe(1);

	await notes[Symbol.asyncDispose]();
	await tags[Symbol.asyncDispose]();
});

test('scan returns DataFailed when the host rejects its traversal', async () => {
	const host = installHost({
		dial: dialOpens,
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

	const error = expectErr(await bound.notes.scan());

	expect(error.name).toBe('DataFailed');
	if (error.name === 'DataFailed') {
		expect(error.operation).toBe('table-entries-page');
	}
	expect(host.operations).toContain('table-entries-page');
	await bound[Symbol.asyncDispose]();
});

/**
 * Stand in for an Epicenter host: the two globals the client reads to decide it
 * is inside one, a `WebSocket` whose dials the test scripts, and a `fetch` that
 * records what the client asked for and on whose behalf.
 */
function installHost({
	dial,
	answer = () => ({ data: null, error: null }),
}: {
	dial: (socket: TestSocket, attempt: number) => void;
	answer?: (
		operation: string,
	) =>
		| { data: unknown; error: null }
		| { data: null; error: { name: string; message: string } };
}) {
	const operations: string[] = [];
	const surfaceIds = new Set<string>();
	const sockets: TestSocket[] = [];

	defineGlobal('window', { __TAURI_INTERNALS__: {} });
	defineGlobal('location', { origin: 'http://epicenter.test' });
	defineGlobal(
		'WebSocket',
		class extends TestSocket {
			constructor(_url: string | URL) {
				super();
				const attempt = sockets.length;
				sockets.push(this);
				dial(this, attempt);
			}
		},
	);
	defineGlobal(
		'fetch',
		async (_input: RequestInfo | URL, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as {
				surfaceId: string;
				operation: { kind: string };
			};
			operations.push(body.operation.kind);
			surfaceIds.add(body.surfaceId);
			return Response.json(answer(body.operation.kind));
		},
	);

	return { operations, surfaceIds, sockets };
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

/**
 * A socket whose events a test fires by hand.
 *
 * `open` and `drop` land on the next microtask because the client registers its
 * listeners after the constructor returns, exactly as it would with a real
 * `WebSocket`.
 */
class TestSocket {
	readonly listeners = new Map<string, (() => void)[]>();
	isClosed = false;

	addEventListener(type: string, listener: () => void): void {
		const listeners = this.listeners.get(type) ?? [];
		listeners.push(listener);
		this.listeners.set(type, listeners);
	}

	close(): void {
		this.isClosed = true;
	}

	open(): void {
		queueMicrotask(() => this.emit('open'));
	}

	/** Lose the carrier without anyone having asked for it. */
	drop(): void {
		this.isClosed = true;
		queueMicrotask(() => this.emit('close'));
	}

	private emit(type: string): void {
		for (const listener of this.listeners.get(type) ?? []) listener();
	}
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000) {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline)
			throw new Error('Timed out waiting for a change');
		await Bun.sleep(5);
	}
}
