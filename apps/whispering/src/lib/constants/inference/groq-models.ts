/**
 * Groq inference model constants
 * @see https://console.groq.com/docs/models
 */

export const GROQ_INFERENCE_MODELS = [
	// Production models
	'llama-3.3-70b-versatile',
	'llama-3.1-8b-instant',
	'meta-llama/llama-guard-4-12b',
	'openai/gpt-oss-120b',
	'openai/gpt-oss-20b',

	// Preview models
	'meta-llama/llama-4-maverick-17b-128e-instruct',
	'meta-llama/llama-4-scout-17b-16e-instruct',
	'moonshotai/kimi-k2-instruct-0905',
	'qwen/qwen-3-32b',

	// Legacy (kept for backward compatibility with saved transformations)
	'gemma2-9b-it',
	'deepseek-r1-distill-llama-70b',
	'qwen-qwq-32b',
] as const;

export const GROQ_INFERENCE_MODEL_OPTIONS = GROQ_INFERENCE_MODELS.map(
	(model) => ({
		value: model,
		label: model,
	}),
);
