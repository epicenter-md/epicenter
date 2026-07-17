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
	/**
	 * The deployment could not load its storage growth decision (ADR-0137).
	 * Only growth fails, and it fails closed and retryably; reads and
	 * deletions never depend on the projection.
	 */
	GrowthUnavailable: () => ({
		message:
			'The storage capacity decision is temporarily unavailable. Retry this change later.',
		status: 503 as const,
	}),
});

export type RecordsError = InferErrors<typeof RecordsError>;
