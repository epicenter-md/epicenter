import type { Result } from 'wellcrafted/result';
import type { InferenceProviderId } from '$lib/constants/inference';
import { services } from '$lib/services';
import type { DeviceConfigKey } from '$lib/state/device-config.svelte';
import { deviceConfig } from '$lib/state/device-config.svelte';
import { settings } from '$lib/state/settings.svelte';

/**
 * Config map for completion providers, all sharing the
 * `{ apiKey, model, baseUrl?, systemPrompt, userPrompt }` call signature.
 * Exhaustive over InferenceProviderId: adding a provider to INFERENCE is a
 * compile error here until its entry exists. The custom service owns the
 * "endpoint is required" invariant via its validateParams. `*ConfigKey`
 * fields hold deviceConfig key names, same convention as the transcription
 * registry in `services/transcription/providers.ts`.
 */
const COMPLETION_PROVIDERS = {
	OpenAI: {
		service: services.completions.openai,
		apiKeyConfigKey: 'providers.openai.apiKey',
		endpointConfigKey: 'providers.openai.endpoint',
	},
	Groq: {
		service: services.completions.groq,
		apiKeyConfigKey: 'providers.groq.apiKey',
		endpointConfigKey: 'providers.groq.endpoint',
	},
	Anthropic: {
		service: services.completions.anthropic,
		apiKeyConfigKey: 'providers.anthropic.apiKey',
		endpointConfigKey: null,
	},
	Google: {
		service: services.completions.google,
		apiKeyConfigKey: 'providers.google.apiKey',
		endpointConfigKey: null,
	},
	OpenRouter: {
		service: services.completions.openrouter,
		apiKeyConfigKey: 'providers.openrouter.apiKey',
		endpointConfigKey: null,
	},
	Custom: {
		service: services.completions.custom,
		apiKeyConfigKey: 'providers.custom.apiKey',
		endpointConfigKey: 'providers.custom.endpoint',
	},
} as const satisfies Record<
	InferenceProviderId,
	{
		service: {
			complete: (opts: {
				apiKey: string;
				model: string;
				systemPrompt: string;
				userPrompt: string;
				baseUrl?: string;
				signal?: AbortSignal;
			}) => Promise<Result<string, { message: string }>>;
		};
		apiKeyConfigKey: DeviceConfigKey;
		/** Device config key for the endpoint; null when not configurable. */
		endpointConfigKey: DeviceConfigKey | null;
	}
>;

/**
 * Run one completion against the single global AI default. Both the Polish pass
 * and every Recipe share this call path, so provider/model/key resolution lives
 * here once. Per ADR 0012 everything is read at use: the provider and model come
 * from `completion.*` in settings, the key and endpoint from `deviceConfig`, all
 * resolved on each call so nothing goes stale. Keys, model names, and endpoints
 * are pasted strings, so trim once: a trailing space fails the request opaquely.
 */
export function complete({
	systemPrompt,
	userPrompt,
	signal,
}: {
	systemPrompt: string;
	userPrompt: string;
	/** Aborts the in-flight request when it fires (e.g. the Polish HUD's "ship raw"). */
	signal?: AbortSignal;
}): Promise<Result<string, { message: string }>> {
	const provider = settings.get('completion.provider');
	const config = COMPLETION_PROVIDERS[provider];
	return config.service.complete({
		apiKey: deviceConfig.get(config.apiKeyConfigKey).trim(),
		model: settings.get('completion.model').trim(),
		baseUrl: config.endpointConfigKey
			? deviceConfig.get(config.endpointConfigKey).trim() || undefined
			: undefined,
		systemPrompt,
		userPrompt,
		signal,
	});
}

/**
 * Whether the currently selected completion provider has an API key configured.
 * The Polish gate ("on by default only when a key already exists") reads this so
 * the AI pass is skipped silently on a fresh, keyless install instead of failing
 * a request. Read at use, same as `complete`.
 */
export function hasCompletionKey(): boolean {
	const provider = settings.get('completion.provider');
	const config = COMPLETION_PROVIDERS[provider];
	return deviceConfig.get(config.apiKeyConfigKey).trim().length > 0;
}
