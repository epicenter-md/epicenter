import { nanoid } from 'nanoid/non-secure';
import { Ok } from 'wellcrafted/result';
import type { WhisperingRecordingState } from '$lib/constants/audio';
import { PATHS } from '$lib/constants/paths';
import { defineMutation, defineQuery, queryClient } from '$lib/query/client';
import { WhisperingErr } from '$lib/result';
import { desktopServices, services } from '$lib/services';
import { settings } from '$lib/stores/settings.svelte';
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
				? (settings.value['recording.cpal.outputFolder'] ??
					(await PATHS.DB.RECORDINGS()))
				: '';

			const paramsMap = {
				navigator: {
					...baseParams,
					method: 'navigator' as const,
					selectedDeviceId: settings.value['recording.navigator.deviceId'],
					bitrateKbps: settings.value['recording.navigator.bitrateKbps'],
				},
				ffmpeg: {
					...baseParams,
					method: 'ffmpeg' as const,
					selectedDeviceId: settings.value['recording.ffmpeg.deviceId'],
					globalOptions: settings.value['recording.ffmpeg.globalOptions'],
					inputOptions: settings.value['recording.ffmpeg.inputOptions'],
					outputOptions: settings.value['recording.ffmpeg.outputOptions'],
					outputFolder,
				},
				cpal: {
					...baseParams,
					method: 'cpal' as const,
					selectedDeviceId: settings.value['recording.cpal.deviceId'],
					outputFolder,
					sampleRate: settings.value['recording.cpal.sampleRate'],
				},
			} as const;

			const params =
				paramsMap[
					!window.__TAURI_INTERNALS__
						? 'navigator'
						: settings.value['recording.method']
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
	return recorderMap[settings.value['recording.method']];
}
