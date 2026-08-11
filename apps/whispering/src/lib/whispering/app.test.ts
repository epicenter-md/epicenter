/**
 * Whispering app acquisition tests.
 *
 * The device document opens for every page lifetime and holds this machine's
 * settings; the boot auth snapshot chooses whether an account replica also
 * opens and takes over the portable work (ADR-0233). These tests pin the split,
 * which is the whole of what this app's composition decides.
 *
 * Key behaviors:
 * - A signed-out boot has one document and never dials
 * - Settings read their declared defaults and survive a restart
 * - Settings stay on the DEVICE document across signing in, so they neither
 *   travel to another machine nor disappear when an account opens
 * - Recordings written signed out stay on the device and are not shown to a
 *   signed-in generation, which reads the account replica instead
 * - An aborted boot rejects with the abort and leaves nothing open
 *
 * `fake-indexeddb` supplies the browser store's storage; the socket is a fake
 * whose frames come from the real sync protocol (`encodeFrame`).
 */
import 'fake-indexeddb/auto';
import { expect, test } from 'bun:test';

// The recipes domain IS reactive state, so the runes are shimmed to their
// non-reactive meaning (the pattern the other runtime tests use). These
// assertions read imperatively: the question is which document a write landed
// in, not whether a view recomputed.
(globalThis as unknown as { $state: unknown }).$state = Object.assign(
	<TValue>(value: TValue) => value,
	{ raw: <TValue>(value: TValue) => value },
);
(globalThis as unknown as { $derived: unknown }).$derived = Object.assign(
	<TValue>(value: TValue) => value,
	{ by: <TValue>(derive: () => TValue) => derive() },
);

import type { AuthClient } from '@epicenter/auth';
import type { BlobStore } from '@epicenter/blobs';
import { encodeFrame } from '@epicenter/data/sync';
import { Ok } from 'wellcrafted/result';
import { whisperingLens } from '../workspace';
import { openWhisperingApp, type WhisperingAppDependencies } from './app';

const local: BlobStore = {
	async put() {
		return Ok(undefined);
	},
	async get() {
		return Ok(new Blob());
	},
	async stat() {
		return Ok({ size: 0, contentType: 'application/octet-stream' });
	},
	async delete() {
		return Ok(undefined);
	},
};

/**
 * Start each test from empty storage. IndexedDB outlives a test in this
 * process the way it outlives a page in a browser, and these tests each tell a
 * whole multi-generation story from a fresh install.
 */
async function resetStorage(): Promise<void> {
	for (const database of await indexedDB.databases()) {
		const name = database.name;
		if (name === undefined) continue;
		await new Promise<void>((resolve, reject) => {
			const request = indexedDB.deleteDatabase(name);
			request.onsuccess = () => resolve();
			request.onerror = () => reject(request.error);
		});
	}
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
			dispatch('message', { data: encodeFrame(frame).slice().buffer });
		},
	};
}

/**
 * The whole of what the app reads from auth: its boot state, the deployment's
 * base URL, and `openWebSocket`. Everything else throws, so a test fails
 * loudly if the app starts reaching further.
 */
function createFakeAuth({
	status,
	principalId = 'principal-under-test',
	openWebSocket = () => {
		throw new Error('this generation must not dial');
	},
}: {
	status: 'signed-out' | 'signed-in';
	principalId?: string;
	openWebSocket?: () => Promise<WebSocket>;
}): AuthClient {
	const unused = () => {
		throw new Error('not part of the app boot');
	};
	return {
		state: status === 'signed-out' ? { status } : { status, principalId },
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

/** An auth for one account whose every dial completes by announcing a document. */
function announcingAuth(principalId: string): AuthClient {
	return createFakeAuth({
		status: 'signed-in',
		principalId,
		openWebSocket: async () => {
			const fake = createFakeSocket();
			setTimeout(() => {
				fake.open();
				fake.deliver({ kind: 'document', id: `document-for-${principalId}` });
			}, 0);
			return fake.socket;
		},
	});
}

function dependencies(auth: AuthClient): WhisperingAppDependencies {
	return {
		auth,
		blobs: { local, remote: null },
		reportBackgroundError: () => undefined,
	};
}

/** The whole create input; only the title matters to these tests. */
function recordingFields(title: string) {
	return {
		audioBlobId: 'blob_aaaaaaaaaaaaaaaaaaaaa' as never,
		title,
		recordedAt: '2026-08-10T00:00:00.000Z',
		recordedAtZone: 'UTC',
	};
}

test('a signed-out boot opens one document and never dials', async () => {
	await resetStorage();
	await using app = await openWhisperingApp(
		dependencies(createFakeAuth({ status: 'signed-out' })),
	);

	// `createFakeAuth` throws on any dial, so reaching here is the assertion.
	expect(app.syncStatus()).toBeUndefined();
	expect(app.recordings.count).toBe(0);
	expect(app.recipes.count).toBe(0);

	const names = (await indexedDB.databases()).map(({ name }) => name);
	expect(names).toContain(`epicenter/${whisperingLens.namespace}/device`);
	expect(names.some((name) => name?.includes('/account/'))).toBe(false);
});

test('settings read their declared defaults and survive a restart', async () => {
	await resetStorage();
	{
		await using app = await openWhisperingApp(
			dependencies(createFakeAuth({ status: 'signed-out' })),
		);
		// Declared in the Lens, applied by a read, never stored.
		expect(app.settings.get('transcriptionService')).toBe('local');
		expect(app.settings.get('recordingAutoUpload')).toBe(false);
		expect(app.settings.get('soundManualStart')).toBe(true);

		let notifications = 0;
		const stop = app.settings.subscribe(() => {
			notifications += 1;
		});
		app.settings.set('recordingAutoUpload', true);
		expect(app.settings.get('recordingAutoUpload')).toBe(true);
		expect(notifications).toBeGreaterThan(0);
		stop();
		await Bun.sleep(10);
	}

	await using reopened = await openWhisperingApp(
		dependencies(createFakeAuth({ status: 'signed-out' })),
	);
	expect(reopened.settings.get('recordingAutoUpload')).toBe(true);
});

test('settings stay on the device document when an account opens', async () => {
	await resetStorage();
	{
		await using signedOut = await openWhisperingApp(
			dependencies(createFakeAuth({ status: 'signed-out' })),
		);
		signedOut.settings.set('recordingAutoUpload', true);
		signedOut.recordings.create(recordingFields('written on this device'));
		await Bun.sleep(10);
	}

	await using signedIn = await openWhisperingApp(
		dependencies(announcingAuth('alice')),
	);
	// The setting is a fact about this machine, so signing in neither loses it
	// nor sends it anywhere.
	expect(signedIn.settings.get('recordingAutoUpload')).toBe(true);
	// The work is portable, so a signed-in generation reads the account replica.
	// The device recording is retained but hidden; nothing copied it across.
	expect(signedIn.recordings.count).toBe(0);
});

test('device work is still there after signing back out', async () => {
	await resetStorage();
	{
		await using signedOut = await openWhisperingApp(
			dependencies(createFakeAuth({ status: 'signed-out' })),
		);
		signedOut.recordings.create(recordingFields('written on this device'));
		await Bun.sleep(10);
	}
	{
		await using signedIn = await openWhisperingApp(
			dependencies(announcingAuth('alice')),
		);
		signedIn.recordings.create(recordingFields('written on the account'));
		await Bun.sleep(10);
	}

	await using signedOutAgain = await openWhisperingApp(
		dependencies(createFakeAuth({ status: 'signed-out' })),
	);
	expect(signedOutAgain.recordings.sorted.map(({ title }) => title)).toEqual([
		'written on this device',
	]);
});

test('an aborted boot rejects with the abort', async () => {
	await resetStorage();
	const controller = new AbortController();
	controller.abort(new Error('root unmounted'));

	expect(
		openWhisperingApp(dependencies(createFakeAuth({ status: 'signed-out' })), {
			signal: controller.signal,
		}),
	).rejects.toThrow('root unmounted');
});
