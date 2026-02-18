/**
 * Google inference model constants
 * @see https://ai.google.dev/gemini-api/docs/models#model-variations
 */

export const GOOGLE_INFERENCE_MODELS = [
	// Gemini 3 (preview)
	'gemini-3-pro-preview',
	'gemini-3-flash-preview',

	// Gemini 2.5 (stable)
	'gemini-2.5-pro',
	'gemini-2.5-flash',
	'gemini-2.5-flash-lite',

	// Aliases (latest stable)
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
