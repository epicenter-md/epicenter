/**
 * @fileoverview What `epicenter.recording` sends, and what it makes of the
 * answers.
 */

import { afterEach, expect, test } from 'bun:test';
import { epicenter } from './index.js';

type Call = { command: string; args: unknown };
/** One queued answer: the host resolves it, or rejects with it. */
type Answer = { ok: unknown } | { reject: unknown };
/** Where a listener asked to be sent events, in Tauri's own vocabulary. */
type EventTarget =
	| { kind: 'Any' }
	| {
			kind: 'AnyLabel' | 'Window' | 'Webview' | 'WebviewWindow';
			label: string;
	  };
type Subscription = {
	event: string;
	target: EventTarget;
	deliver: (event: unknown) => void;
};

/** The window label the fake host tells the page it is running in. */
const THIS_WINDOW = 'app-notes';

const globals = globalThis as { window?: unknown };

/** Every live event subscription the client opened, in registration order. */
let subscriptions: Subscription[] = [];

/**
 * Stand up a host that records every invoke and answers them in order.
 *
 * It carries the `metadata` a real Tauri page carries, because the client asks
 * which window it is in before subscribing, and a fake without it would let a
 * scoping bug pass.
 */
function installHost(...answers: Answer[]) {
	const calls: Call[] = [];
	const queued = [...answers];
	const pending = new Map<number, (event: unknown) => void>();
	let nextCallbackId = 1;

	globals.window = {
		__TAURI_INTERNALS__: {
			metadata: {
				currentWindow: { label: THIS_WINDOW },
				currentWebview: { label: THIS_WINDOW },
			},
			invoke: (command: string, args: unknown) => {
				calls.push({ command, args });
				// Registration is the one command this fake interprets rather
				// than replays, because the target it carries is what the
				// isolation tests are about.
				if (command === 'plugin:event|listen') {
					const { event, target, handler } = args as {
						event: string;
						target: EventTarget;
						handler: number;
					};
					const deliver = pending.get(handler);
					if (deliver) subscriptions.push({ event, target, deliver });
					return Promise.resolve(subscriptions.length);
				}
				const answer = queued.shift() ?? { ok: null };
				return 'ok' in answer
					? Promise.resolve(answer.ok)
					: Promise.reject(answer.reject);
			},
			transformCallback: (callback: (event: unknown) => void) => {
				const id = nextCallbackId++;
				pending.set(id, callback);
				return id;
			},
		},
	};
	return calls;
}

/**
 * Emit the way the host does, to one window's label, and dispatch the way Tauri
 * does.
 *
 * The `Any` clause is the load-bearing one and it is not an approximation:
 * `match_any_or_filter` in `event/listener.rs` returns true for a listener
 * whose own target is `Any`, *before* consulting the emit's filter. So a
 * listener that did not scope itself receives another window's events, which is
 * exactly what these tests exist to catch.
 */
function emitToWindow(label: string, event: string, payload: unknown) {
	for (const subscription of subscriptions) {
		if (subscription.event !== event) continue;
		const reaches =
			subscription.target.kind === 'Any' || subscription.target.label === label;
		if (reaches) subscription.deliver({ event, id: 1, payload });
	}
}

afterEach(() => {
	delete globals.window;
	subscriptions = [];
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
		reject: {
			name: 'NotRecording',
			message: 'that recording already finished',
		},
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
	installHost();
	const seen: unknown[] = [];

	const { data: unsubscribe, error } = await epicenter.recording.onEnded(
		(ended) => seen.push(ended),
	);
	expect(error).toBeNull();

	emitToWindow(THIS_WINDOW, 'recording-ended-event', {
		audioBlobId: 'blob_one',
		reason: 'permissionRevoked',
	});

	expect(seen).toEqual([
		{ audioBlobId: 'blob_one', reason: 'permissionRevoked' },
	]);
	expect(() => unsubscribe?.()).not.toThrow();
});

// The host targets the window that owns a recording, but that only isolates
// anything if the listener asked to be scoped. A listener registered as `Any`
// is short-circuited past the emit's filter, so every app window that
// subscribed would learn when any other app's capture died.
test('onEnded scopes its subscription to this window', async () => {
	const calls = installHost();

	await epicenter.recording.onEnded(() => {});

	const registration = calls.find(
		(call) => call.command === 'plugin:event|listen',
	);
	expect(registration?.args).toMatchObject({
		event: 'recording-ended-event',
		target: { kind: 'WebviewWindow', label: THIS_WINDOW },
	});
});

test('onEnded never hears another window`s recording end', async () => {
	installHost();
	const seen: unknown[] = [];

	await epicenter.recording.onEnded((ended) => seen.push(ended));

	emitToWindow('app-somebody-else', 'recording-ended-event', {
		audioBlobId: 'blob_theirs',
		reason: 'deviceDisconnected',
	});
	expect(seen).toEqual([]);

	// And the same subscription still hears its own.
	emitToWindow(THIS_WINDOW, 'recording-ended-event', {
		audioBlobId: 'blob_mine',
		reason: 'storageFailed',
	});
	expect(seen).toEqual([{ audioBlobId: 'blob_mine', reason: 'storageFailed' }]);
});
