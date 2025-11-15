/**
 * AI inference provider configurations
 */

export const INFERENCE_PROVIDERS = [
	'OpenAI',
	'Groq',
	'Anthropic',
	'Google',
	'OpenRouter',
	'Custom',
] as const;

export const INFERENCE_PROVIDER_OPTIONS = INFERENCE_PROVIDERS.map(
	(provider) => ({
		value: provider,
		label:
			provider === 'Custom'
				? 'Custom (OpenAI-compatible)'
				: provider,
	}),
);
