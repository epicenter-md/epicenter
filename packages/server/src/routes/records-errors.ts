import { defineErrors, type InferErrors } from 'wellcrafted/error';

export const RecordsError = defineErrors({
	InvalidRequest: () => ({
		message: 'The record synchronization request is invalid.',
		status: 400 as const,
	}),
	RequestTooLarge: () => ({
		message: 'The record synchronization request is too large.',
		status: 413 as const,
	}),
});

export type RecordsError = InferErrors<typeof RecordsError>;
