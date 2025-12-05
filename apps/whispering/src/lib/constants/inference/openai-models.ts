/**
 * OpenAI inference model constants
 * @see https://platform.openai.com/docs/models
 * @see https://platform.openai.com/docs/api-reference/models/list
 */

export const OPENAI_INFERENCE_MODELS = [
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
] as const;

export const OPENAI_INFERENCE_MODEL_OPTIONS = OPENAI_INFERENCE_MODELS.map(
	(model) => ({
		value: model,
		label: model,
	}),
);
