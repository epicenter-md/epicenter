import { INFERENCE, type InferenceProviderId } from '../constants/inference';
import { hostFromBaseUrl, isLoopbackBaseUrl } from './locality';
import type { TranscriptionLocality } from './transcription-target';

export type CompletionTarget = {
	baseUrl: string;
	apiKey: string | undefined;
};

/**
 * The single resolved completion fact set: what to call, whether Polish can run,
 * and whether transcript text leaves the machine. All three are derived together
 * from one config read so they can never disagree (a null target with `canRun`,
 * or copy that claims a different locality than the target it was resolved from).
 * The Polish gate reads `canRun`, the call path reads `target`, and the privacy
 * copy reads the whole state.
 */
export type CompletionState = {
	/**
	 * The OpenAI-compatible connection to hand `complete()`. Null only when there
	 * is no base URL to talk to (Custom with no endpoint configured), the one
	 * genuinely un-runnable state.
	 */
	target: CompletionTarget | null;
	/**
	 * Whether the selected provider can serve a request now. A configured key is
	 * capability; so is a configured endpoint override with no key, the keyless
	 * local case (Custom pointed at Ollama or LM Studio). A canonical cloud
	 * provider with no key would 401, so it is not capable.
	 */
	canRun: boolean;
	/**
	 * Whether transcript text never leaves this machine: true when the resolved
	 * base URL host is loopback, regardless of provider id or API key. This is a
	 * property of the resolved host, not the provider label, so an OpenAI or Groq
	 * base URL pointed at localhost is correctly reported as on-device.
	 */
	textStaysOnDevice: boolean;
};

export type InferenceConfigKey =
	| (typeof INFERENCE)[InferenceProviderId]['apiKeyConfigKey']
	| NonNullable<(typeof INFERENCE)[InferenceProviderId]['endpointConfigKey']>;

/**
 * The honest name for where completion text goes. Custom's label
 * ("Custom (OpenAI-compatible)") names an API shape, not a destination, so the
 * resolved host is the truthful thing to show; a canonical provider names
 * itself. This is the single resolver ADR-0101 promises: the Processing
 * readiness line and the pipeline privacy sentence both call it, so every
 * surface names the same place and they can never drift apart.
 */
function resolveTextDestination(
	provider: InferenceProviderId,
	target: CompletionTarget,
): string {
	return provider === 'Custom'
		? hostFromBaseUrl(target.baseUrl)
		: INFERENCE[provider].label;
}

type DeviceConfigReader = (key: InferenceConfigKey) => string;

export function resolveCompletionStateFromConfig({
	provider,
	getDeviceConfig,
}: {
	provider: InferenceProviderId;
	getDeviceConfig: DeviceConfigReader;
}): CompletionState {
	const { apiKeyConfigKey, endpointConfigKey, defaultBaseUrl } =
		INFERENCE[provider];
	const override = endpointConfigKey
		? getDeviceConfig(endpointConfigKey).trim()
		: '';
	const baseUrl = override || defaultBaseUrl;
	if (!baseUrl)
		return { target: null, canRun: false, textStaysOnDevice: false };
	const apiKey = getDeviceConfig(apiKeyConfigKey).trim() || undefined;
	return {
		target: { baseUrl, apiKey },
		canRun: apiKey !== undefined || override.length > 0,
		textStaysOnDevice: isLoopbackBaseUrl(baseUrl),
	};
}

/**
 * The Text-stage status the Processing surface renders for the current completion
 * provider, as one tone and one sentence. Derived from the same
 * {@link CompletionState} the call path consumes, so the surface and the pipeline
 * can never disagree about readiness or locality.
 *
 * The surface expresses two orthogonal facts through two channels, not one enum:
 * `ready` is the usability axis and drives tone (a not-ready row is a warning, a
 * ready row a neutral note), while `summary` is the prose that names the
 * destination when ready or the single missing setup step when not. Only one
 * sentence is ever shown, so where-it-goes and what-is-missing never compete.
 */
export type CompletionReadiness = {
	ready: boolean;
	summary: string;
};

export function describeCompletionReadiness(
	provider: InferenceProviderId,
	state: CompletionState,
): CompletionReadiness {
	// The only null-target provider is Custom, so the missing piece is its URL.
	if (!state.target) {
		return {
			ready: false,
			summary: 'Add a server URL below. Until then, transcripts ship raw.',
		};
	}
	if (!state.canRun) {
		return {
			ready: false,
			summary: `Add the ${INFERENCE[provider].label} API key below. Until then, transcripts ship raw.`,
		};
	}
	if (state.textStaysOnDevice) {
		return { ready: true, summary: 'Transcript text stays on this device.' };
	}
	const destination = resolveTextDestination(provider, state.target);
	return { ready: true, summary: `Transcript text is sent to ${destination}.` };
}

/**
 * The pipeline-wide privacy sentence for the home chip and Dictation page: where
 * audio goes and where Polish sends transcript text, woven into one line. Audio
 * locality is resolved upstream ({@link TranscriptionLocality}) rather than read
 * from the provider's `access` label, so an `endpoint` or localhost-overridden
 * transcription endpoint reads on-device here exactly as it does on the
 * Processing surface.
 */
export function describePolishDestination(
	audio: TranscriptionLocality,
	completionProvider: InferenceProviderId,
	state: CompletionState,
): string {
	if (!state.target || !state.canRun) {
		if (audio.onDevice) {
			return 'Audio stays on this device. Polish is not ready, so transcripts ship raw.';
		}
		return `Audio is sent to ${audio.name}. Polish is not ready, so transcripts ship raw.`;
	}

	const { textStaysOnDevice } = state;

	if (audio.onDevice && textStaysOnDevice) {
		return 'Audio and transcript text both stay on this device.';
	}

	// Text leaves this device below; name where it goes through the shared
	// resolver so this sentence and the Processing surface never disagree.
	const textDestination = resolveTextDestination(
		completionProvider,
		state.target,
	);

	if (audio.onDevice) {
		return `Audio is transcribed on-device, but Polish sends transcript text to ${textDestination}.`;
	}

	if (textStaysOnDevice) {
		return `Audio is sent to ${audio.name}, then Polish keeps transcript text on this device.`;
	}

	return `Audio is sent to ${audio.name}, and Polish sends transcript text to ${textDestination}.`;
}
