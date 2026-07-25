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
	type Change,
	DATA_ADMISSION_LIMITS,
	foldChange,
	type JsonObject,
	type Record as SyncRecord,
} from './index.js';

const ROW_ID = 'abc123def456ghi789jkl012';
const ROW_ADDRESS = {
	kind: 'row',
	namespace: 'so.epicenter.notes',
	table: 'rows',
	rowId: ROW_ID,
} as const;
const VALUE_ADDRESS = {
	kind: 'value',
	namespace: 'so.epicenter.settings',
	value: 'theme',
} as const;
const row = (
	fields: JsonObject = { title: 'A' },
	changedSequence = 1,
): SyncRecord => ({
	kind: 'row',
	address: ROW_ADDRESS,
	changedSequence,
	fields,
});
const deleted = (): SyncRecord => ({
	kind: 'row-deleted',
	address: ROW_ADDRESS,
	changedSequence: 2,
});
const value = (): SyncRecord => ({
	kind: 'value',
	address: VALUE_ADDRESS,
	changedSequence: 1,
	value: 'dark',
});
const unset = (): SyncRecord => ({
	kind: 'value-unset',
	address: VALUE_ADDRESS,
	changedSequence: 2,
});

describe('row fold', () => {
	const cases: Array<{
		name: string;
		current: SyncRecord | undefined;
		change: Change;
		expected: 'applied' | 'noop';
	}> = [
		{
			name: 'create at absence applies',
			current: undefined,
			change: {
				kind: 'create',
				address: ROW_ADDRESS,
				fields: { title: 'A' },
			},
			expected: 'applied',
		},
		{
			name: 'create at live is a no-op',
			current: row(),
			change: { kind: 'create', address: ROW_ADDRESS, fields: {} },
			expected: 'noop',
		},
		{
			name: 'create at tombstone is a no-op',
			current: deleted(),
			change: { kind: 'create', address: ROW_ADDRESS, fields: {} },
			expected: 'noop',
		},
		{
			name: 'update at absence is a no-op',
			current: undefined,
			change: {
				kind: 'update',
				address: ROW_ADDRESS,
				fields: { set: { x: 1 }, unset: [] },
			},
			expected: 'noop',
		},
		{
			name: 'update at tombstone is a no-op',
			current: deleted(),
			change: {
				kind: 'update',
				address: ROW_ADDRESS,
				fields: { set: { x: 1 }, unset: [] },
			},
			expected: 'noop',
		},
		{
			name: 'delete at live applies',
			current: row(),
			change: { kind: 'delete', address: ROW_ADDRESS },
			expected: 'applied',
		},
		{
			name: 'delete at absence is a no-op',
			current: undefined,
			change: { kind: 'delete', address: ROW_ADDRESS },
			expected: 'noop',
		},
		{
			name: 'delete at tombstone is a no-op',
			current: deleted(),
			change: { kind: 'delete', address: ROW_ADDRESS },
			expected: 'noop',
		},
	];
	for (const entry of cases) {
		test(entry.name, () =>
			expect(foldChange(entry.current, entry.change, 9).kind).toBe(
				entry.expected,
			),
		);
	}

	test('update applies set then unset and receives the next sequence', () => {
		const folded = foldChange(
			row({ title: 'A', keep: true }),
			{
				kind: 'update',
				address: ROW_ADDRESS,
				fields: { set: { title: 'B', remove: 'set-first' }, unset: ['remove'] },
			},
			9,
		);
		expect(folded).toEqual({
			kind: 'applied',
			record: {
				kind: 'row',
				address: ROW_ADDRESS,
				changedSequence: 9,
				fields: { title: 'B', keep: true },
			},
		});
	});

	test('a composed row above the record capacity is a no-op', () => {
		const folded = foldChange(
			row(),
			{
				kind: 'update',
				address: ROW_ADDRESS,
				fields: {
					set: { huge: 'x'.repeat(DATA_ADMISSION_LIMITS.encodedRecordBytes) },
					unset: [],
				},
			},
			9,
		);
		expect(folded.kind).toBe('noop');
	});
});

describe('value fold', () => {
	test('set always replaces absence, live, or unset', () => {
		for (const current of [undefined, value(), unset()]) {
			expect(
				foldChange(
					current,
					{ kind: 'set', address: VALUE_ADDRESS, value: 'light' },
					7,
				),
			).toEqual({
				kind: 'applied',
				record: {
					kind: 'value',
					address: VALUE_ADDRESS,
					changedSequence: 7,
					value: 'light',
				},
			});
		}
	});

	test('unset applies only at live and a later set revives it', () => {
		const removed = foldChange(
			value(),
			{ kind: 'unset', address: VALUE_ADDRESS },
			2,
		);
		expect(removed).toEqual({ kind: 'applied', record: unset() });
		expect(
			foldChange(undefined, { kind: 'unset', address: VALUE_ADDRESS }, 3).kind,
		).toBe('noop');
		expect(
			foldChange(unset(), { kind: 'unset', address: VALUE_ADDRESS }, 3).kind,
		).toBe('noop');
		expect(
			foldChange(
				unset(),
				{ kind: 'set', address: VALUE_ADDRESS, value: 'again' },
				3,
			).kind,
		).toBe('applied');
	});
});
