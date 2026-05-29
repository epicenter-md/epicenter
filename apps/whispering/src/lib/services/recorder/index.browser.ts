import { Err, Ok, type Result, tryAsync, trySync } from 'wellcrafted/result';
import {
	TIMESLICE_MS,
	type WhisperingRecordingState,
} from '$lib/constants/audio';
import {
	cleanupRecordingStream,
	enumerateDevices,
	getRecordingStream,
} from '$lib/services/device-stream';
import { categorizeRecorderError } from './categorize-error';
import type {
	NavigatorRecordingParams,
	RecorderService,
	RecordingSession,
} from './types';
import { RecorderError } from './types';

/**
 * Navigator recorder service that uses the MediaRecorder API.
 * Used for web manual recording. Desktop manual recording resolves to the
 * CPAL implementation in `index.tauri.ts`; desktop VAD uses `device-stream`
 * directly and does not go through this service.
 *
 * Constructed via a factory so per-session lifecycle
 * (stop/cancel/subscribe) lives on the returned `RecordingSession`.
 */
function createNavigatorRecorder() {
	function buildSession(args: {
		recordingId: string;
		stream: MediaStream;
		mediaRecorder: MediaRecorder;
		recordedChunks: Blob[];
		startedAtMs: number;
	}) {
		const { recordingId, stream, mediaRecorder, recordedChunks, startedAtMs } =
			args;
		const subscribers = new Set<(s: WhisperingRecordingState) => void>();
		let currentState: WhisperingRecordingState = 'RECORDING';

		const notify = (state: WhisperingRecordingState) => {
			// Idempotent: same-state notifications collapse to a no-op. Keeps
			// the teardown safe to call from multiple paths without double
			// firing 'IDLE' (e.g. an external listener and an explicit
			// teardown for the same transition).
			if (currentState === state) return;
			currentState = state;
			for (const handler of subscribers) handler(state);
		};

		const teardown = () => {
			cleanupRecordingStream(stream);
			notify('IDLE');
		};

		const recordingSession = {
			recordingId,

			stop: async ({ sendStatus }) => {
				sendStatus({
					title: '⏸️ Finishing Recording',
					description: 'Saving your audio...',
				});

				const { data: blob, error: stopError } = await tryAsync({
					try: () =>
						new Promise<Blob>((resolve) => {
							mediaRecorder.addEventListener('stop', () => {
								const audioBlob = new Blob(recordedChunks, {
									type: mediaRecorder.mimeType,
								});
								resolve(audioBlob);
							});
							mediaRecorder.stop();
						}),
					catch: (error) => RecorderError.StopFailed({ cause: error }),
				});

				const durationMs = Date.now() - startedAtMs;

				teardown();

				if (stopError) return Err(stopError);

				sendStatus({
					title: '✅ Recording Saved',
					description: 'Your recording is ready for transcription!',
				});
				return Ok({ kind: 'blob', blob, recordingId, durationMs });
			},

			cancel: async ({ sendStatus }) => {
				sendStatus({
					title: '🛑 Cancelling',
					description: 'Discarding your recording...',
				});

				mediaRecorder.stop();
				teardown();

				sendStatus({
					title: '✨ Cancelled',
					description: 'Recording discarded successfully!',
				});

				return Ok({ status: 'cancelled' });
			},

			subscribe(handler) {
				subscribers.add(handler);
				// Fire current state immediately so callers don't have to mirror
				// 'RECORDING' themselves at attach time.
				handler(currentState);
				return () => {
					subscribers.delete(handler);
				};
			},
		} satisfies RecordingSession;

		return recordingSession;
	}

	return {
		resumeActiveSession: async (): Promise<
			Result<RecordingSession | null, RecorderError>
		> => {
			// Navigator state lives in this closure, so a JS reload zeroes it out;
			// the MediaStream/MediaRecorder are also gone in that case.
			return Ok(null);
		},

		enumerateDevices: async () => {
			const { data: devices, error } = await enumerateDevices();
			if (error) {
				return RecorderError.EnumerateDevices({ cause: error });
			}
			return Ok(devices);
		},

		startRecording: async (
			{ selectedDeviceId, recordingId, bitrateKbps }: NavigatorRecordingParams,
			{ sendStatus },
		) => {
			sendStatus({
				title: '🎙️ Starting Recording',
				description: 'Setting up your microphone...',
			});

			const { data: streamResult, error: acquireStreamError } =
				await getRecordingStream({ selectedDeviceId, sendStatus });
			if (acquireStreamError) {
				return (
					categorizeRecorderError(acquireStreamError) ??
					RecorderError.StreamAcquisition({ cause: acquireStreamError })
				);
			}

			const { stream, deviceOutcome } = streamResult;

			const mimeType = getSupportedAudioMimeType();
			const { data: mediaRecorder, error: recorderError } = trySync({
				try: () =>
					new MediaRecorder(stream, {
						bitsPerSecond: Number(bitrateKbps) * 1000,
						mimeType,
					}),
				catch: (error) => RecorderError.InitFailed({ cause: error }),
			});

			if (recorderError) {
				cleanupRecordingStream(stream);
				return Err(recorderError);
			}

			const recordedChunks: Blob[] = [];
			mediaRecorder.addEventListener('dataavailable', (event: BlobEvent) => {
				if (event.data.size) recordedChunks.push(event.data);
			});

			mediaRecorder.start(TIMESLICE_MS);
			const startedAtMs = Date.now();

			const session = buildSession({
				recordingId,
				stream,
				mediaRecorder,
				recordedChunks,
				startedAtMs,
			});

			return Ok({ session, deviceAcquisition: deviceOutcome });
		},
	} satisfies RecorderService<NavigatorRecordingParams>;
}

export const ManualRecorderLive =
	createNavigatorRecorder() satisfies RecorderService<NavigatorRecordingParams>;

/**
 * Determines the best supported audio MIME type for the current browser.
 *
 * Called before `MediaRecorder` construction so the type can be passed explicitly.
 * This is the industry-standard pattern (used by LibreChat, AutoGPT, 1code, etc.)
 * because:
 *
 * 1. Firefox (and forks like Zen) may leave `mediaRecorder.mimeType` empty when
 *    no type is specified at construction, see https://bugzilla.mozilla.org/show_bug.cgi?id=1512175
 * 2. Safari only supports `audio/mp4`, not `audio/webm`.
 * 3. Specifying upfront means the constructor throws `NotSupportedError` if invalid,
 *    rather than silently producing a blob with an empty type.
 * 4. MDN recommends calling `isTypeSupported()` before construction.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/isTypeSupported_static
 */
function getSupportedAudioMimeType(): string {
	const candidates = [
		'audio/webm;codecs=opus',
		'audio/webm',
		'audio/ogg;codecs=opus',
		'audio/mp4',
		'audio/mp4;codecs=mp4a.40.2',
	];
	for (const candidate of candidates) {
		if (MediaRecorder.isTypeSupported(candidate)) return candidate;
	}
	return 'audio/webm';
}
