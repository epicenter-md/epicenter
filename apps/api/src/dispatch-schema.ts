import { type } from 'arktype';

/**
 * Request body schema for `POST /rooms/:room/dispatch`.
 *
 * `input` is optional: no-input actions serialize without an `input`
 * field (`JSON.stringify` drops `undefined` keys), so the validator must
 * accept its absence.
 */
export const dispatchRequestSchema = type({
	from: '/^[A-Za-z0-9_-]+$/ <= 128',
	to: '/^[A-Za-z0-9_-]+$/ <= 128',
	action: '/^[a-z][a-z0-9_]{0,63}$/',
	'input?': 'unknown',
});
