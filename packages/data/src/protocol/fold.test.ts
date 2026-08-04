/**
 * Scalar Fold Tests
 *
 * Exercises every transition in the deterministic latest-state fold.
 *
 * Key behaviors:
 * - Row deletion is terminal
 * - Row updates apply set before unset
 * - Value unset is nonterminal
 */
import { describe, expect, test } from 'bun:test';

import {
	DATA_ADMISSION_LIMITS,
	type Fact,
	foldIntent,
	type Intent,
	type JsonObject,
} from './index.js';

const ROW_ID = 'abc123def456ghi789jkl012';
const ROW_ADDRESS = {
	namespace: 'so.epicenter.notes',
	tableName: 'rows',
	rowId: ROW_ID,
} as const;
const row = (
	fields: JsonObject = { title: 'A' },
	authoritySequence = 1,
): Fact => ({
	presence: 'present',
	address: ROW_ADDRESS,
	authoritySequence,
	fields,
});
const deleted = (): Fact => ({
	presence: 'absent',
	address: ROW_ADDRESS,
	authoritySequence: 2,
});

describe('row fold', () => {
	const cases: Array<{
		name: string;
		current: Fact | undefined;
		change: Intent;
		expected: 'applied' | 'noop';
	}> = [
		{
			// A patch at an address with no fact creates the row. This is what
			// replaced the old `create` verb: the authority already knows whether
			// the row exists, so the replica never has to claim it.
			name: 'patch where no fact exists creates the row',
			current: undefined,
			change: {
				verb: 'patch',
				address: ROW_ADDRESS,
				set: { title: 'A' },
				unset: [],
			},
			expected: 'applied',
		},
		{
			name: 'patch at a live row merges over it',
			current: row(),
			change: {
				verb: 'patch',
				address: ROW_ADDRESS,
				set: { x: 1 },
				unset: [],
			},
			expected: 'applied',
		},
		{
			// The whole terminal-tombstone law. Nothing resurrects a deleted row,
			// so a patch that lost the race to a concurrent delete stays lost.
			name: 'patch at a tombstone is refused forever',
			current: deleted(),
			change: {
				verb: 'patch',
				address: ROW_ADDRESS,
				set: { x: 1 },
				unset: [],
			},
			expected: 'noop',
		},
		{
			name: 'delete at live applies',
			current: row(),
			change: { verb: 'delete', address: ROW_ADDRESS },
			expected: 'applied',
		},
		{
			name: 'delete at absence is a no-op',
			current: undefined,
			change: { verb: 'delete', address: ROW_ADDRESS },
			expected: 'noop',
		},
		{
			name: 'delete at tombstone is a no-op',
			current: deleted(),
			change: { verb: 'delete', address: ROW_ADDRESS },
			expected: 'noop',
		},
	];
	for (const entry of cases) {
		test(entry.name, () =>
			expect(foldIntent(entry.current, entry.change, 9).kind).toBe(
				entry.expected,
			),
		);
	}

	test('update applies set then unset and receives the next sequence', () => {
		const folded = foldIntent(
			row({ title: 'A', keep: true }),
			{
				verb: 'patch',
				address: ROW_ADDRESS,
				set: { title: 'B', remove: 'set-first' },
				unset: ['remove'],
			},
			9,
		);
		expect(folded).toEqual({
			kind: 'applied',
			fact: {
				presence: 'present',
				address: ROW_ADDRESS,
				authoritySequence: 9,
				fields: { title: 'B', keep: true },
			},
		});
	});

	test('a composed row above the record capacity is a no-op', () => {
		const folded = foldIntent(
			row(),
			{
				verb: 'patch',
				address: ROW_ADDRESS,
				set: { huge: 'x'.repeat(DATA_ADMISSION_LIMITS.encodedFactBytes) },
				unset: [],
			},
			9,
		);
		expect(folded.kind).toBe('noop');
	});
});
