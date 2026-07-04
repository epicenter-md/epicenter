import {
	PROVIDERS,
	type TranscriptionServiceId,
} from '../services/transcription/providers';
import type { DeviceConfigKey } from '../state/device-config.svelte';
import { isLoopbackBaseUrl } from './locality';

/**
 * Where audio goes for the current transcription service: whether it stays on
 * this device and one sentence naming the destination. The Audio twin of
 * {@link describeCompletionReadiness}, resolved from the same config the
 * transcribe call path reads so the surface and the pipeline can never disagree.
 *
 * Locality follows the resolved endpoint host, not the provider's `access`
 * label: an `endpoint` (Speaches) or `key` provider pointed at loopback keeps
 * audio on-device, exactly like a Custom completion at localhost. That is why
 * `endpoint` is not its own locality here; where the bytes go is a property of
 * the host, and who operates the server is the user's trust call, not a fact this
 * copy can assert.
 */
export type TranscriptionDestination = { onDevice: boolean; summary: string };

/**
 * The resolved audio-locality facts: whether audio stays on this device and the
 * name used for it when it leaves ("OpenAI", or "your Speaches server"). The one
 * source of audio locality, consumed both by the Processing Audio line (via
 * {@link describeTranscriptionDestinationFromConfig}) and by the pipeline sentence
 * on the home chip and Dictation page (via `describePolishDestination`), so every
 * surface agrees on where audio goes.
 */
export type TranscriptionLocality = { onDevice: boolean; name: string };

/**
 * The string-valued endpoint keys this resolver reads. Narrowing to the
 * `providers.*.endpoint` subset (all strings) lets `deviceConfig.get` pass
 * directly, the same shape completion's `InferenceConfigKey` uses.
 */
type TranscriptionEndpointKey = Extract<
	DeviceConfigKey,
	`providers.${string}.endpoint`
>;

export function resolveTranscriptionLocalityFromConfig({
	service,
	getDeviceConfig,
}: {
	service: TranscriptionServiceId;
	getDeviceConfig: (key: TranscriptionEndpointKey) => string;
}): TranscriptionLocality {
	const provider = PROVIDERS[service];
	// Local transcription runs in-process; audio never becomes a network request.
	if (provider.access === 'onDevice') {
		return { onDevice: true, name: provider.label };
	}
	// `key` and `endpoint` providers upload audio to an endpoint. A configured
	// loopback endpoint keeps it on-device regardless of the provider label. The
	// provider type declares `endpointConfigKey` as the wide `DeviceConfigKey`,
	// but every real value is a `providers.*.endpoint` key.
	let endpoint = '';
	if (
		(provider.access === 'key' || provider.access === 'endpoint') &&
		provider.endpointConfigKey
	) {
		endpoint = getDeviceConfig(
			provider.endpointConfigKey as TranscriptionEndpointKey,
		).trim();
	}
	if (endpoint && isLoopbackBaseUrl(endpoint)) {
		return { onDevice: true, name: provider.label };
	}
	// A remote `endpoint` server is the user's own box, not a cloud vendor.
	if (provider.access === 'endpoint') {
		return { onDevice: false, name: `your ${provider.label} server` };
	}
	return { onDevice: false, name: provider.label };
}

export function describeTranscriptionDestinationFromConfig(args: {
	service: TranscriptionServiceId;
	getDeviceConfig: (key: TranscriptionEndpointKey) => string;
}): TranscriptionDestination {
	const { onDevice, name } = resolveTranscriptionLocalityFromConfig(args);
	if (onDevice) return { onDevice, summary: 'Audio stays on this device.' };
	return { onDevice, summary: `Audio is sent to ${name}.` };
}
