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
	DatabaseBindingMismatch: ({
		reason,
	}: {
		reason: 'protocol-mismatch' | 'records-schema-mismatch';
	}) => ({
		message:
			reason === 'protocol-mismatch'
				? 'The record synchronization protocol is incompatible.'
				: 'The workspace schema does not match the authoritative database.',
		status: 409 as const,
		reason,
	}),
});

export type RecordsError = InferErrors<typeof RecordsError>;
