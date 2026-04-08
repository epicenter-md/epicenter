import {
	TRANSCRIPTION_SERVICES,
	type TranscriptionService,
} from '$lib/services/transcription/registry';
import { deviceConfig } from '$lib/state/device-config.svelte';
import { settings } from '$lib/state/settings.svelte';

/**
 * Gets the currently selected transcription service.
 * Returns undefined if the service is not available on this platform.
 *
 * @returns The selected transcription service, or undefined if none selected or invalid
 */
export function getSelectedTranscriptionService():
	| TranscriptionService
	| undefined {
	const selectedServiceId = settings.get('transcription.service');
	return TRANSCRIPTION_SERVICES.find((s) => s.id === selectedServiceId);
}

/**
 * Checks if a transcription service has all required configuration.
 *
 * @param service - The transcription service to check
 * @param settings - The current settings object
 * @returns true if the service is properly configured, false otherwise
 */
export function isTranscriptionServiceConfigured(
	service: TranscriptionService,
): boolean {
	switch (service.location) {
		case 'cloud': {
			const apiKeyByService = {
				Groq: 'apiKeys.groq',
				OpenAI: 'apiKeys.openai',
				ElevenLabs: 'apiKeys.elevenlabs',
				Deepgram: 'apiKeys.deepgram',
				Mistral: 'apiKeys.mistral',
			} as const;

			return deviceConfig.get(apiKeyByService[service.id]) !== '';
		}
		case 'self-hosted': {
			const url = deviceConfig.get('transcription.speaches.baseUrl');
			return url !== '';
		}
		case 'local': {
			const modelPathByService = {
				whispercpp: 'transcription.whispercpp.modelPath',
				parakeet: 'transcription.parakeet.modelPath',
				moonshine: 'transcription.moonshine.modelPath',
			} as const;

			return deviceConfig.get(modelPathByService[service.id]) !== '';
		}
		default: {
			return true;
		}
	}
}
