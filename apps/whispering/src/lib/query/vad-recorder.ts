import type { VadState } from '$lib/constants/audio';
import { fromTaggedErr } from '$lib/result';
import * as services from '$lib/services';
import { enumerateDevices } from '$lib/services/device-stream';
import { settings } from '$lib/stores/settings.svelte';
import { Ok } from 'wellcrafted/result';
import { defineMutation, defineQuery, queryClient } from './_client';

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
			const vadState = services.vad.getVadState();
			return Ok(vadState);
		},
		initialData: 'IDLE' as VadState,
	}),

	enumerateDevices: defineQuery({
		queryKey: vadRecorderKeys.devices,
		resultQueryFn: async () => {
			const { data, error } = await enumerateDevices();
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
				await services.vad.startActiveListening({
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
				await services.vad.stopActiveListening();

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
