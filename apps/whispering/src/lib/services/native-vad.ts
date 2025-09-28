import type { VadState } from '$lib/constants/audio';
import { createTaggedError } from 'wellcrafted/error';
import { Err, Ok, tryAsync } from 'wellcrafted/result';
import type { DeviceIdentifier } from './types';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { readFile } from '@tauri-apps/plugin-fs';

const { VadRecorderServiceError, VadRecorderServiceErr } = createTaggedError(
	'VadRecorderServiceError',
);
export type VadRecorderServiceError = ReturnType<
	typeof VadRecorderServiceError
>;

type VadSpeechDetectedPayload = {
	filePath: string;
	fileContents?: number[]; // Vec<u8> from Rust becomes number[] in TypeScript
};

export function createNativeVadService() {
	let vadState: VadState = 'IDLE';
	let unlistenFn: (() => void) | null = null;

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
			onVADMisfire?: () => void;
			onSpeechRealStart?: () => void;
		}) => {
			// Check if already active
			if (vadState !== 'IDLE') {
				return VadRecorderServiceErr({
					message: 'VAD already active. Stop the current session before starting a new one.',
					context: { vadState },
					cause: undefined,
				});
			}

			// Set to LISTENING immediately, like web VAD does
			vadState = 'LISTENING';

			// Log the starting parameters (sensitivity will be logged later after import)

			// Set up event listener BEFORE starting VAD
			const { error: listenError } = await tryAsync({
				try: async () => {
					// Listen for speech start events
					const startUnlisten = await listen('vad-speech-start', () => {
						vadState = 'SPEECH_DETECTED';
						onSpeechStart();
					});

					// Listen for speech end events with audio data
					const endUnlisten = await listen<VadSpeechDetectedPayload>('vad-speech-detected', async (event) => {

						// Use file contents from the event if available
						if (event.payload.fileContents && event.payload.fileContents.length > 0) {
							const audioBytes = new Uint8Array(event.payload.fileContents);
							const blob = new Blob([audioBytes], { type: 'audio/wav' });

							// Notify speech end with blob
							vadState = 'LISTENING';
							onSpeechEnd(blob);
						}
					});

					// Store both unlisten functions
					unlistenFn = () => {
						startUnlisten();
						endUnlisten();
					};
				},
				catch: (error) =>
					VadRecorderServiceErr({
						message: 'Failed to set up VAD event listener',
						context: { deviceId },
						cause: error,
					}),
			});

			if (listenError) {
				return Err(listenError);
			}

			// Get sensitivity from settings
			const { settings } = await import('$lib/stores/settings.svelte');
			const sensitivity = settings.value['recording.vad.sensitivity'] || 0.3;


			// Start VAD recording with user-configured sensitivity
			const { error: startError } = await tryAsync({
				try: () => invoke('start_vad_recording', {
					deviceIdentifier: deviceId || 'default',
					threshold: sensitivity,
					silenceTimeoutMs: 800,
				}),
				catch: (error) =>
					VadRecorderServiceErr({
						message: 'Failed to start native VAD recording',
						context: { deviceId },
						cause: error,
					}),
			});

			if (startError) {
				// Clean up listener if start failed
				if (unlistenFn) {
					unlistenFn();
					unlistenFn = null;
				}
				return Err(startError);
			}

			vadState = 'LISTENING';
			return Ok({
				outcome: 'success' as const,
				deviceId: deviceId || 'default',
			});
		},

		stopActiveListening: async () => {
			if (vadState === 'IDLE') return Ok(undefined);

	
			// Clean up listener
			if (unlistenFn) {
				unlistenFn();
				unlistenFn = null;
			}

			// Stop VAD recording
			const { error: stopError } = await tryAsync({
				try: () => invoke('stop_vad_recording'),
				catch: (error) =>
					VadRecorderServiceErr({
						message: 'Failed to stop native VAD recording',
						context: { vadState },
						cause: error,
					}),
			});

			vadState = 'IDLE';

			if (stopError) return Err(stopError);
			return Ok(undefined);
		},

		// Add device enumeration capability
		enumerateDevices: async () => {
			const { data, error } = await tryAsync({
				try: async () => {
					const devices = await invoke<string[]>('enumerate_recording_devices');
					// Convert to our device format - using 'id' field to match web format
					return devices.map(device => ({
						id: device as DeviceIdentifier,
						label: device,
					}));
				},
				catch: (error) =>
					VadRecorderServiceErr({
						message: 'Failed to enumerate recording devices',
						cause: error,
					}),
			});

			if (error) return Err(error);
			return Ok(data);
		},
	};
}

export type VadService = ReturnType<typeof createNativeVadService>;

// Export a live instance (but this should be conditionally loaded in services/index.ts)
export const NativeVadServiceLive = createNativeVadService();