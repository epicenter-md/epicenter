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
	 * The deployment could not decide its capability-issuance admission
	 * (ADR-0137). Enrollment fails closed and retryably; synchronization
	 * and baseline scans never depend on the decision.
	 */
	EnrollmentUnavailable: () => ({
		message:
			'The storage capability decision is temporarily unavailable. Retry enrollment later.',
		status: 503 as const,
	}),
});

export type RecordsError = InferErrors<typeof RecordsError>;
