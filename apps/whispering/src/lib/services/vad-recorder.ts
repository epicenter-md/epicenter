import { MicVAD, utils } from '@ricky0123/vad-web';
import { createTaggedError, extractErrorMessage } from 'wellcrafted/error';
import { Err, Ok, tryAsync, trySync } from 'wellcrafted/result';
import type { VadState } from '$lib/constants/audio';
import { cleanupRecordingStream, getRecordingStream } from './device-stream';
import type { DeviceIdentifier } from './types';

const { VadRecorderServiceError, VadRecorderServiceErr } = createTaggedError(
	'VadRecorderServiceError',
);
export type VadRecorderServiceError = ReturnType<
	typeof VadRecorderServiceError
>;

export function createVadService() {
	let maybeVad: MicVAD | null = null;
	let vadState: VadState = 'IDLE';
	let currentStream: MediaStream | null = null;

	return {
		getVadState: (): VadState => {
			return vadState;
		},

		startActiveListening: async ({
			deviceId,
			onSpeechStart,
			onSpeechEnd,
			onVADMisfire,
			onSpeechRealStart,
		}: {
			deviceId: DeviceIdentifier | null;
			onSpeechStart: () => void;
			onSpeechEnd: (blob: Blob) => void;
		} & Pick<MicVAD['options'], 'onVADMisfire' | 'onSpeechRealStart'>) => {
			// Always start fresh - no reuse
			if (maybeVad) {
				return VadRecorderServiceErr({
					message:
						'VAD already active. Stop the current session before starting a new one.',
					context: { vadState },
					cause: undefined,
				});
			}
			console.log('Starting VAD recording');

			// Get validated stream with device fallback
			const { data: streamResult, error: streamError } =
				await getRecordingStream({
					selectedDeviceId: deviceId,
					sendStatus: (status) => {
						console.log('VAD getRecordingStream status update:', status);
					},
				});

			console.log('Stream error', streamError);
			if (streamError) {
				return VadRecorderServiceErr({
					message: streamError.message,
					context: streamError.context,
					cause: streamError,
				});
			}

			const { stream, deviceOutcome } = streamResult;
			currentStream = stream;

			// Create VAD with the validated stream
			const { data: newVad, error: initializeVadError } = await tryAsync({
				try: () =>
					MicVAD.new({
						stream, // Pass our validated stream directly
						submitUserSpeechOnPause: true,
						onSpeechStart: () => {
							vadState = 'SPEECH_DETECTED';
							onSpeechStart();
						},
						onSpeechEnd: (audio) => {
							vadState = 'LISTENING';
							const wavBuffer = utils.encodeWAV(audio);
							const blob = new Blob([wavBuffer], { type: 'audio/wav' });
							onSpeechEnd(blob);
						},
						onVADMisfire: () => {
							onVADMisfire();
						},
						onSpeechRealStart: () => {
							onSpeechRealStart();
						},
						model: 'v5',
					}),
				catch: (error) =>
					VadRecorderServiceErr({
						message:
							'Failed to start voice activated capture. Your voice activated capture could not be started.',
						context: { deviceId },
						cause: error,
					}),
			});

			if (initializeVadError) {
				// Clean up stream if VAD initialization fails
				cleanupRecordingStream(stream);
				currentStream = null;
				return Err(initializeVadError);
			}

			// Start listening
			const { error: startError } = trySync({
				try: () => newVad.start(),
				catch: (error) =>
					VadRecorderServiceErr({
						message: `Failed to start Voice Activity Detector. ${extractErrorMessage(error)}`,
						context: { vadState },
						cause: error,
					}),
			});
			if (startError) {
				// Clean up everything on start error
				trySync({
					try: () => newVad.destroy(),
					catch: (error) =>
						VadRecorderServiceErr({
							message: `Failed to destroy Voice Activity Detector. ${extractErrorMessage(error)}`,
							context: { vadState },
							cause: error,
						}),
				});
				cleanupRecordingStream(stream);
				maybeVad = null;
				currentStream = null;
				return Err(startError);
			}

			maybeVad = newVad;
			vadState = 'LISTENING';
			return Ok(deviceOutcome);
		},

		stopActiveListening: async () => {
			if (!maybeVad) return Ok(undefined);

			const vad = maybeVad;
			const { error: destroyError } = trySync({
				try: () => vad.destroy(),
				catch: (error) =>
					VadRecorderServiceErr({
						message: `Failed to stop Voice Activity Detector. ${extractErrorMessage(error)}`,
						context: { vadState },
						cause: error,
					}),
			});

			// Always clean up, even if destroy had an error
			maybeVad = null;
			vadState = 'IDLE';

			// Clean up our managed stream
			if (currentStream) {
				cleanupRecordingStream(currentStream);
				currentStream = null;
			}

			if (destroyError) return Err(destroyError);
			return Ok(undefined);
		},
	};
}

export type VadService = ReturnType<typeof createVadService>;

export const VadServiceLive = createVadService();
