/**
 * Anthropic inference model constants
 * @see https://docs.anthropic.com/en/docs/about-claude/models/overview#model-aliases
 */

export const ANTHROPIC_INFERENCE_MODELS = [
	// Claude 4.5 models (latest generation - recommended)
	'claude-sonnet-4-5-20250929',
	'claude-sonnet-4-5', // alias for latest Sonnet 4.5
	'claude-haiku-4-5-20251001',
	'claude-haiku-4-5', // alias for latest Haiku 4.5
	'claude-opus-4-1-20250805',
	'claude-opus-4-1', // alias for latest Opus 4.1

	// Claude 4 models (legacy but still available)
	'claude-sonnet-4-20250514',
	'claude-sonnet-4-0', // alias
	'claude-opus-4-20250514',
	'claude-opus-4-0', // alias

	// Claude 3.7 models (legacy)
	'claude-3-7-sonnet-20250219',
	'claude-3-7-sonnet-latest', // alias

	// Claude 3.5 models (legacy)
	'claude-3-5-haiku-20241022',
	'claude-3-5-haiku-latest', // alias

	// Claude 3 models (legacy)
	'claude-3-haiku-20240307',
] as const;

export const ANTHROPIC_INFERENCE_MODEL_OPTIONS = ANTHROPIC_INFERENCE_MODELS.map(
	(model) => ({
		value: model,
		label: model,
	}),
);
