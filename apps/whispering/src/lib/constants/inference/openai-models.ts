/**
 * OpenAI inference model constants
 * @see https://platform.openai.com/docs/models
 * @see https://platform.openai.com/docs/api-reference/models/list
 */

export const OPENAI_INFERENCE_MODELS = [
	// GPT-5.x series (latest generation)
	'gpt-5.2',
	'gpt-5.1',
	'gpt-5',
	'gpt-5-mini',

	// GPT-4.1 series (non-reasoning)
	'gpt-4.1',
	'gpt-4.1-mini',
	'gpt-4.1-nano',

	// o-series reasoning models
	'o3',
	'o3-pro',
	'o3-mini',
	'o4-mini',

	// Legacy (being retired)
	'gpt-4o',
	'gpt-4o-mini',
] as const;

export const OPENAI_INFERENCE_MODEL_OPTIONS = OPENAI_INFERENCE_MODELS.map(
	(model) => ({
		value: model,
		label: model,
	}),
);
