/**
 * Focused tests for the `POST /rooms/:room/dispatch` request body schema.
 *
 * No-input actions serialize without an `input` field, so the relay's
 * validator must accept omitted `input`. Asserting this directly on the
 * arktype schema avoids spinning up a Durable Object just to prove the
 * gate.
 */

import { expect, test } from 'bun:test';
import { type } from 'arktype';
import { dispatchRequestSchema } from './dispatch-schema';

test('dispatchRequestSchema accepts a no-input dispatch body', () => {
	const result = dispatchRequestSchema({
		from: 'installation_a',
		to: 'installation_b',
		action: 'ping',
	});
	expect(result).not.toBeInstanceOf(type.errors);
	expect(result).toEqual({
		from: 'installation_a',
		to: 'installation_b',
		action: 'ping',
	});
});

test('dispatchRequestSchema accepts a body with an explicit input', () => {
	const result = dispatchRequestSchema({
		from: 'installation_a',
		to: 'installation_b',
		action: 'echo',
		input: { hello: 'world' },
	});
	expect(result).not.toBeInstanceOf(type.errors);
});

test('dispatchRequestSchema rejects a malformed action key', () => {
	const result = dispatchRequestSchema({
		from: 'installation_a',
		to: 'installation_b',
		action: 'Bad-Action',
	});
	expect(result).toBeInstanceOf(type.errors);
});
