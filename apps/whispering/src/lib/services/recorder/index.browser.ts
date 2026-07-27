import { type BlobId, generateBlobId } from '@epicenter/blobs';
import {
	cleanupRecordingStream,
	type DeviceAcquisitionOutcome,
	enumerateDevices,
	getRecordingStream,
} from '@epicenter/recorder';
import { Err, Ok, type Result, tryAsync, trySync } from 'wellcrafted/result';
import { BlobsLive } from '#platform/blobs';
import {
	type NavigatorRecordingParams,
	RecorderError,
	type RecorderService,
	type Recording,
	type RecordingEndedReason,
} from '$lib/services/recorder/contract';

/**
 * How often the MediaRecorder emits a `dataavailable` chunk while recording.
 */
const TIMESLICE_MS = 1000;

/**
 * Browser branch of the `#platform/recorder` seam: a recorder service backed
 * by the MediaRecorder API, on top of `@epicenter/recorder`'s stream
 * acquisition. The Tauri branch (`index.tauri.ts`) exports the same
 * `ManualRecorderLive` name backed by CPAL, so `manual-recorder.svelte.ts`
 * consumes one shape regardless of platform.
 *
 * Constructed via a factory so the whole lifecycle (stop, cancel, level, and
 * unexpected ending) lives on the returned `Recording`.
 *
 * The blob id is minted here, at the moment the capture starts, the way the
 * host mints it on desktop: whoever owns the capture owns the id, and the
 * caller reads it back off the session.
 */
function createBrowserRecorder(): RecorderService<NavigatorRecordingParams> {
	function buildRecording(args: {
		audioBlobId: BlobId;
		device: DeviceAcquisitionOutcome;
		stream: MediaStream;
		mediaRecorder: MediaRecorder;
		recordedChunks: Blob[];
		startedAtMs: number;
	}): Recording {
		const {
			audioBlobId,
			device,
			stream,
			mediaRecorder,
			recordedChunks,
			startedAtMs,
		} = args;
		// Meter and ended sinks, attachable at any time rather than supplied at
		// start, so this matches the native recorder's shape.
		const levelHandlers = new Set<(level: number) => void>();
		const endedHandlers = new Set<(reason: RecordingEndedReason) => void>();
		let ended = false;

		const stopLevelMeter = startMicLevelMeter(stream, (level) => {
			for (const handler of levelHandlers) handler(level);
		});

		const release = () => {
			ended = true;
			levelHandlers.clear();
			endedHandlers.clear();
			stopLevelMeter();
			cleanupRecordingStream(stream);
		};

		// A browser capture dies when its track does: the microphone is
		// unplugged or its permission is revoked. That is the same event the
		// native recorder reports through the host, so it reaches callers the
		// same way rather than surfacing as silence.
		for (const track of stream.getAudioTracks()) {
			track.addEventListener('ended', () => {
				if (ended) return;
				const handlers = [...endedHandlers];
				release();
				for (const handler of handlers) handler('deviceDisconnected');
			});
		}

		return {
			audioBlobId,
			device,

			stop: async () => {
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
					catch: (error) => RecorderError.RecorderFailed({ cause: error }),
				});

				const durationMs = Date.now() - startedAtMs;

				if (stopError) {
					release();
					return Err(stopError);
				}
				const { error: putError } = await BlobsLive.local.put(
					audioBlobId,
					blob,
				);
				release();
				if (putError !== null) return Err(putError);

				return Ok({ audioBlobId, durationMs, byteLength: blob.size });
			},

			cancel: async () => {
				// stop() throws if the recorder is already inactive; a cancel discards
				// the recording anyway, so swallow it and always tear down.
				trySync({
					try: () => mediaRecorder.stop(),
					catch: () => Ok(undefined),
				});
				release();

				return Ok(undefined);
			},

			onLevel(handler) {
				if (ended) return () => {};
				levelHandlers.add(handler);
				return () => {
					levelHandlers.delete(handler);
				};
			},

			onEnded(handler) {
				if (ended) return () => {};
				endedHandlers.add(handler);
				return () => {
					endedHandlers.delete(handler);
				};
			},
		};
	}

	return {
		current: async (): Promise<Result<Recording | null, RecorderError>> => {
			// Browser state lives in this closure, so a JS reload zeroes it out;
			// the MediaStream/MediaRecorder are also gone in that case.
			return Ok(null);
		},

		enumerateDevices: async () => {
			const { data: devices, error } = await enumerateDevices();
			if (error) {
				return RecorderError.RecorderFailed({ cause: error });
			}
			return Ok(devices);
		},

		start: async ({
			selectedDeviceId,
			bitrateKbps,
		}: NavigatorRecordingParams) => {
			const { data: streamResult, error: acquireStreamError } =
				await getRecordingStream({ selectedDeviceId });
			if (acquireStreamError) {
				return (
					categorizeBrowserStreamError(acquireStreamError) ??
					RecorderError.RecorderFailed({ cause: acquireStreamError })
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
				catch: (error) => RecorderError.RecorderFailed({ cause: error }),
			});

			if (recorderError) {
				cleanupRecordingStream(stream);
				return Err(recorderError);
			}

			const recordedChunks: Blob[] = [];
			mediaRecorder.addEventListener('dataavailable', (event: BlobEvent) => {
				if (event.data.size) recordedChunks.push(event.data);
			});

			// MediaRecorder.start can throw synchronously (e.g. NotSupportedError);
			// without this the stream would leak with the mic indicator stuck on.
			const { error: startError } = trySync({
				try: () => mediaRecorder.start(TIMESLICE_MS),
				catch: (error) => RecorderError.RecorderFailed({ cause: error }),
			});
			if (startError) {
				cleanupRecordingStream(stream);
				return Err(startError);
			}
			const startedAtMs = Date.now();

			const recording = buildRecording({
				audioBlobId: generateBlobId(),
				device: deviceOutcome,
				stream,
				mediaRecorder,
				recordedChunks,
				startedAtMs,
			});

			return Ok(recording);
		},
	} satisfies RecorderService<NavigatorRecordingParams>;
}

/**
 * Tap a live MediaStream and report raw mic loudness (RMS) each animation frame,
 * so the caller's meter reacts to the actual voice instead of sitting flat.
 * Emits the same quantity the VAD recorder does, so both feed a meter one
 * quantity and the shared `foldMicLevel` curve renders identically. Returns a
 * stop function that tears down the audio graph; call it when the recording ends.
 */
function startMicLevelMeter(
	stream: MediaStream,
	onLevel: (level: number) => void,
): () => void {
	const audioContext = new AudioContext();
	// Recording is user-initiated, so the context is normally running; resume
	// defensively in case the autoplay policy left it suspended.
	void audioContext.resume();
	const source = audioContext.createMediaStreamSource(stream);
	const analyser = audioContext.createAnalyser();
	analyser.fftSize = 1024;
	source.connect(analyser);

	const samples = new Float32Array(analyser.fftSize);
	let frame = 0;
	const tick = () => {
		analyser.getFloatTimeDomainData(samples);
		let sumOfSquares = 0;
		for (const sample of samples) sumOfSquares += sample * sample;
		onLevel(Math.sqrt(sumOfSquares / samples.length));
		frame = requestAnimationFrame(tick);
	};
	frame = requestAnimationFrame(tick);

	return () => {
		cancelAnimationFrame(frame);
		source.disconnect();
		void audioContext.close();
	};
}

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

/**
 * Map a browser recording-stream cause (a getUserMedia `DOMException` or a
 * `DeviceStreamError` from `@epicenter/recorder`) to a cross-cutting
 * `RecorderError`, or `null` to let the call site apply its own verb. Browser
 * causes carry a `name` tag rather than a Rust enum.
 */
function categorizeBrowserStreamError(cause: unknown) {
	if (!(cause && typeof cause === 'object' && 'name' in cause)) return null;
	const name = (cause as { name: unknown }).name;

	// getUserMedia DOMException codes.
	if (name === 'NotAllowedError' || name === 'SecurityError') {
		return RecorderError.MicrophonePermissionDenied({ cause });
	}
	if (name === 'NotFoundError' || name === 'OverconstrainedError') {
		return RecorderError.NoInputDevice({ cause });
	}
	// device-stream's own tags (re-categorized so the toast layer can branch on
	// RecorderError variants without importing DeviceStreamError).
	if (name === 'PermissionDenied') {
		return RecorderError.MicrophonePermissionDenied({ cause });
	}
	if (name === 'NoDevicesFound') {
		return RecorderError.NoInputDevice({ cause });
	}

	return null;
}

export const ManualRecorderLive: RecorderService<NavigatorRecordingParams> =
	createBrowserRecorder();
