import { tauri } from '#platform/tauri';
import {
	TRANSCRIPTION_PROVIDERS,
	type TranscriptionProviderEntry,
} from '$lib/services/transcription/provider-ui';
import { deviceConfig } from '$lib/state/device-config.svelte';
import { settings } from '$lib/state/settings.svelte';

function hasValue(value: string) {
	return value.trim() !== '';
}

export function getSelectedTranscriptionProvider():
	| TranscriptionProviderEntry
	| undefined {
	const selectedServiceId = settings.get('transcription.service');
	return TRANSCRIPTION_PROVIDERS.find((s) => s.id === selectedServiceId);
}

export function isTranscriptionServiceAvailable(
	service: TranscriptionProviderEntry,
): boolean {
	return Boolean(tauri) || service.location !== 'local';
}

/**
 * Gets the currently selected transcription service.
 * Returns undefined if the service is not available on this platform.
 *
 * @returns The selected transcription service, or undefined if none selected or invalid
 */
export function getSelectedTranscriptionService():
	| TranscriptionProviderEntry
	| undefined {
	const service = getSelectedTranscriptionProvider();
	if (service && !isTranscriptionServiceAvailable(service)) return undefined;
	return service;
}

/**
 * Checks if a transcription service has all required configuration. The
 * required key is the provider's own config key (apiKey / endpoint / model),
 * read straight from its registry entry.
 *
 * @param service - The transcription service to check
 * @returns true if the service is properly configured, false otherwise
 */
export function isTranscriptionServiceConfigured(
	service: TranscriptionProviderEntry,
): boolean {
	switch (service.location) {
		case 'cloud':
			return hasValue(deviceConfig.get(service.apiKeyConfigKey));
		case 'self-hosted':
			return (
				hasValue(deviceConfig.get(service.endpointConfigKey)) &&
				hasValue(deviceConfig.get(service.modelIdConfigKey))
			);
		case 'local':
			return hasValue(deviceConfig.get(service.modelConfigKey));
	}
}

export type TranscriptionReadiness = {
	/** True when the selected service is available here and fully configured. */
	isReady: boolean;
	/** The single most relevant blocker to show the user, or null when ready. */
	primaryIssue: string | null;
};

export function getTranscriptionReadiness(): TranscriptionReadiness {
	const service = getSelectedTranscriptionProvider();
	if (!service) {
		return { isReady: false, primaryIssue: 'Choose a transcription service.' };
	}

	if (!isTranscriptionServiceAvailable(service)) {
		return {
			isReady: false,
			primaryIssue: `${service.label} is only available in the desktop app.`,
		};
	}

	if (!isTranscriptionServiceConfigured(service)) {
		const primaryIssue = (
			{
				cloud: `Add your ${service.label} API key.`,
				'self-hosted': `Set your ${service.label} endpoint and model ID.`,
				local: `Download or select a ${service.label} model.`,
			} as const
		)[service.location];

		return { isReady: false, primaryIssue };
	}

	return { isReady: true, primaryIssue: null };
}
