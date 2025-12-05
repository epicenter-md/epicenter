/**
 * Database transformation type constants
 */

export const TRANSFORMATION_STEP_TYPES = [
	'prompt_transform',
	'find_replace',
] as const;

export const TRANSFORMATION_STEP_TYPES_TO_LABEL = {
	prompt_transform: 'Prompt Transform',
	find_replace: 'Find Replace',
} as const satisfies Record<(typeof TRANSFORMATION_STEP_TYPES)[number], string>;

export const TRANSFORMATION_STEP_TYPE_OPTIONS = TRANSFORMATION_STEP_TYPES.map(
	(type) => ({
		value: type,
		label: TRANSFORMATION_STEP_TYPES_TO_LABEL[type],
	}),
);
