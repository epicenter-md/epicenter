/**
 * Google inference model constants
 * @see https://ai.google.dev/gemini-api/docs/models#model-variations
 */

export const GOOGLE_INFERENCE_MODELS = [
	'gemini-2.5-pro',
	'gemini-2.5-flash',
	'gemini-2.5-flash-lite-preview-06-17',
	'gemini-pro-latest',
	'gemini-flash-latest',
	'gemini-flash-lite-latest',
] as const;

export const GOOGLE_INFERENCE_MODEL_OPTIONS = GOOGLE_INFERENCE_MODELS.map(
	(model) => ({
		value: model,
		label: model,
	}),
);
