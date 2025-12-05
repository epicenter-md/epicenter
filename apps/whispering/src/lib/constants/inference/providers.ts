/**
 * AI inference provider configurations
 *
 * Rich array as the single source of truth for inference providers.
 * Contains both the ID (used for storage/validation) and label (used for display).
 */

export const INFERENCE_PROVIDERS = [
	{ id: 'OpenAI', label: 'OpenAI' },
	{ id: 'Groq', label: 'Groq' },
	{ id: 'Anthropic', label: 'Anthropic' },
	{ id: 'Google', label: 'Google' },
	{ id: 'OpenRouter', label: 'OpenRouter' },
	{ id: 'Custom', label: 'Custom (OpenAI-compatible)' },
] as const;

/** Union type of all valid inference provider IDs */
export type InferenceProviderId = (typeof INFERENCE_PROVIDERS)[number]['id'];

/** Full provider object type including id and label */
export type InferenceProvider = (typeof INFERENCE_PROVIDERS)[number];

/**
 * Array of just the provider IDs for use with arktype enumerated.
 * Explicitly declared to maintain literal tuple type.
 */
export const INFERENCE_PROVIDER_IDS = [
	'OpenAI',
	'Groq',
	'Anthropic',
	'Google',
	'OpenRouter',
	'Custom',
] as const satisfies readonly InferenceProviderId[];

/** Dropdown options derived from the provider array */
export const INFERENCE_PROVIDER_OPTIONS = INFERENCE_PROVIDERS.map((p) => ({
	value: p.id,
	label: p.label,
}));
