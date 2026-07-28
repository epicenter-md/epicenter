import type { BlobId } from '@epicenter/blobs';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { defineKeys, resultQueryOptions } from 'wellcrafted/query';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { manualRecorderConfig } from '#platform/manual-recorder-config';
import { ManualRecorderLive } from '#platform/recorder';
import type { WhisperingRecordingState } from '$lib/constants/audio';
import {
	RecorderError,
	type Recording,
	type RecordingEndedReason,
} from '$lib/services/recorder/contract';

const ManualRecorderError = defineErrors({
	EnumerateDevicesFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to enumerate devices: ${extractErrorMessage(cause)}`,
		cause,
	}),
});

const manualRecorderKeys = defineKeys({
	devices: ['recorder', 'devices'],
});

/**
 * Creates the manual recorder with reactive state.
 *
 * State is owned by this module via Svelte's `$state` rune for synchronous
 * reactivity. Mirrors the shape of `vadRecorder` in `vad-recorder.svelte.ts`:
 *
 * - Reactive access: `manualRecorder.state` (triggers effects on change)
 * - Operations: `manualRecorder.startRecording()` etc.
 * - Device enumeration as a TanStack Query for loading states in selectors
 *
 * A recording is a `Recording` object returned by the implementation that
 * started it, and holding one is what "recording" means. `state` is derived
 * from that rather than mirrored beside it, so the two can never disagree and
 * there is no transition to miss.
 *
 * On Tauri the recorder is bootstrapped from `current()` before the first
 * lifecycle operation, because a host recording can outlive a JS reload. On web
 * `current()` always returns null after a reload.
 */
function createManualRecorder() {
	// `$state.raw` because a Recording is replaced wholesale, never mutated
	// field by field: reads should invalidate when the recording changes, not
	// when something inside it does.
	let _current = $state.raw<Recording | null>(null);
	// Synchronous in-flight guard for start. `_current` is not set until after
	// two awaits (bootstrap + the service start), so without this a second
	// start firing in that window (e.g. a global shortcut pressed twice) would
	// pass the `_current` check and orphan a second recording.
	let _starting = $state(false);
	let _stopEndedListener: (() => void) | null = null;
	let _onEnded: ((reason: RecordingEndedReason) => void) | null = null;

	function hold(recording: Recording) {
		_stopEndedListener?.();
		_current = recording;
		// The one ending a live caller cannot infer from its own calls: the
		// capture died. Everything else that clears `_current` is a consequence
		// of something this module asked for.
		//
		// The recording is deliberately *not* released here. Its capture is over
		// but it still holds what it recorded, and dropping it would strand that
		// audio in a host slot nothing could ever claim. Resolving it is the
		// handler's job, through the ordinary stop or cancel.
		_stopEndedListener = recording.onEnded((reason) => _onEnded?.(reason));
		// A recording recovered from the host may have lost its capture while
		// this JS was gone. The event announcing that is long past, so the
		// snapshot it carries is how we learn, and it is announced identically:
		// a caller never has to ask which of the two ways it found out.
		if (recording.endedReason) _onEnded?.(recording.endedReason);
	}

	function release() {
		_stopEndedListener?.();
		_stopEndedListener = null;
		_current = null;
	}

	// Bootstrap: ask the platform recorder whether it owns a live recording.
	// Navigator always returns null after a JS reload because its state lives
	// in the closure; CPAL can return non-null because the host keeps capturing.
	//
	// The promise is awaited before any stop/cancel/start runs. Without
	// that gate, a user action that fires before bootstrap resolves sees a
	// stale `_current === null` and either no-ops the cancel (leaking the
	// host recording) or double-starts on top of a rehydrated one.
	let bootstrapped: Promise<Result<void, RecorderError>> | null = null;

	function ensureBootstrapped() {
		bootstrapped ??= ManualRecorderLive.current().then((result) => {
			const { data: found, error } = result;
			if (error) {
				bootstrapped = null;
				return Err(error);
			}
			if (found) hold(found);
			return Ok(undefined);
		});
		return bootstrapped;
	}

	return {
		/**
		 * Whether a manual recording is live, derived from holding a `Recording`.
		 */
		get state(): WhisperingRecordingState {
			return _current ? 'RECORDING' : 'IDLE';
		},

		/**
		 * The live recording's id, or null when nothing is recording.
		 *
		 * Read off the recording rather than mirrored here: the recording is the
		 * thing that knows its own id, and a copy could disagree with it. The
		 * push-to-talk stop path uses this to stop only the exact recording it
		 * started, never one a later press supplanted.
		 */
		get currentAudioBlobId(): BlobId | null {
			return _current?.audioBlobId ?? null;
		},

		/** True between a start request and the recording attaching (or failing). */
		get isStarting(): boolean {
			return _starting;
		},

		/**
		 * Feed the live recording's microphone level to a handler, including a
		 * recording recovered after a reload. Returns an unsubscribe.
		 */
		onLevel(handler: (level: number) => void): () => void {
			return _current?.onLevel(handler) ?? (() => {});
		},

		/**
		 * What to do when a capture ends on its own. One handler, because losing a
		 * capture has one app-level reaction.
		 *
		 * The handler is responsible for resolving the recording, which is still
		 * held and still holds its audio. Doing nothing leaks the host's one
		 * recorder slot until the window is destroyed.
		 */
		onEnded(handler: (reason: RecordingEndedReason) => void) {
			_onEnded = handler;
		},

		enumerateDevices: {
			options: resultQueryOptions({
				queryKey: manualRecorderKeys.devices,
				queryFn: async () => {
					const { data, error } = await ManualRecorderLive.enumerateDevices();
					if (error)
						return ManualRecorderError.EnumerateDevicesFailed({ cause: error });
					return Ok(data);
				},
			}),
		},

		async startRecording() {
			if (_starting || _current) return RecorderError.AlreadyRecording();
			_starting = true;
			try {
				// Bootstrap may rehydrate a host recording that outlived a reload,
				// so the `_current` check has to come after it too.
				const { error: bootstrapError } = await ensureBootstrapped();
				if (bootstrapError) return Err(bootstrapError);
				if (_current) return RecorderError.AlreadyRecording();

				const params = manualRecorderConfig.resolveStartParams();
				const { data: recording, error: startError } =
					await ManualRecorderLive.start(params);
				if (startError) return Err(startError);

				hold(recording);
				return Ok(recording);
			} finally {
				_starting = false;
			}
		},

		async stopRecording() {
			const { error: bootstrapError } = await ensureBootstrapped();
			if (bootstrapError) return Err(bootstrapError);
			const recording = _current;
			if (!recording) return RecorderError.NoActiveRecording();
			// Released before the call resolves: this recording is over either
			// way, and letting it linger would let a second stop address it.
			release();
			return recording.stop();
		},

		async cancelRecording() {
			const { error: bootstrapError } = await ensureBootstrapped();
			if (bootstrapError) return Err(bootstrapError);
			const recording = _current;
			if (!recording) return Ok({ status: 'no-recording' as const });
			release();
			const { error } = await recording.cancel();
			if (error) return Err(error);
			return Ok({ status: 'cancelled' as const });
		},
	};
}

export const manualRecorder = createManualRecorder();
