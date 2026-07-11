/**
 * Manual Playback Lease Tests
 *
 * Verifies that manual recording ids own exactly one native suppression lease
 * and that asynchronous begin/end races cannot leave background audio altered.
 *
 * Key behaviors:
 * - Disabled suppression never asks the host for a lease
 * - Ending a recording closes its exact lease once
 * - A lease returned after recording ended is closed immediately
 * - A stale end cannot close a newer recording's lease
 */
import { expect, test } from 'bun:test';
import type { DesktopPlayback } from '$lib/desktop/contract';
import type { PlaybackSuppressionLease } from '$lib/tauri/bindings.gen';
import { createManualPlayback } from './manual-playback';

function deferred<TValue>() {
	let resolve!: (value: TValue) => void;
	const promise = new Promise<TValue>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function setup(options: { enabled?: boolean } = {}) {
	const begun: string[] = [];
	const ended: PlaybackSuppressionLease[] = [];
	const playback: DesktopPlayback = {
		async begin(recordingId) {
			begun.push(recordingId);
			return { id: `lease-${recordingId}` };
		},
		async end(lease) {
			ended.push(lease);
		},
	};
	const lifecycle = createManualPlayback({
		playback,
		isEnabled: () => options.enabled ?? true,
		reportFailure() {},
	});
	return { begun, ended, lifecycle, playback };
}

test('disabled suppression never begins or ends a host lease', async () => {
	const { begun, ended, lifecycle } = setup({ enabled: false });

	await lifecycle.begin('recording-1');
	await lifecycle.end('recording-1');

	expect(begun).toEqual([]);
	expect(ended).toEqual([]);
});

test('ending a recording closes its exact lease once', async () => {
	const { ended, lifecycle } = setup();

	await lifecycle.begin('recording-1');
	await lifecycle.end('recording-1');
	await lifecycle.end('recording-1');

	expect(ended).toEqual([{ id: 'lease-recording-1' }]);
});

test('lease returned after recording ended is closed immediately', async () => {
	const pending = deferred<PlaybackSuppressionLease>();
	const { ended, lifecycle, playback } = setup();
	playback.begin = () => pending.promise;

	const beginning = lifecycle.begin('recording-1');
	await lifecycle.end('recording-1');
	pending.resolve({ id: 'late-lease' });
	await beginning;

	expect(ended).toEqual([{ id: 'late-lease' }]);
});

test('stale end cannot close a newer recording lease', async () => {
	const { ended, lifecycle } = setup();

	await lifecycle.begin('recording-1');
	await lifecycle.begin('recording-2');
	await lifecycle.end('recording-1');
	await lifecycle.end('recording-2');

	expect(ended).toEqual([
		{ id: 'lease-recording-1' },
		{ id: 'lease-recording-2' },
	]);
});
