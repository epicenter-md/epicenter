/**
 * Contract test for cumulative destructive-poll observation capture.
 */
import { expect, test } from 'bun:test';

import { createObservationAccumulator } from './observations.js';

test('observation accumulator retains split polling batches and duplicates', () => {
	const observations = createObservationAccumulator();
	expect(observations.append(['a'])).toEqual(['a']);
	expect(observations.append([])).toEqual(['a']);
	expect(observations.append(['b', 'a'])).toEqual(['a', 'b', 'a']);
});
