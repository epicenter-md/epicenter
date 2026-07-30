export const INFERENCE_PROVIDER_IDS = [
	'OpenAI',
	'Groq',
	'Anthropic',
	'Google',
	'OpenRouter',
	'Custom',
] as const;

export type InferenceProviderId = (typeof INFERENCE_PROVIDER_IDS)[number];
