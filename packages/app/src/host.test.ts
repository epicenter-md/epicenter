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
	// Tauri's access-control layer rejects with a plain string when a window may
	// not call a command. None of the commands this client invokes report their
	// own failures that way, so a string means the call was never routed.
	test('a bare string is the host refusing to route the call', async () => {
		installHost(() =>
			Promise.reject(
				'start_recording not allowed. Permissions associated with this command: allow-start-recording',
			),
		);

		const { error } = await epicenter.recording.start();
		expect(error?.name).toBe('CapabilityUnavailable');
		expect(error?.message).toContain('recording.start');
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
