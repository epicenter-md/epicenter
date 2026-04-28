/**
 * Single source of truth for inference providers and their models.
 *
 * Access patterns:
 * - Provider IDs:  `keyof typeof INFERENCE` → 'OpenAI' | 'Groq' | ...
 * - Models:        `INFERENCE.OpenAI.models` → readonly ['gpt-5', ...]
 * - Labels:        `INFERENCE.OpenAI.label` → 'OpenAI'
 * - Enumerate:     `Object.keys(INFERENCE)` / `Object.entries(INFERENCE)`
 * - Schema:        `type.enumerated(...INFERENCE.OpenAI.models)`
 */
export const INFERENCE = {
	OpenAI: {
		label: 'OpenAI',
		models: [
			'gpt-5',
			'gpt-5-mini',
			'gpt-4.1',
			'gpt-4.1-mini',
			'gpt-4.1-nano',
			'gpt-4o',
			'gpt-4o-mini',
			'o3',
			'o3-pro',
			'o3-mini',
			'o4-mini',
		],
	},
	Groq: {
		label: 'Groq',
		models: [
			// Production models
			'gemma2-9b-it',
			'meta-llama/llama-guard-4-12b',
			'llama-3.3-70b-versatile',
			'llama-3.1-8b-instant',
			// Preview models
			'deepseek-r1-distill-llama-70b',
			'meta-llama/llama-4-maverick-17b-128e-instruct',
			'meta-llama/llama-4-scout-17b-16e-instruct',
			'meta-llama/llama-prompt-guard-2-22m',
			'meta-llama/llama-prompt-guard-2-86m',
			'mistral-saba-24b',
			'qwen-qwq-32b',
			'qwen/qwen3-32b',
		],
	},
	Anthropic: {
		label: 'Anthropic',
		models: [
			// Claude 4.7 models (latest generation - recommended)
			'claude-opus-4-7',
			// Claude 4.6 models
			'claude-sonnet-4-6',
			'claude-opus-4-6',
			// Claude 4.5 models
			'claude-opus-4-5-20251101',
			'claude-opus-4-5',
			'claude-sonnet-4-5-20250929',
			'claude-sonnet-4-5',
			'claude-haiku-4-5-20251001',
			'claude-haiku-4-5',
			'claude-opus-4-1-20250805',
			'claude-opus-4-1',
			// Claude 4 models (legacy but still available)
			'claude-sonnet-4-20250514',
			'claude-sonnet-4-0',
			'claude-opus-4-20250514',
			'claude-opus-4-0',
			// Claude 3 models (legacy)
			'claude-3-haiku-20240307',
		],
	},
	Google: {
		label: 'Google',
		models: [
			'gemini-2.5-pro',
			'gemini-2.5-flash',
			'gemini-2.5-flash-lite-preview-06-17',
			'gemini-pro-latest',
			'gemini-flash-latest',
			'gemini-flash-lite-latest',
		],
	},
	OpenRouter: {
		label: 'OpenRouter',
		models: null,
	},
	Custom: {
		label: 'Custom (OpenAI-compatible)',
		models: null,
	},
} as const;

export type InferenceProviderId = keyof typeof INFERENCE;

/** Convenience array for `type.enumerated(...INFERENCE_PROVIDER_IDS)` in schemas. */
export const INFERENCE_PROVIDER_IDS = Object.keys(
	INFERENCE,
) as InferenceProviderId[];

/** UI dropdown options for provider selection. */
export const INFERENCE_PROVIDER_OPTIONS = INFERENCE_PROVIDER_IDS.map((id) => ({
	value: id,
	label: INFERENCE[id].label,
}));
