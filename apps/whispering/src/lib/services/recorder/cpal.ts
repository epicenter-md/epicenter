import type {
	CancelRecordingResult,
	WhisperingRecordingState,
} from '$lib/constants/audio';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { readFile, remove } from '@tauri-apps/plugin-fs';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import type { Device, DeviceAcquisitionOutcome } from '../types';
import { asDeviceIdentifier } from '../types';
import type {
	CpalRecordingParams,
	RecorderService,
	RecorderServiceError,
} from './types';
import { RecorderServiceErr } from './types';

/**
 * Audio recording data returned from the Rust method
 */
type AudioRecording = {
	sampleRate: number;
	channels: number;
	durationSeconds: number;
	filePath?: string;
};

export function createCpalRecorderService(): RecorderService {
	const enumerateDevices = async (): Promise<
		Result<Device[], RecorderServiceError>
	> => {
		const { data: deviceNames, error: enumerateRecordingDevicesError } =
			await invoke<string[]>('enumerate_recording_devices');
		if (enumerateRecordingDevicesError) {
			return RecorderServiceErr({
				message: 'Failed to enumerate recording devices',
				cause: enumerateRecordingDevicesError,
			});
		}
		// On desktop, device names serve as both ID and label
		return Ok(
			deviceNames.map((name) => ({
				id: asDeviceIdentifier(name),
				label: name,
			})),
		);
	};

	return {
		getRecorderState: async (): Promise<
			Result<WhisperingRecordingState, RecorderServiceError>
		> => {
			const { data: recordingId, error: getRecorderStateError } = await invoke<
				string | null
			>('get_current_recording_id');
			if (getRecorderStateError)
				return RecorderServiceErr({
					message:
						'We encountered an issue while getting the recorder state. This could be because your microphone is being used by another app, your microphone permissions are denied, or the selected recording device is disconnected',
					context: { error: getRecorderStateError },
					cause: getRecorderStateError,
				});

			return Ok(recordingId ? 'RECORDING' : 'IDLE');
		},

		enumerateDevices,

		startRecording: async (
			{
				selectedDeviceId,
				recordingId,
				outputFolder,
				sampleRate,
			}: CpalRecordingParams,
			{ sendStatus },
		): Promise<Result<DeviceAcquisitionOutcome, RecorderServiceError>> => {
			const { data: devices, error: enumerateError } = await enumerateDevices();
			if (enumerateError) return Err(enumerateError);

			const acquireDevice = (): Result<
				DeviceAcquisitionOutcome,
				RecorderServiceError
			> => {
				const deviceIds = devices.map((d) => d.id);
				const fallbackDeviceId = deviceIds.at(0);
				if (!fallbackDeviceId) {
					return RecorderServiceErr({
						message: selectedDeviceId
							? "We couldn't find the selected microphone. Make sure it's connected and try again!"
							: "We couldn't find any microphones. Make sure they're connected and try again!",
						context: { selectedDeviceId, deviceIds },
						cause: undefined,
					});
				}

				if (!selectedDeviceId) {
					sendStatus({
						title: '🔍 No Device Selected',
						description:
							"No worries! We'll find the best microphone for you automatically...",
					});
					return Ok({
						outcome: 'fallback',
						reason: 'no-device-selected',
						deviceId: fallbackDeviceId,
					});
				}

				// Check if the selected device exists in the devices array
				const deviceExists = deviceIds.includes(selectedDeviceId);

				if (deviceExists)
					return Ok({ outcome: 'success', deviceId: selectedDeviceId });

				sendStatus({
					title: '⚠️ Finding a New Microphone',
					description:
						"That microphone isn't available. Let's try finding another one...",
				});

				return Ok({
					outcome: 'fallback',
					reason: 'preferred-device-unavailable',
					deviceId: fallbackDeviceId,
				});
			};

			const { data: deviceOutcome, error: acquireDeviceError } =
				acquireDevice();
			if (acquireDeviceError) return Err(acquireDeviceError);

			// Use the device from the outcome
			const deviceIdentifier = deviceOutcome.deviceId;

			// Now initialize recording with the chosen device
			sendStatus({
				title: '🎤 Setting Up',
				description:
					'Initializing your recording session and checking microphone access...',
			});

			// Convert sample rate string to number if provided
			const sampleRateNum = sampleRate
				? Number.parseInt(sampleRate, 10)
				: undefined;

			const { error: initRecordingSessionError } = await invoke(
				'init_recording_session',
				{
					deviceIdentifier,
					recordingId,
					outputFolder,
					sampleRate: sampleRateNum,
				},
			);
			if (initRecordingSessionError)
				return RecorderServiceErr({
					message:
						'We encountered an issue while setting up your recording session. This could be because your microphone is being used by another app, your microphone permissions are denied, or the selected recording device is disconnected',
					context: {
						selectedDeviceId,
						deviceIdentifier,
					},
					cause: initRecordingSessionError,
				});

			sendStatus({
				title: '🎙️ Starting Recording',
				description:
					'Recording session initialized, now starting to capture audio...',
			});
			const { error: startRecordingError } =
				await invoke<void>('start_recording');
			if (startRecordingError)
				return RecorderServiceErr({
					message:
						'Unable to start recording. Please check your microphone and try again.',
					context: { deviceIdentifier, deviceOutcome },
					cause: startRecordingError,
				});

			return Ok(deviceOutcome);
		},

		stopRecording: async ({
			sendStatus,
		}): Promise<Result<Blob, RecorderServiceError>> => {
			const { data: audioRecording, error: stopRecordingError } =
				await invoke<AudioRecording>('stop_recording');
			if (stopRecordingError) {
				return RecorderServiceErr({
					message: 'Unable to save your recording. Please try again.',
					context: { operation: 'stopRecording' },
					cause: stopRecordingError,
				});
			}

			const { filePath } = audioRecording;
			// Desktop recorder should always write to a file
			if (!filePath) {
				return RecorderServiceErr({
					message: 'Recording file path not provided by method.',
					context: {
						operation: 'stopRecording',
						audioRecording,
					},
					cause: undefined,
				});
			}
			// audioRecording is now AudioRecordingWithFile

			// Read the WAV file from disk
			sendStatus({
				title: '📁 Reading Recording',
				description: 'Loading your recording from disk...',
			});

			const { data: blob, error: readRecordingFileError } = await tryAsync({
				try: async () => {
					const fileBytes = await readFile(filePath);
					return new Blob([fileBytes], { type: 'audio/wav' });
				},
				catch: (error) =>
					RecorderServiceErr({
						message: 'Unable to read recording file. Please try again.',
						context: { audioRecording },
						cause: error,
					}),
			});
			if (readRecordingFileError) return Err(readRecordingFileError);

			// Close the recording session after stopping
			sendStatus({
				title: '🔄 Closing Session',
				description: 'Cleaning up recording resources...',
			});
			const { error: closeError } = await invoke<void>(
				'close_recording_session',
			);
			if (closeError) {
				// Log but don't fail the stop operation
				console.error('Failed to close recording session:', closeError);
			}

			return Ok(blob);
		},

		cancelRecording: async ({
			sendStatus,
		}): Promise<Result<CancelRecordingResult, RecorderServiceError>> => {
			// Check current state first
			const { data: recordingId, error: getRecordingIdError } = await invoke<
				string | null
			>('get_current_recording_id');
			if (getRecordingIdError) {
				return RecorderServiceErr({
					message:
						'Unable to check recording state. Please try closing the app and starting again.',
					context: { operation: 'cancelRecording' },
					cause: getRecordingIdError,
				});
			}

			if (!recordingId) {
				return Ok({ status: 'no-recording' });
			}

			sendStatus({
				title: '🛑 Cancelling',
				description:
					'Safely stopping your recording and cleaning up resources...',
			});

			// First get the recording data to know if there's a file to delete
			const { data: audioRecording } =
				await invoke<AudioRecording>('stop_recording');

			// If there's a file path, delete the file using Tauri FS plugin
			if (audioRecording?.filePath) {
				const { filePath } = audioRecording;
				const { error: removeError } = await tryAsync({
					try: () => remove(filePath),
					catch: (error) =>
						RecorderServiceErr({
							message: 'Failed to delete recording file.',
							context: { audioRecording },
							cause: error,
						}),
				});
				if (removeError)
					sendStatus({
						title: '❌ Error Deleting Recording File',
						description:
							"We couldn't delete the recording file. Continuing with the cancellation process...",
					});
			}

			// Close the recording session after cancelling
			sendStatus({
				title: '🔄 Closing Session',
				description: 'Cleaning up recording resources...',
			});
			const { error: closeError } = await invoke<void>(
				'close_recording_session',
			);
			if (closeError) {
				// Log but don't fail the cancel operation
				console.error('Failed to close recording session:', closeError);
			}

			return Ok({ status: 'cancelled' });
		},
	};
}

/**
 * CPAL recorder service that uses the Rust CPAL method.
 * This is the CPAL audio recorder for desktop environments.
 */
export const CpalRecorderServiceLive = createCpalRecorderService();

async function invoke<T>(command: string, args?: Record<string, unknown>) {
	return tryAsync({
		try: async () => await tauriInvoke<T>(command, args),
		catch: (error) =>
			Err({ name: 'TauriInvokeError', command, error } as const),
	});
}
