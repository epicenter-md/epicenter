import { extractErrorMessage } from 'wellcrafted/error';
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
} from '$lib/services/isomorphic/device-stream';
import {
	startAudioAnalysis,
	stopAudioAnalysis,
} from '$lib/services/isomorphic/audio-analyser';
import type {
	DeviceAcquisitionOutcome,
	DeviceIdentifier,
} from '$lib/services/types';
import type {
	NavigatorRecordingParams,
	RecorderService,
	RecorderServiceError,
} from './types';
import { RecorderServiceErr } from './types';

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
		Result<WhisperingRecordingState, RecorderServiceError>
	> => {
		return Ok(activeRecording ? 'RECORDING' : 'IDLE');
	},

	enumerateDevices: async () => {
		const { data: devices, error } = await enumerateDevices();
		if (error) {
			return RecorderServiceErr({
				message: error.message,
			});
		}
		return Ok(devices);
	},

	startRecording: async (
		{ selectedDeviceId, recordingId, bitrateKbps }: NavigatorRecordingParams,
		{ sendStatus },
	): Promise<Result<DeviceAcquisitionOutcome, RecorderServiceError>> => {
		// Ensure we're not already recording
		if (activeRecording) {
			return RecorderServiceErr({
				message:
					'A recording is already in progress. Please stop the current recording before starting a new one.',
			});
		}

		sendStatus({
			title: '🎙️ Starting Recording',
			description: 'Setting up your microphone...',
		});

		// Get the recording stream
		const { data: streamResult, error: acquireStreamError } =
			await getRecordingStream({ selectedDeviceId, sendStatus });
		if (acquireStreamError) {
			return RecorderServiceErr({
				message: acquireStreamError.message,
			});
		}

		const { stream, deviceOutcome } = streamResult;

		const { data: mediaRecorder, error: recorderError } = trySync({
			try: () =>
				new MediaRecorder(stream, {
					bitsPerSecond: Number(bitrateKbps) * 1000,
				}),
			catch: (error) =>
				RecorderServiceErr({
					message: `Failed to initialize the audio recorder. This could be due to unsupported audio settings, microphone conflicts, or browser limitations. Please check your microphone is working and try adjusting your audio settings. ${extractErrorMessage(error)}`,
				}),
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

		// Start audio level analysis for the recording indicator
		startAudioAnalysis(stream).catch((error) => {
			console.warn('[NavigatorRecorder] Failed to start audio analysis:', error);
		});

		// Return the device acquisition outcome
		return Ok(deviceOutcome);
	},

	stopRecording: async ({
		sendStatus,
	}): Promise<Result<Blob, RecorderServiceError>> => {
		if (!activeRecording) {
			return RecorderServiceErr({
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
			catch: (error) =>
				RecorderServiceErr({
					message: `Failed to properly stop and save the recording. This might be due to corrupted audio data, insufficient storage space, or a browser issue. Your recording data may be lost. ${extractErrorMessage(error)}`,
				}),
		});

		// Always clean up the stream and audio analysis
		cleanupRecordingStream(recording.stream);
		await stopAudioAnalysis();

		if (stopError) return Err(stopError);

		sendStatus({
			title: '✅ Recording Saved',
			description: 'Your recording is ready for transcription!',
		});
		return Ok(blob);
	},

	cancelRecording: async ({
		sendStatus,
	}): Promise<Result<CancelRecordingResult, RecorderServiceError>> => {
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

		// Clean up the stream and audio analysis
		cleanupRecordingStream(recording.stream);
		await stopAudioAnalysis();

		sendStatus({
			title: '✨ Cancelled',
			description: 'Recording discarded successfully!',
		});

		return Ok({ status: 'cancelled' });
	},
};

export type NavigatorRecorderService = typeof NavigatorRecorderServiceLive;
