import { Err, Ok, type Result, tryAsync, trySync } from 'wellcrafted/result';
import {
	type CancelRecordingResult,
	TIMESLICE_MS,
	type WhisperingRecordingState,
} from '$lib/constants/audio';
import {
	cleanupRecordingStream,
	enumerateDevices,
	getRecordingStream,
} from '$lib/services/device-stream';
import type {
	DeviceAcquisitionOutcome,
	DeviceIdentifier,
} from '$lib/services/types';
import type { NavigatorRecordingParams, RecorderService } from './types';
import { RecorderError } from './types';

type ActiveRecording = {
	recordingId: string;
	selectedDeviceId: DeviceIdentifier | null;
	bitrateKbps: string;
	stream: MediaStream;
	mediaRecorder: MediaRecorder;
	recordedChunks: Blob[];
};

let activeRecording: ActiveRecording | null = null;

/**
 * Navigator recorder service that uses the MediaRecorder API.
 * Available in both browser and desktop environments.
 */
export const NavigatorRecorderServiceLive: RecorderService = {
	getRecorderState: async (): Promise<
		Result<WhisperingRecordingState, RecorderError>
	> => {
		return Ok(activeRecording ? 'RECORDING' : 'IDLE');
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
	): Promise<Result<DeviceAcquisitionOutcome, RecorderError>> => {
		// Ensure we're not already recording
		if (activeRecording) {
			return RecorderError.AlreadyRecording();
		}

		sendStatus({
			title: '🎙️ Starting Recording',
			description: 'Setting up your microphone...',
		});

		// Get the recording stream
		const { data: streamResult, error: acquireStreamError } =
			await getRecordingStream({ selectedDeviceId, sendStatus });
		if (acquireStreamError) {
			return RecorderError.StreamAcquisition({ cause: acquireStreamError });
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
			// Clean up stream if recorder creation fails
			cleanupRecordingStream(stream);
			return Err(recorderError);
		}

		// Set up recording state and event handlers
		const recordedChunks: Blob[] = [];

		// Store active recording state
		activeRecording = {
			recordingId,
			selectedDeviceId,
			bitrateKbps,
			stream,
			mediaRecorder,
			recordedChunks,
		};

		// Set up event handlers
		mediaRecorder.addEventListener('dataavailable', (event: BlobEvent) => {
			if (event.data.size) recordedChunks.push(event.data);
		});

		// Start recording
		mediaRecorder.start(TIMESLICE_MS);

		// Return the device acquisition outcome
		return Ok(deviceOutcome);
	},

	stopRecording: async ({
		sendStatus,
	}): Promise<Result<Blob, RecorderError>> => {
		if (!activeRecording) {
			return RecorderError.NotRecording({
				message:
					'Cannot stop recording because no active recording session was found. Make sure you have started recording before attempting to stop it.',
			});
		}

		const recording = activeRecording;
		activeRecording = null; // Clear immediately to prevent race conditions

		sendStatus({
			title: '⏸️ Finishing Recording',
			description: 'Saving your audio...',
		});

		// Stop the recorder and wait for the final data
		const { data: blob, error: stopError } = await tryAsync({
			try: () =>
				new Promise<Blob>((resolve) => {
					recording.mediaRecorder.addEventListener('stop', () => {
						const audioBlob = new Blob(recording.recordedChunks, {
							type: recording.mediaRecorder.mimeType,
						});
						resolve(audioBlob);
					});
					recording.mediaRecorder.stop();
				}),
			catch: (error) => RecorderError.StopFailed({ cause: error }),
		});

		// Always clean up the stream
		cleanupRecordingStream(recording.stream);

		if (stopError) return Err(stopError);

		sendStatus({
			title: '✅ Recording Saved',
			description: 'Your recording is ready for transcription!',
		});
		return Ok(blob);
	},

	cancelRecording: async ({
		sendStatus,
	}): Promise<Result<CancelRecordingResult, RecorderError>> => {
		if (!activeRecording) {
			return Ok({ status: 'no-recording' });
		}

		const recording = activeRecording;
		activeRecording = null; // Clear immediately

		sendStatus({
			title: '🛑 Cancelling',
			description: 'Discarding your recording...',
		});

		// Stop the recorder
		recording.mediaRecorder.stop();

		// Clean up the stream
		cleanupRecordingStream(recording.stream);

		sendStatus({
			title: '✨ Cancelled',
			description: 'Recording discarded successfully!',
		});

		return Ok({ status: 'cancelled' });
	},
};

export type NavigatorRecorderService = typeof NavigatorRecorderServiceLive;

/**
 * Determines the best supported audio MIME type for the current browser.
 *
 * Called before `MediaRecorder` construction so the type can be passed explicitly.
 * This is the industry-standard pattern (used by LibreChat, AutoGPT, 1code, etc.)
 * because:
 *
 * 1. Firefox (and forks like Zen) may leave `mediaRecorder.mimeType` empty when
 *    no type is specified at construction — see https://bugzilla.mozilla.org/show_bug.cgi?id=1512175
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
