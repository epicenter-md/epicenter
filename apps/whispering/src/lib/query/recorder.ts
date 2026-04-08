import { nanoid } from 'nanoid/non-secure';
import { Ok } from 'wellcrafted/result';
import type { WhisperingRecordingState } from '$lib/constants/audio';
import { PATHS } from '$lib/constants/paths';
import { defineMutation, defineQuery, queryClient } from '$lib/query/client';
import { WhisperingErr } from '$lib/result';
import { services } from '$lib/services';
import { desktopServices } from '$lib/services/desktop';
import type { DeviceIdentifier } from '$lib/services/types';
import { asDeviceIdentifier } from '$lib/services/types';
import { deviceConfig } from '$lib/state/device-config.svelte';
import { notify } from './notify';

const recorderKeys = {
	recorderState: ['recorder', 'recorderState'] as const,
	devices: ['recorder', 'devices'] as const,
	startRecording: ['recorder', 'startRecording'] as const,
	stopRecording: ['recorder', 'stopRecording'] as const,
	cancelRecording: ['recorder', 'cancelRecording'] as const,
} as const;

/**
 * Module-level state to track the current recording ID.
 * This ensures the same ID is used from recording start through database save.
 */
let currentRecordingId: string | null = null;

const invalidateRecorderState = () =>
	queryClient.invalidateQueries({ queryKey: recorderKeys.recorderState });

function parseDeviceId(deviceId: string | null): DeviceIdentifier | null {
	if (!deviceId) return null;
	return asDeviceIdentifier(deviceId);
}

export const recorder = {
	// Query that enumerates available recording devices with labels
	enumerateDevices: defineQuery({
		queryKey: recorderKeys.devices,
		queryFn: async () => {
			const { data, error } = await recorderService().enumerateDevices();
			if (error) {
				return WhisperingErr({
					title: '❌ Failed to enumerate devices',
					serviceError: error,
				});
			}
			return Ok(data);
		},
	}),

	// Query that returns the recorder state (IDLE or RECORDING)
	getRecorderState: defineQuery({
		queryKey: recorderKeys.recorderState,
		queryFn: async () => {
			const { data: state, error: getStateError } =
				await recorderService().getRecorderState();
			if (getStateError) {
				return WhisperingErr({
					title: '❌ Failed to get recorder state',
					serviceError: getStateError,
				});
			}
			return Ok(state);
		},
		initialData: 'IDLE' as WhisperingRecordingState,
	}),

	startRecording: defineMutation({
		mutationKey: recorderKeys.startRecording,
		mutationFn: async ({ toastId }: { toastId: string }) => {
			// Generate a unique recording ID that will serve as the file name
			const recordingId = nanoid();

			// Store the recording ID so it can be reused when stopping
			currentRecordingId = recordingId;

			// Prepare recording parameters based on which method we're using
			const baseParams = {
				recordingId,
			};

			// Resolve the output folder - use default if null
			const outputFolder = window.__TAURI_INTERNALS__
				? (deviceConfig.get('recording.cpal.outputFolder') ??
					(await PATHS.DB.RECORDINGS()))
				: '';

			const paramsMap = {
				navigator: {
					...baseParams,
					method: 'navigator' as const,
					selectedDeviceId: parseDeviceId(
						deviceConfig.get('recording.navigator.deviceId'),
					),
					bitrateKbps: deviceConfig.get('recording.navigator.bitrateKbps'),
				},
				ffmpeg: {
					...baseParams,
					method: 'ffmpeg' as const,
					selectedDeviceId: parseDeviceId(
						deviceConfig.get('recording.ffmpeg.deviceId'),
					),
					globalOptions: deviceConfig.get('recording.ffmpeg.globalOptions'),
					inputOptions: deviceConfig.get('recording.ffmpeg.inputOptions'),
					outputOptions: deviceConfig.get('recording.ffmpeg.outputOptions'),
					outputFolder,
				},
				cpal: {
					...baseParams,
					method: 'cpal' as const,
					selectedDeviceId: parseDeviceId(
						deviceConfig.get('recording.cpal.deviceId'),
					),
					outputFolder,
					sampleRate: deviceConfig.get('recording.cpal.sampleRate'),
				},
			} as const;

			const params =
				paramsMap[
					!window.__TAURI_INTERNALS__
						? 'navigator'
						: deviceConfig.get('recording.method')
				];

			const { data: deviceAcquisitionOutcome, error: startRecordingError } =
				await recorderService().startRecording(params, {
					sendStatus: (options) => notify.loading({ id: toastId, ...options }),
				});

			if (startRecordingError) {
				return WhisperingErr({
					title: '❌ Failed to start recording',
					serviceError: startRecordingError,
				});
			}
			return Ok(deviceAcquisitionOutcome);
		},
		onSettled: invalidateRecorderState,
	}),

	stopRecording: defineMutation({
		mutationKey: recorderKeys.stopRecording,
		mutationFn: async ({ toastId }: { toastId: string }) => {
			const { data: blob, error: stopRecordingError } =
				await recorderService().stopRecording({
					sendStatus: (options) => notify.loading({ id: toastId, ...options }),
				});

			if (stopRecordingError) {
				// Reset recording ID on error
				currentRecordingId = null;
				return WhisperingErr({
					title: '❌ Failed to stop recording',
					serviceError: stopRecordingError,
				});
			}

			// Retrieve the stored recording ID
			const recordingId = currentRecordingId;

			// Reset the recording ID now that we've retrieved it
			currentRecordingId = null;

			if (!recordingId) {
				return WhisperingErr({
					title: '❌ Missing recording ID',
					description:
						'An internal error occurred: recording ID was not set when stopping the recording.',
				});
			}

			// Return both blob and recordingId so they can be used together
			return Ok({ blob, recordingId });
		},
		onSettled: invalidateRecorderState,
	}),

	cancelRecording: defineMutation({
		mutationKey: recorderKeys.cancelRecording,
		mutationFn: async ({ toastId }: { toastId: string }) => {
			const { data: cancelResult, error: cancelRecordingError } =
				await recorderService().cancelRecording({
					sendStatus: (options) => notify.loading({ id: toastId, ...options }),
				});

			// Reset recording ID when canceling
			currentRecordingId = null;

			if (cancelRecordingError) {
				return WhisperingErr({
					title: '❌ Failed to cancel recording',
					serviceError: cancelRecordingError,
				});
			}

			return Ok(cancelResult);
		},
		onSettled: invalidateRecorderState,
	}),
};

/**
 * Get the appropriate recorder service based on settings and environment
 */
export function recorderService() {
	// In browser, always use navigator recorder
	if (!window.__TAURI_INTERNALS__) return services.navigatorRecorder;

	const recorderMap = {
		navigator: services.navigatorRecorder,
		ffmpeg: desktopServices.ffmpegRecorder,
		cpal: desktopServices.cpalRecorder,
	};
	return recorderMap[deviceConfig.get('recording.method')];
}
