/**
 * Honeycrisp Application Lifecycle Tests
 *
 * Authentication chooses which durable document a generation edits, and whose
 * it is (ADR-0233): signed out is the device-owned private document, and a
 * principal is that account's own retained workspace replica. These tests pin
 * the boundaries between them: sync, supersession, and rebuild exist only on
 * the workspace side, they can reach only the one account's replica that
 * opened, and no workspace event can reach the private document.
 *
 * Key behaviors:
 * - An aborted boot rejects with the abort, not a storage failure
 * - A signed-out boot opens the private document and never dials
 * - Private work survives signing in, signing out, and a second account
 * - Returning to an account reopens its retained replica, offline work included
 * - A second account gets its own empty replica and never reads the first's
 * - A signed-in state with no account id opens no workspace store
 * - An unbound workspace whose dial is permanently denied is unavailable,
 *   never the private document
 * - Supersession and rebuild discard one account's replica and nothing else
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

/** The durable addresses this application can hold (ADR-0233). */
const PRIVATE = `epicenter/${honeycrispLens.namespace}/private`;
const workspaceOf = (principalId: string) =>
	`epicenter/${honeycrispLens.namespace}/workspace/${principalId}`;

async function until(condition: () => boolean, label: string): Promise<void> {
	for (let attempt = 0; attempt < 400; attempt += 1) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`timed out waiting for ${label}`);
}

async function databaseNames(): Promise<string[]> {
	const databases = await indexedDB.databases();
	return databases
		.map((database) => database.name)
		.filter((name): name is string => name !== undefined);
}

/**
 * Start each lifecycle test from empty storage. IndexedDB outlives a test in
 * this process the way it outlives a page in a browser, and these tests each
 * tell a whole multi-generation story from a fresh install.
 */
async function resetStorage(): Promise<void> {
	for (const name of await databaseNames()) {
		await new Promise<void>((resolve, reject) => {
			const request = indexedDB.deleteDatabase(name);
			request.onsuccess = () => resolve();
			request.onerror = () => reject(request.error);
		});
	}
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
	principalId = 'principal-under-test',
	openWebSocket = () => {
		throw new Error('this generation must not dial');
	},
	fetch,
}: {
	status: 'signed-out' | 'signed-in' | 'reauth-required';
	principalId?: string;
	openWebSocket?: () => Promise<WebSocket>;
	fetch?: (input: unknown, init?: unknown) => Promise<Response>;
}): AuthClient {
	const unused = () => {
		throw new Error('not part of the application boot');
	};
	return {
		state: status === 'signed-out' ? { status } : { status, principalId },
		deployment: { kind: 'hosted', baseURL: 'https://api.test' },
		onStateChange: () => () => undefined,
		startSignIn: unused,
		signOut: unused,
		fetch: fetch ?? unused,
		getProfile: unused,
		openWebSocket,
		[Symbol.dispose]: () => undefined,
	} as unknown as AuthClient;
}

/** An auth for one account whose every dial completes by announcing `documentId`. */
function announcingAuth({
	principalId,
	documentId,
	fetch,
}: {
	principalId: string;
	documentId: string;
	fetch?: (input: unknown, init?: unknown) => Promise<Response>;
}) {
	const dials: ReturnType<typeof createFakeSocket>[] = [];
	const auth = createFakeAuth({
		status: 'signed-in',
		principalId,
		fetch,
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

test('an abort before the store opens rejects with the abort, not a storage failure', async () => {
	// What this protects is the ORDER: `signal?.throwIfAborted()` runs before
	// the store is opened, so an aborted boot never leaves one behind.
	const controller = new AbortController();
	controller.abort();

	await expect(
		openHoneycrispApplication({ signal: controller.signal }),
	).rejects.toThrow(/abort/i);
});

test('private work survives signing in, signing out, and a second account', async () => {
	await resetStorage();
	const signedOut = createFakeAuth({ status: 'signed-out' });

	// Generation 1, signed out: the private document, no sync, no rebuild,
	// and not a single dial.
	{
		const application = await openHoneycrispApplication({ auth: signedOut });
		expect(application.syncStatus()).toBeUndefined();
		expect(application.rebuild).toBeUndefined();
		expect(
			application.db.tables.notes.create(noteFields('anonymous draft')).error,
		).toBeNull();
		await application[Symbol.asyncDispose]();
	}

	// Generation 2, signed in as alice: her workspace bootstraps empty. The
	// anonymous draft is in a different database this generation never opened.
	{
		const { auth } = announcingAuth({
			principalId: 'alice',
			documentId: 'document-alice',
		});
		const application = await openHoneycrispApplication({ auth });
		expect(titles(application)).toEqual([]);
		expect(application.rebuild).toBeDefined();
		expect(
			application.db.tables.notes.create(noteFields("alice's note")).error,
		).toBeNull();
		await application[Symbol.asyncDispose]();
	}

	// Generation 3, signed out again: the private document, exactly as it was.
	{
		const application = await openHoneycrispApplication({ auth: signedOut });
		expect(titles(application)).toEqual(['anonymous draft']);
		expect(application.syncStatus()).toBeUndefined();
		await application[Symbol.asyncDispose]();
	}

	// Generation 4, signed in as bob: his own empty replica. Alice's rows are
	// not his, and the private document is nobody's but this device's.
	{
		const { auth } = announcingAuth({
			principalId: 'bob',
			documentId: 'document-bob',
		});
		const application = await openHoneycrispApplication({ auth });
		expect(titles(application)).toEqual([]);
		expect(
			application.db.tables.notes.create(noteFields("bob's note")).error,
		).toBeNull();
		await application[Symbol.asyncDispose]();
	}

	// Generation 5, signed out one more time: still untouched by any of it.
	{
		const application = await openHoneycrispApplication({ auth: signedOut });
		expect(titles(application)).toEqual(['anonymous draft']);
		await application[Symbol.asyncDispose]();
	}

	const names = await databaseNames();
	expect(names).toContain(PRIVATE);
	expect(names).toContain(workspaceOf('alice'));
	expect(names).toContain(workspaceOf('bob'));
});

test('returning to an account reopens its retained replica, including offline work', async () => {
	await resetStorage();

	// Alice, online: bound to her document, and holding one synced row.
	{
		const { auth } = announcingAuth({
			principalId: 'alice',
			documentId: 'document-alice',
		});
		const application = await openHoneycrispApplication({ auth });
		expect(
			application.db.tables.notes.create(noteFields('written online')).error,
		).toBeNull();
		await application[Symbol.asyncDispose]();
	}

	// Alice again, offline: a bound replica opens without a dial ever
	// succeeding, keeps what it had, and takes ordinary offline edits.
	{
		const application = await openHoneycrispApplication({
			auth: createFakeAuth({
				status: 'signed-in',
				principalId: 'alice',
				openWebSocket: () =>
					Promise.reject(new Error('the network is not here')),
			}),
		});
		expect(titles(application)).toEqual(['written online']);
		expect(
			application.db.tables.notes.create(noteFields('written offline')).error,
		).toBeNull();
		await application[Symbol.asyncDispose]();
	}

	// Bob in between: his replica is empty and cannot see hers.
	{
		const { auth } = announcingAuth({
			principalId: 'bob',
			documentId: 'document-bob',
		});
		const application = await openHoneycrispApplication({ auth });
		expect(titles(application)).toEqual([]);
		await application[Symbol.asyncDispose]();
	}

	// Alice back: both rows, the offline one included, at the same address.
	{
		const { auth } = announcingAuth({
			principalId: 'alice',
			documentId: 'document-alice',
		});
		const application = await openHoneycrispApplication({ auth });
		expect(titles(application)).toEqual(['written offline', 'written online']);
		await application[Symbol.asyncDispose]();
	}
});

test('a signed-in state with no account id opens no workspace store', async () => {
	await resetStorage();

	// A boot snapshot a host stamped without an id, or any auth arriving at
	// `signed-in` without a stable principal: there is no workspace address to
	// derive, so the boot fails rather than guessing one or falling back to the
	// private document.
	const auth = createFakeAuth({ status: 'signed-in', principalId: '' });
	const failure = await openHoneycrispApplication({ auth }).catch(
		(cause) => cause,
	);
	expect((failure as { name?: string }).name).toBe('Unaddressable');
	expect(await databaseNames()).toEqual([]);
});

test('an unbound workspace whose dial is permanently denied is unavailable, not the private document', async () => {
	await resetStorage();

	// `reauth-required` deliberately: the principal is known, so this is a
	// workspace generation even though no dial can succeed (ADR-0233).
	const auth = createFakeAuth({
		status: 'reauth-required',
		principalId: 'alice',
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

test('a supersession discards one account replica and cannot touch the others', async () => {
	await resetStorage();

	// Private work and a second account's replica first, so there is something
	// a wrongly aimed discard would destroy.
	{
		const application = await openHoneycrispApplication({
			auth: createFakeAuth({ status: 'signed-out' }),
		});
		expect(
			application.db.tables.notes.create(noteFields('kept private')).error,
		).toBeNull();
		await application[Symbol.asyncDispose]();
	}
	{
		const { auth } = announcingAuth({
			principalId: 'bob',
			documentId: 'document-bob',
		});
		const application = await openHoneycrispApplication({ auth });
		expect(
			application.db.tables.notes.create(noteFields("kept bob's")).error,
		).toBeNull();
		await application[Symbol.asyncDispose]();
	}

	const { auth, dials } = announcingAuth({
		principalId: 'alice',
		documentId: 'document-alice',
	});
	const application = await openHoneycrispApplication({ auth });
	expect(
		application.db.tables.notes.create(noteFields('doomed replica note')).error,
	).toBeNull();

	// The authority names a different document on this replica's own
	// connection: the one fact that concludes supersession (ADR-0231).
	reloads.mockClear();
	const socket = dials.at(-1);
	if (socket === undefined) throw new Error('the workspace never dialled');
	socket.deliver({ kind: 'document', id: 'document-alice-two' });
	await until(() => reloads.mock.calls.length > 0, 'the adoption reload');

	const names = await databaseNames();
	expect(names).not.toContain(workspaceOf('alice'));
	expect(names).toContain(workspaceOf('bob'));
	expect(names).toContain(PRIVATE);
	await application[Symbol.asyncDispose]();

	// Every other document still holds every byte it held.
	const signedOut = await openHoneycrispApplication({
		auth: createFakeAuth({ status: 'signed-out' }),
	});
	expect(titles(signedOut)).toEqual(['kept private']);
	await signedOut[Symbol.asyncDispose]();
	const { auth: bob } = announcingAuth({
		principalId: 'bob',
		documentId: 'document-bob',
	});
	const bobs = await openHoneycrispApplication({ auth: bob });
	expect(titles(bobs)).toEqual(["kept bob's"]);
	await bobs[Symbol.asyncDispose]();
});

test('a rebuild discards one account replica and cannot touch the others', async () => {
	await resetStorage();

	{
		const application = await openHoneycrispApplication({
			auth: createFakeAuth({ status: 'signed-out' }),
		});
		expect(
			application.db.tables.notes.create(noteFields('kept private')).error,
		).toBeNull();
		await application[Symbol.asyncDispose]();
	}
	{
		const { auth } = announcingAuth({
			principalId: 'bob',
			documentId: 'document-bob',
		});
		const application = await openHoneycrispApplication({ auth });
		expect(
			application.db.tables.notes.create(noteFields("kept bob's")).error,
		).toBeNull();
		await application[Symbol.asyncDispose]();
	}

	// Alice rebuilds: the authority publishes her next document, and this
	// device adopts through the same discard-and-reload a supersession runs.
	const { auth } = announcingAuth({
		principalId: 'alice',
		documentId: 'document-alice',
		fetch: async () =>
			new Response(JSON.stringify({ document: 'document-alice-two' }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			}),
	});
	const application = await openHoneycrispApplication({ auth });
	expect(
		application.db.tables.notes.create(noteFields('rebuilt away')).error,
	).toBeNull();

	reloads.mockClear();
	const published = await application.rebuild?.({
		acknowledgedWorkspaceChangesMayBeLost: true,
	});
	expect(published?.error).toBeNull();
	await until(() => reloads.mock.calls.length > 0, 'the adoption reload');

	const names = await databaseNames();
	expect(names).not.toContain(workspaceOf('alice'));
	expect(names).toContain(workspaceOf('bob'));
	expect(names).toContain(PRIVATE);
	await application[Symbol.asyncDispose]();
});
