/**
 * The floor is the part two media could come to disagree about.
 *
 * `document-authority.test.ts` already drives `shouldFold` through the
 * authority with an injected floor. What is pinned here is the rule itself,
 * because a second caller is about to exist on the other side of the wire and
 * "the tail outgrew the state" is not the whole rule.
 */
import { describe, expect, test } from 'bun:test';
import { FOLD_FLOOR_BYTES, shouldFold } from './fold.js';

describe('shouldFold', () => {
	test('a tail under the floor is never worth folding, however lopsided', () => {
		expect(shouldFold(1, 1_000)).toBe(false);
	});

	test('over the floor, the tail must actually have outgrown the state', () => {
		expect(shouldFold(FOLD_FLOOR_BYTES * 2, FOLD_FLOOR_BYTES + 1)).toBe(false);
		expect(shouldFold(FOLD_FLOOR_BYTES, FOLD_FLOOR_BYTES + 1)).toBe(true);
	});

	test('an empty record is not a fold, which is what a first open sees', () => {
		expect(shouldFold(0, 0)).toBe(false);
	});
});
