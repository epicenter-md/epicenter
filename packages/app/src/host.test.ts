/**
 * @fileoverview What the client does when there is no host, and how it reads a
 * host that says no.
 *
 * These drive the real transport rather than a stand-in for it: each test
 * installs the same `window.__TAURI_INTERNALS__` object `@tauri-apps/api`
 * dereferences, so what is under test is the actual `invoke` path an app gets.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { epicenter } from './index.js';

type Internals = {
	invoke: (command: string, args?: unknown) => Promise<unknown>;
	transformCallback: (callback: (payload: unknown) => void) => number;
};

const globals = globalThis as { window?: unknown };

/** Stand up a host that answers `invoke` however the test says. */
function installHost(invoke: Internals['invoke']) {
	const callbacks = new Map<number, (payload: unknown) => void>();
	let nextCallbackId = 1;
	const internals: Internals = {
		invoke,
		transformCallback: (callback) => {
			const id = nextCallbackId++;
			callbacks.set(id, callback);
			return id;
		},
	};
	globals.window = { __TAURI_INTERNALS__: internals };
	return callbacks;
}

afterEach(() => {
	delete globals.window;
});

describe('no host', () => {
	// The whole reason the handle is not optional: an app holds it in a browser
	// tab, calls it, and gets a value it can render.
	test('every operation answers HostUnavailable instead of throwing', async () => {
		const outcomes = await Promise.all([
			epicenter.recording.start(),
			epicenter.recording.current(),
			epicenter.recording.stop('blob_x'),
			epicenter.recording.cancel('blob_x'),
			epicenter.recording.onEnded(() => {}),
			epicenter.transcription.capabilities(),
			epicenter.transcription.transcribe('blob_x'),
		]);

		for (const { data, error } of outcomes) {
			expect(data).toBeNull();
			expect(error?.name).toBe('HostUnavailable');
		}
	});

	// It has no outcome by contract, so the absence of a host has nowhere to be
	// reported and must not surface as an unhandled rejection either.
	test('prewarm is a silent no-op', () => {
		expect(() => epicenter.transcription.prewarm()).not.toThrow();
	});

	test('a window without Tauri is not a host', async () => {
		globals.window = {};
		const { error } = await epicenter.recording.current();
		expect(error?.name).toBe('HostUnavailable');
	});
});

describe('reading a rejection', () => {
	// Every refusal Tauri writes says the command is "not allowed", in one of
	// four wordings from one module.
	test.each([
		'start_recording not allowed. Permissions associated with this command: allow-start-recording',
		'command not allowed on any window/webview/URL context',
		'start_recording not allowed on window "app-notes", webview "app-notes", URL: http://127.0.0.1:39130/apps/notes/',
		'start_recording not allowed on origin [http://evil.test]. Please create a capability that has this origin on the context field.',
	])('a refusal reads as CapabilityUnavailable: %s', async (refusal) => {
		installHost(() => Promise.reject(refusal));

		const { error } = await epicenter.recording.start();
		expect(error?.name).toBe('CapabilityUnavailable');
		expect(error?.message).toContain('recording.start');
	});

	// The correction that matters most here. A bare string means the host
	// rejected the call rather than the command reporting its own failure, but
	// it does not mean the app lacks authority: Tauri serializes several
	// framework failures the same way, and two of them are ordinary bugs.
	// Reporting those as "unavailable" would describe a mistake as a
	// permission, and an app author would go looking for a grant that is
	// already there.
	test.each([
		[
			'arguments the command could not deserialize',
			'invalid args `audioBlobId` for command `stop_recording`: invalid type: null, expected a string',
		],
		[
			'host state that was never registered',
			'state not managed for field `recorder` on command `start_recording`. You must call `.manage()` before using this command',
		],
	])('%s is a failure, not unavailability', async (_case, rejection) => {
		installHost(() => Promise.reject(rejection));

		const { error } = await epicenter.recording.start();
		expect(error?.name).toBe('RecordingFailed');
		expect(error?.message).toContain(rejection);
	});

	// The command ran and reported a failure it names.
	test('a tagged object is the command`s own failure', async () => {
		installHost(() =>
			Promise.reject({ name: 'Busy', message: 'already recording' }),
		);

		const { error } = await epicenter.recording.start();
		expect(error?.name).toBe('RecorderBusy');
		expect(error?.message).toContain('already recording');
	});

	// The mistake this ordering exists to prevent: an `Error` carries a `name`,
	// and reading `TypeError` as a command's typed failure would turn a bug into
	// a claim about the system.
	test('an Error is never read as a typed failure', async () => {
		installHost(() => Promise.reject(new TypeError('ipc is broken')));

		const { error } = await epicenter.recording.start();
		expect(error?.name).toBe('RecordingFailed');
		expect(error?.message).toContain('ipc is broken');
	});

	// A failure this build does not recognize is a failure, not unavailability.
	test('an unknown tag folds into the operation`s failure', async () => {
		installHost(() =>
			Promise.reject({ name: 'SomethingNewer', message: 'from a later host' }),
		);

		const { error } = await epicenter.recording.start();
		expect(error?.name).toBe('RecordingFailed');
	});
});
