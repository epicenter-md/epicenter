/**
 * Honeycrisp Application Lifecycle Tests
 *
 * Authentication chooses which of the two durable documents a generation
 * edits (ADR-0233): signed out is the device-local private document, a known
 * principal is the workspace document. These tests pin the boundary between
 * them: sync, supersession, and rebuild exist only on the workspace side, and
 * no workspace event can reach the private document's storage.
 *
 * Key behaviors:
 * - An aborted boot rejects with the abort, not a storage failure
 * - A signed-out boot opens the private document and never dials
 * - A signed-in boot bootstraps an empty workspace without reading anonymous work
 * - Signing out returns to the private document unchanged
 * - An unbound workspace whose dial is permanently denied is unavailable,
 *   never the private document
 * - A supersession discards the workspace database and leaves the private one
 *
 * `fake-indexeddb` supplies the browser store's storage; the socket is a fake
 * whose frames come from the real sync protocol (`encodeFrame`).
 */
import 'fake-indexeddb/auto';
import { expect, mock, test } from 'bun:test';
import type { AuthClient } from '@epicenter/auth';
import { encodeFrame } from '@epicenter/data/sync';
import { honeycrispLens } from '@epicenter/honeycrisp';

mock.module('$app/navigation', () => ({ goto: mock() }));
mock.module('$app/state', () => ({
	page: { url: new URL('https://honeycrisp.local/') },
}));

(globalThis as unknown as { $state: unknown }).$state = Object.assign(
	<TValue>(value: TValue) => value,
	{ raw: <TValue>(value: TValue) => value },
);
(globalThis as unknown as { $derived: unknown }).$derived = Object.assign(
	<TValue>(value: TValue) => value,
	{ by: <TValue>(derive: () => TValue) => derive() },
);
/** `adoptCurrentDocument` ends a generation with `location.reload()`. */
const reloads = mock();
(globalThis as unknown as { location: unknown }).location = {
	reload: reloads,
};

const { openHoneycrispApplication } = await import('./application.js');

async function until(condition: () => boolean, label: string): Promise<void> {
	for (let attempt = 0; attempt < 400; attempt += 1) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`timed out waiting for ${label}`);
}

/**
 * Start each lifecycle test from empty storage. IndexedDB outlives a test in
 * this process the way it outlives a page in a browser, and these tests each
 * tell a whole multi-generation story from a fresh install.
 */
function resetStorage(): Promise<void> {
	const names = [
		`epicenter-store-${honeycrispLens.namespace}`,
		`epicenter-store-${honeycrispLens.namespace}#private`,
		`epicenter-store-${honeycrispLens.namespace}#workspace`,
	];
	return Promise.all(
		names.map(
			(name) =>
				new Promise<void>((resolve, reject) => {
					const request = indexedDB.deleteDatabase(name);
					request.onsuccess = () => resolve();
					request.onerror = () => reject(request.error);
				}),
		),
	).then(() => undefined);
}

/** The whole create input; only the title matters to these tests. */
function noteFields(title: string) {
	return {
		title,
		preview: '',
		pinned: false,
		createdAt: '2026-08-10T00:00:00.000Z',
		updatedAt: '2026-08-10T00:00:00.000Z',
	};
}

/**
 * A socket the test scripts: listeners attach through the same
 * `addEventListener` surface the real driver uses, and `deliver` hands the
 * client a real protocol frame.
 */
function createFakeSocket() {
	const listeners = new Map<string, Set<(event: unknown) => void>>();
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
	function dispatch(type: string, event: unknown): void {
		for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
	}
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
 * The whole of what the application reads from auth: its boot state, the
 * deployment's base URL, and `openWebSocket`. Everything else throws, so a
 * test fails loudly if the application starts reaching further.
 */
function createFakeAuth({
	status,
	openWebSocket = () => {
		throw new Error('this generation must not dial');
	},
}: {
	status: 'signed-out' | 'signed-in' | 'reauth-required';
	openWebSocket?: () => Promise<WebSocket>;
}): AuthClient {
	const unused = () => {
		throw new Error('not part of the application boot');
	};
	return {
		state:
			status === 'signed-out'
				? { status }
				: { status, principalId: 'principal-under-test' as never },
		deployment: { kind: 'hosted', baseURL: 'https://api.test' },
		onStateChange: () => () => undefined,
		startSignIn: unused,
		signOut: unused,
		fetch: unused,
		getProfile: unused,
		openWebSocket,
		[Symbol.dispose]: () => undefined,
	} as unknown as AuthClient;
}

/** An auth whose every dial completes by announcing `documentId`. */
function announcingAuth(documentId: string) {
	const dials: ReturnType<typeof createFakeSocket>[] = [];
	const auth = createFakeAuth({
		status: 'signed-in',
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

function titles(app: {
	db: { tables: { notes: { list(): { data: { rows: unknown[] } | null } } } };
}): string[] {
	return (app.db.tables.notes.list().data?.rows ?? [])
		.map((row) => (row as { title: string }).title)
		.sort();
}

async function databaseNames(): Promise<string[]> {
	const databases = await indexedDB.databases();
	return databases
		.map((database) => database.name)
		.filter((name): name is string => name !== undefined);
}

test('an abort before the store opens rejects with the abort, not a storage failure', async () => {
	// What this protects is the ORDER: `signal?.throwIfAborted()` runs before
	// the store is opened, so an aborted boot never leaves one behind.
	const controller = new AbortController();
	controller.abort();

	await expect(
		openHoneycrispApplication({ signal: controller.signal }),
	).rejects.toThrow(/abort/i);
});

test('anonymous work survives a signed-in generation, and the workspace never reads it', async () => {
	await resetStorage();

	// Generation 1, signed out: the private document, no sync, no rebuild,
	// and not a single dial.
	const signedOut = createFakeAuth({ status: 'signed-out' });
	{
		const application = await openHoneycrispApplication({ auth: signedOut });
		expect(application.syncStatus()).toBeUndefined();
		expect(application.rebuild).toBeUndefined();
		const created = application.db.tables.notes.create(
			noteFields('anonymous draft'),
		);
		expect(created.error).toBeNull();
		await application[Symbol.asyncDispose]();
	}

	// Generation 2, signed in: the workspace document bootstraps empty. The
	// anonymous draft is in a different database this generation never opened.
	const { auth } = announcingAuth('document-one');
	{
		const application = await openHoneycrispApplication({ auth });
		expect(titles(application)).toEqual([]);
		expect(application.rebuild).toBeDefined();
		const created = application.db.tables.notes.create(
			noteFields('workspace note'),
		);
		expect(created.error).toBeNull();
		await application[Symbol.asyncDispose]();
	}

	// Generation 3, signed out again: the private document, exactly as it was.
	{
		const application = await openHoneycrispApplication({ auth: signedOut });
		expect(titles(application)).toEqual(['anonymous draft']);
		expect(application.syncStatus()).toBeUndefined();
		await application[Symbol.asyncDispose]();
	}
});

test('an unbound workspace whose dial is permanently denied is unavailable, not the private document', async () => {
	await resetStorage();

	// `reauth-required` deliberately: the principal is known, so this is a
	// workspace generation even though no dial can succeed (ADR-0233).
	const auth = createFakeAuth({
		status: 'reauth-required',
		openWebSocket: () =>
			Promise.reject({
				name: 'OpenWebSocketDenied',
				message: 'reauth required',
				permanence: 'permanent',
				code: 'reauth-required',
			}),
	});
	await expect(openHoneycrispApplication({ auth })).rejects.toThrow(
		/sign in again/i,
	);
});

test('a supersession discards the workspace database and cannot touch the private one', async () => {
	await resetStorage();

	// Anonymous work first, so there is something a wrongly aimed discard
	// would destroy.
	{
		const application = await openHoneycrispApplication({
			auth: createFakeAuth({ status: 'signed-out' }),
		});
		const created = application.db.tables.notes.create(
			noteFields('kept anonymous'),
		);
		expect(created.error).toBeNull();
		await application[Symbol.asyncDispose]();
	}

	const { auth, dials } = announcingAuth('document-two');
	const application = await openHoneycrispApplication({ auth });
	const created = application.db.tables.notes.create(
		noteFields('doomed replica note'),
	);
	expect(created.error).toBeNull();

	// The authority names a different document on this replica's own
	// connection: the one fact that concludes supersession (ADR-0231).
	reloads.mockClear();
	const socket = dials.at(-1);
	if (socket === undefined) throw new Error('the workspace never dialled');
	socket.deliver({ kind: 'document', id: 'document-three' });
	await until(() => reloads.mock.calls.length > 0, 'the adoption reload');

	const names = await databaseNames();
	expect(names).not.toContain(
		`epicenter-store-${honeycrispLens.namespace}#workspace`,
	);
	expect(names).toContain(`epicenter-store-${honeycrispLens.namespace}#private`);
	await application[Symbol.asyncDispose]();

	// The private document still holds every anonymous byte it held.
	const signedOut = await openHoneycrispApplication({
		auth: createFakeAuth({ status: 'signed-out' }),
	});
	expect(titles(signedOut)).toEqual(['kept anonymous']);
	await signedOut[Symbol.asyncDispose]();
});
