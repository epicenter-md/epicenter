/**
 * Provisional V1 limits tests.
 *
 * Proves the checked product constants pass the protocol's derived response
 * capacity rules before any authority or transport consumes them.
 */
import { expect, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';

import { V1_LIMITS, validateLimits } from './index.js';

test('provisional V1 limits satisfy the response inequalities', () => {
	const validated = expectOk(validateLimits(V1_LIMITS));
	expect(validated.maxFactsResponseBytes).toBe(8 * 1024 ** 2);
	expect(validated.maxSubmissionResponseBytes).toBe(8 * 1024 ** 2);
});
