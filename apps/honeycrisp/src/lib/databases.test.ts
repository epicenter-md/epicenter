/**
 * Honeycrisp Databases Lifecycle Tests
 *
 * The device document opens for every page lifetime, and the boot auth
 * snapshot chooses whether an account replica also opens (ADR-0233). These
 * tests pin the boundaries between the two documents: sync and supersession
 * exist only on the account arm, and they can reach only the one
 * account's replica that opened, and no database event can reach the device
 * document.
 *
 * Key behaviors:
 * - An aborted boot rejects with the abort, not a storage failure
 * - A signed-out boot has no account arm and never dials
 * - Device data is open and editable during a signed-in generation
 * - Device work survives signing in, signing out, and a second account
 * - Returning to an account reopens its retained replica, offline work included
 * - A second account gets its own empty replica and never reads the first's
 * - A signed-in state with no account id opens no account store
 * - An unbound replica whose dial is permanently denied is unavailable,
 *   never the device document
 * - Supersession discards one account's replica and nothing else
 *
 * `fake-indexeddb` supplies the browser store's storage; the socket is a fake
 * whose frames come from the real sync protocol (`encodeFrame`).
 */
import 'fake-indexeddb/auto';
import { expect, mock, test } from 'bun:test';
import { InstantString } from '@epicenter/field';
import type { AuthClient } from '@epicenter/auth';
import { encodeFrame } from '@epicenter/data/sync';
import { honeycrispDefinition } from '@epicenter/honeycrisp';

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

const { openHoneycrispDatabases } = await import('./databases.js');

type Databases = Awaited<ReturnType<typeof openHoneycrispDatabases>>;

/** The durable addresses this application can hold (ADR-0233). */
const DEVICE = `epicenter/${honeycrispDefinition.id}/device`;
const accountOf = (principalId: string) =>
	`epicenter/${honeycrispDefinition.id}/account/${principalId}`;

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
		createdAt: InstantString.fromDate(new Date('2026-08-10T00:00:00.000Z')),
		updatedAt: InstantString.fromDate(new Date('2026-08-10T00:00:00.000Z')),
		folderId: null,
		deletedAt: null,
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
 * The whole of what the databases read from auth: its boot state, the
 * deployment's base URL, and `openWebSocket`. Everything else throws, so a
 * test fails loudly if the databases start reaching further.
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
		throw new Error('not part of the boot');
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

function titles(data: {
	tables: { notes: { list(): { rows: unknown[] } } };
}): string[] {
	return data.tables.notes
		.list()
		.rows.map((row) => (row as { title: string }).title)
		.sort();
}

/** The account arm, which an account generation must have resolved with. */
function requireAccount(
	databases: Databases,
): NonNullable<Databases['account']> {
	const account = databases.account;
	if (account === undefined) {
		throw new Error('this generation was expected to carry an account');
	}
	return account;
}

test('an abort before the store opens rejects with the abort, not a storage failure', async () => {
	// What this protects is the ORDER: `signal?.throwIfAborted()` runs before
	// the store is opened, so an aborted boot never leaves one behind.
	const controller = new AbortController();
	controller.abort();

	await expect(
		openHoneycrispDatabases({ signal: controller.signal }),
	).rejects.toThrow(/abort/i);
});

test('device work survives signing in, signing out, and a second account', async () => {
	await resetStorage();
	const signedOut = createFakeAuth({ status: 'signed-out' });

	// Generation 1, signed out: the device document alone, no account arm,
	// and not a single dial.
	{
		const databases = await openHoneycrispDatabases({ auth: signedOut });
		expect(databases.account).toBeUndefined();
		expect(
			databases.device.tables.notes.create(noteFields('anonymous draft')).id,
		).toHaveLength(24);
		await databases[Symbol.asyncDispose]();
	}

	// Generation 2, signed in as alice: her replica bootstraps empty, AND the
	// device document is open beside it, readable and editable (ADR-0233 as
	// amended: the device document opens for every page lifetime). The two
	// never mix: a device edit lands in the device database, an account edit
	// in alice's.
	{
		const { auth } = announcingAuth({
			principalId: 'alice',
			documentId: 'document-alice',
		});
		const databases = await openHoneycrispDatabases({ auth });
		const account = requireAccount(databases);
		expect(titles(account.data)).toEqual([]);
		expect(titles(databases.device)).toEqual(['anonymous draft']);
		expect(
			databases.device.tables.notes.create(
				noteFields('drafted while signed in'),
			).id,
		).toHaveLength(24);
		expect(
			account.data.tables.notes.create(noteFields("alice's note")).id,
		).toHaveLength(24);
		expect(titles(account.data)).toEqual(["alice's note"]);
		await databases[Symbol.asyncDispose]();
	}

	// Generation 3, signed out again: the device document, exactly as the two
	// signed states left it.
	{
		const databases = await openHoneycrispDatabases({ auth: signedOut });
		expect(titles(databases.device)).toEqual([
			'anonymous draft',
			'drafted while signed in',
		]);
		expect(databases.account).toBeUndefined();
		await databases[Symbol.asyncDispose]();
	}

	// Generation 4, signed in as bob: his own empty replica. Alice's rows are
	// not his, and the device document is nobody's but this device's.
	{
		const { auth } = announcingAuth({
			principalId: 'bob',
			documentId: 'document-bob',
		});
		const databases = await openHoneycrispDatabases({ auth });
		const account = requireAccount(databases);
		expect(titles(account.data)).toEqual([]);
		expect(
			account.data.tables.notes.create(noteFields("bob's note")).id,
		).toHaveLength(24);
		await databases[Symbol.asyncDispose]();
	}

	// Generation 5, signed out one more time: still untouched by any of it.
	{
		const databases = await openHoneycrispDatabases({ auth: signedOut });
		expect(titles(databases.device)).toEqual([
			'anonymous draft',
			'drafted while signed in',
		]);
		await databases[Symbol.asyncDispose]();
	}

	const names = await databaseNames();
	expect(names).toContain(DEVICE);
	expect(names).toContain(accountOf('alice'));
	expect(names).toContain(accountOf('bob'));
});

test('returning to an account reopens its retained replica, including offline work', async () => {
	await resetStorage();

	// Alice, online: bound to her document, and holding one synced row.
	{
		const { auth } = announcingAuth({
			principalId: 'alice',
			documentId: 'document-alice',
		});
		const databases = await openHoneycrispDatabases({ auth });
		expect(
			requireAccount(databases).data.tables.notes.create(
				noteFields('written online'),
			).id,
		).toHaveLength(24);
		await databases[Symbol.asyncDispose]();
	}

	// Alice again, offline: a bound replica opens without a dial ever
	// succeeding, keeps what it had, and takes ordinary offline edits.
	{
		const databases = await openHoneycrispDatabases({
			auth: createFakeAuth({
				status: 'signed-in',
				principalId: 'alice',
				openWebSocket: () =>
					Promise.reject(new Error('the network is not here')),
			}),
		});
		const account = requireAccount(databases);
		expect(titles(account.data)).toEqual(['written online']);
		expect(
			account.data.tables.notes.create(noteFields('written offline')).id,
		).toHaveLength(24);
		await databases[Symbol.asyncDispose]();
	}

	// Bob in between: his replica is empty and cannot see hers.
	{
		const { auth } = announcingAuth({
			principalId: 'bob',
			documentId: 'document-bob',
		});
		const databases = await openHoneycrispDatabases({ auth });
		expect(titles(requireAccount(databases).data)).toEqual([]);
		await databases[Symbol.asyncDispose]();
	}

	// Alice back: both rows, the offline one included, at the same address.
	{
		const { auth } = announcingAuth({
			principalId: 'alice',
			documentId: 'document-alice',
		});
		const databases = await openHoneycrispDatabases({ auth });
		expect(titles(requireAccount(databases).data)).toEqual([
			'written offline',
			'written online',
		]);
		await databases[Symbol.asyncDispose]();
	}
});

test('a signed-in state with no account id opens no account store', async () => {
	await resetStorage();

	// A boot snapshot a host stamped without an id, or any auth arriving at
	// `signed-in` without a stable principal: there is no account address to
	// derive, so the boot fails rather than guessing one or falling back to the
	// device document.
	const auth = createFakeAuth({ status: 'signed-in', principalId: '' });
	const failure = await openHoneycrispDatabases({ auth }).catch(
		(cause) => cause,
	);
	expect((failure as { name?: string }).name).toBe('Unaddressable');
	// The device document opened first and remains the durable local space even
	// though this malformed account boot cannot open a replica.
	expect(await databaseNames()).toEqual([DEVICE]);
});

test('an unbound replica whose dial is permanently denied is unavailable, not the device document', async () => {
	await resetStorage();

	// `reauth-required` deliberately: the principal is known, so this is an
	// account generation even though no dial can succeed (ADR-0233).
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
	// The name, not the wording. What a person is told to do about this lives in
	// `bootFailureMessage`, which is the only thing that gets to phrase it; this
	// asserts the fact that boot copy switches on.
	await expect(openHoneycrispDatabases({ auth })).rejects.toMatchObject({
		name: 'CredentialRefused',
	});
});

test('a supersession discards one account replica and cannot touch the others', async () => {
	await resetStorage();

	// Device work and a second account's replica first, so there is something
	// a wrongly aimed discard would destroy.
	{
		const databases = await openHoneycrispDatabases({
			auth: createFakeAuth({ status: 'signed-out' }),
		});
		expect(
			databases.device.tables.notes.create(noteFields('kept device work'))
				.id,
		).toHaveLength(24);
		await databases[Symbol.asyncDispose]();
	}
	{
		const { auth } = announcingAuth({
			principalId: 'bob',
			documentId: 'document-bob',
		});
		const databases = await openHoneycrispDatabases({ auth });
		expect(
			requireAccount(databases).data.tables.notes.create(
				noteFields("kept bob's"),
			).id,
		).toHaveLength(24);
		await databases[Symbol.asyncDispose]();
	}

	const { auth, dials } = announcingAuth({
		principalId: 'alice',
		documentId: 'document-alice',
	});
	const databases = await openHoneycrispDatabases({ auth });
	expect(
		requireAccount(databases).data.tables.notes.create(
			noteFields('doomed replica note'),
		).id,
	).toHaveLength(24);

	// The authority names a different document on this replica's own
	// connection: the one fact that concludes supersession (ADR-0231).
	reloads.mockClear();
	const socket = dials.at(-1);
	if (socket === undefined) throw new Error('the replica never dialled');
	socket.deliver({ kind: 'document', id: 'document-alice-two' });
	await until(() => reloads.mock.calls.length > 0, 'the adoption reload');

	const names = await databaseNames();
	expect(names).not.toContain(accountOf('alice'));
	expect(names).toContain(accountOf('bob'));
	expect(names).toContain(DEVICE);
	await databases[Symbol.asyncDispose]();

	// Every other document still holds every byte it held.
	const signedOut = await openHoneycrispDatabases({
		auth: createFakeAuth({ status: 'signed-out' }),
	});
	expect(titles(signedOut.device)).toEqual(['kept device work']);
	await signedOut[Symbol.asyncDispose]();
	const { auth: bob } = announcingAuth({
		principalId: 'bob',
		documentId: 'document-bob',
	});
	const bobs = await openHoneycrispDatabases({ auth: bob });
	expect(titles(requireAccount(bobs).data)).toEqual(["kept bob's"]);
	await bobs[Symbol.asyncDispose]();
});
