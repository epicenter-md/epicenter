/**
 * Current-State Transport Compaction Tests
 *
 * Verifies the predictable post-acceptance maintenance boundary.
 *
 * Key behaviors:
 * - the retained window derives one exact requested floor from the receipt
 * - maintenance failure is logged without changing push success
 */

import { expect, test } from 'bun:test';
import type { Logger } from 'wellcrafted/logger';
import {
	CURRENT_STATE_RETENTION_WINDOW,
	runCurrentStateTransportCompaction,
} from './current-state-compaction.js';

function setupLogger() {
	const warnings: unknown[] = [];
	const logger = {
		error(): void {},
		warn(value: unknown): void {
			warnings.push(value);
		},
		info(): void {},
		debug(): void {},
		trace(): void {},
	} satisfies Logger;
	return { logger, warnings };
}

test('receipt applied-through selects the exact retained-window floor', () => {
	const requested: number[] = [];
	runCurrentStateTransportCompaction(
		(floor) => {
			requested.push(floor);
			return floor;
		},
		{
			acceptedRound: 2,
			requestDigest: 'digest',
			appliedThrough: CURRENT_STATE_RETENTION_WINDOW + 37,
		},
	);
	expect(requested).toEqual([37]);
});

test('maintenance failure logs without escaping the push boundary', () => {
	const { logger, warnings } = setupLogger();
	expect(() =>
		runCurrentStateTransportCompaction(
			() => {
				throw new Error('injected maintenance failure');
			},
			{
				acceptedRound: 1,
				requestDigest: 'digest',
				appliedThrough: 1,
			},
			logger,
		),
	).not.toThrow();
	expect(warnings).toHaveLength(1);
});
