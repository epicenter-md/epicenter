import type { VadState } from '$lib/constants/audio';
import { fromTaggedErr } from '$lib/result';
import * as services from '$lib/services';
import { settings } from '$lib/stores/settings.svelte';
import { Ok } from 'wellcrafted/result';
import { defineMutation, defineQuery, queryClient } from './_client';

// Dynamically select VAD service based on settings
function vadService() {
	return settings.value['recording.vad.useNative'] ? services.nativeVad : services.vad;
}

const vadRecorderKeys = {
	all: ['vadRecorder'] as const,
	state: ['vadRecorder', 'state'] as const,
	devices: ['vadRecorder', 'devices'] as const,
} as const;

const invalidateVadState = () =>
	queryClient.invalidateQueries({ queryKey: vadRecorderKeys.state });

export const vadRecorder = {
	getVadState: defineQuery({
		queryKey: vadRecorderKeys.state,
		resultQueryFn: () => {
			const vadState = vadService().getVadState();
			return Ok(vadState);
		},
		initialData: 'IDLE' as VadState,
	}),

	enumerateDevices: defineQuery({
		queryKey: vadRecorderKeys.devices,
		resultQueryFn: async () => {
			// Now all VAD services have enumerateDevices method
			const { data, error } = await vadService().enumerateDevices();
			if (error) {
				return fromTaggedErr(error, {
					title: '❌ Failed to enumerate devices',
					action: { type: 'more-details', error },
				});
			}
			return Ok(data);
		},
	}),

	startActiveListening: defineMutation({
		mutationKey: ['vadRecorder', 'startActiveListening'] as const,
		resultMutationFn: async ({
			onSpeechStart,
			onSpeechEnd,
		}: {
			onSpeechStart: () => void;
			onSpeechEnd: (blob: Blob) => void;
		}) => {
			const { data: deviceOutcome, error: startListeningError } =
				await vadService().startActiveListening({
					deviceId: settings.value['recording.navigator.deviceId'],
					onSpeechStart: () => {
						invalidateVadState();
						onSpeechStart();
					},
					onSpeechEnd: (blob) => {
						invalidateVadState();
						onSpeechEnd(blob);
					},
					onVADMisfire: () => {
						invalidateVadState();
					},
					onSpeechRealStart: () => {
						invalidateVadState();
					},
				});

			if (startListeningError) {
				return fromTaggedErr(startListeningError, {
					title: '❌ Failed to start voice activity detection',
					action: { type: 'more-details', error: startListeningError },
				});
			}

			invalidateVadState();
			return Ok(deviceOutcome);
		},
	}),

	stopActiveListening: defineMutation({
		mutationKey: ['vadRecorder', 'stopActiveListening'] as const,
		resultMutationFn: async () => {
			const { data, error: stopListeningError } =
				await vadService().stopActiveListening();

			if (stopListeningError) {
				return fromTaggedErr(stopListeningError, {
					title: '❌ Failed to stop voice activity detection',
					action: { type: 'more-details', error: stopListeningError },
				});
			}

			invalidateVadState();
			return Ok(data);
		},
	}),
};
