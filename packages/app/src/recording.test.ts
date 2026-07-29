/**
 * @fileoverview What `epicenter.recording` sends, and what it makes of the
 * answers.
 */

import { afterEach, expect, test } from 'bun:test';
import { epicenter } from './index.js';

type Call = { command: string; args: unknown };
/** One queued answer: the host resolves it, or rejects with it. */
type Answer = { ok: unknown } | { reject: unknown };

const globals = globalThis as { window?: unknown };

/** Callbacks the event plugin registered, in registration order. */
let handlers: Array<(event: unknown) => void> = [];

/** Stand up a host that records every invoke and answers them in order. */
function installHost(...answers: Answer[]) {
	const calls: Call[] = [];
	const queued = [...answers];
	globals.window = {
		__TAURI_INTERNALS__: {
			invoke: (command: string, args: unknown) => {
				calls.push({ command, args });
				const answer = queued.shift() ?? { ok: null };
				return 'ok' in answer
					? Promise.resolve(answer.ok)
					: Promise.reject(answer.reject);
			},
			transformCallback: (callback: (event: unknown) => void) => {
				handlers.push(callback);
				return handlers.length;
			},
		},
	};
	return calls;
}

afterEach(() => {
	delete globals.window;
	handlers = [];
});

test('start records from the system default and reports the microphone', async () => {
	const calls = installHost({
		ok: {
			audioBlobId: 'blob_one',
			device: {
				outcome: 'fallback',
				reason: 'no-device-selected',
				deviceId: 'MacBook Pro Microphone',
			},
			endedReason: null,
		},
	});

	const { data, error } = await epicenter.recording.start();

	expect(error).toBeNull();
	expect(data).toEqual({
		audioBlobId: 'blob_one',
		microphone: 'MacBook Pro Microphone',
		endedReason: null,
	});
	// Naming no device is what makes this the system default. The host's
	// acquisition union collapses to the one fact an app can use.
	expect(calls).toEqual([
		{ command: 'start_recording', args: { deviceIdentifier: null } },
	]);
});

test('current reports an idle recorder as null, not as a failure', async () => {
	installHost({ ok: null });
	const { data, error } = await epicenter.recording.current();
	expect(error).toBeNull();
	expect(data).toBeNull();
});

// The durable recovery path from ADR-0184: a capture that died while this app
// was not listening is found here, and the recording is still claimable.
test('current surfaces a capture that ended on its own', async () => {
	installHost({
		ok: {
			audioBlobId: 'blob_two',
			device: { outcome: 'success', deviceId: 'Yeti' },
			endedReason: 'deviceDisconnected',
		},
	});

	const { data } = await epicenter.recording.current();
	expect(data?.endedReason).toBe('deviceDisconnected');
});

test('stop publishes the audio it names', async () => {
	const calls = installHost({
		ok: { audioBlobId: 'blob_one', durationMs: 4210, byteLength: 134_720 },
	});

	const { data, error } = await epicenter.recording.stop('blob_one');

	expect(error).toBeNull();
	expect(data).toEqual({
		audioBlobId: 'blob_one',
		durationMs: 4210,
		byteLength: 134_720,
	});
	expect(calls[0]).toEqual({
		command: 'stop_recording',
		args: { audioBlobId: 'blob_one' },
	});
});

// Stopping a recording that is already resolved is the ordinary shape of
// push-to-talk releasing late, so it has to be a clean typed answer rather than
// something an app has to guess at.
test('stopping a recording this app no longer holds is typed', async () => {
	installHost({
		reject: { name: 'NotRecording', message: 'that recording already finished' },
	});

	const { error } = await epicenter.recording.stop('blob_gone');

	expect(error?.name).toBe('NoSuchRecording');
	expect(error).toMatchObject({ audioBlobId: 'blob_gone' });
});

test('cancel names the recording and produces nothing', async () => {
	const calls = installHost({ ok: null });

	const { data, error } = await epicenter.recording.cancel('blob_one');

	expect(error).toBeNull();
	expect(data).toBeUndefined();
	expect(calls[0]).toEqual({
		command: 'cancel_recording',
		args: { audioBlobId: 'blob_one' },
	});
});

// The subscription belongs to the app rather than to one recording, so an app
// installs it once at startup and no ending falls into a gap between starting a
// recording and being able to hear about it.
test('onEnded delivers the endings the host pushes', async () => {
	installHost({ ok: 7 });
	const seen: unknown[] = [];

	const { data: unsubscribe, error } = await epicenter.recording.onEnded(
		(ended) => seen.push(ended),
	);
	expect(error).toBeNull();

	handlers[0]?.({
		event: 'recording-ended-event',
		id: 7,
		payload: { audioBlobId: 'blob_one', reason: 'permissionRevoked' },
	});

	expect(seen).toEqual([
		{ audioBlobId: 'blob_one', reason: 'permissionRevoked' },
	]);
	expect(() => unsubscribe?.()).not.toThrow();
});
