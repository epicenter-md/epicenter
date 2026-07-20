/**
 * Portable Data Protocol Tests
 *
 * Verifies wire parsing, identifier grammar, admission ceilings, canonical
 * digests, and closed exchange envelopes.
 *
 * Key behaviors:
 * - Qualified keys and runtime IDs use their frozen grammar
 * - Changes and pages enforce structural and encoded-size bounds
 * - Canonical digests ignore object insertion order
 */
import { describe, expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';

import {
	batchDigest,
	type Change,
	DATA_ADMISSION_LIMITS,
	parseChange,
	parseExchangeRequest,
	parseExchangeResponse,
	parseQualifiedKey,
	parseReplicaId,
	parseRowId,
	sha256Hex,
} from './index.js';

const ROW_ID = 'abc123def456ghi789jkl012';
const REPLICA_ID = 'rrrrrrrrrrrrrrrrrrrrrrrr';
const KEY = 'so.epicenter.notes.rows';

describe('qualified identifiers', () => {
	test('qualified keys require three lowercase dot-separated labels', () => {
		for (const key of [KEY, 'a.b.c', 'so.epicenter.my-notes']) {
			expect(expectOk(parseQualifiedKey(key))).toBe(key);
		}
		for (const key of [
			'a.b',
			'.a.b.c',
			'a.-b.c',
			'a.b-.c',
			'A.b.c',
			'a..b.c',
		]) {
			expect(expectErr(parseQualifiedKey(key)).name).toBe('Invalid');
		}
	});

	test('qualified key byte length stops at 128 bytes', () => {
		const exact = `a.b.${'c'.repeat(124)}`;
		expect(new TextEncoder().encode(exact)).toHaveLength(128);
		expect(expectOk(parseQualifiedKey(exact))).toBe(exact);
		expect(expectErr(parseQualifiedKey(`${exact}c`)).name).toBe('Invalid');
	});

	test('row and replica IDs require exactly 24 lowercase alphanumerics', () => {
		expect(expectOk(parseRowId(ROW_ID))).toBe(ROW_ID);
		expect(expectOk(parseReplicaId(REPLICA_ID))).toBe(REPLICA_ID);
		for (const value of [
			'short',
			`${ROW_ID}x`,
			ROW_ID.toUpperCase(),
			'abc-23def456ghi789jkl012',
		]) {
			expect(expectErr(parseRowId(value)).name).toBe('Invalid');
		}
	});
});

describe('change and exchange admission', () => {
	test('all five change variants parse and inputs are cloned', () => {
		const changes: Change[] = [
			{ kind: 'create', key: KEY, rowId: ROW_ID, fields: { title: 'A' } },
			{
				kind: 'update',
				key: KEY,
				rowId: ROW_ID,
				fields: { set: { title: 'B' }, unset: ['old'] },
			},
			{ kind: 'delete', key: KEY, rowId: ROW_ID },
			{
				kind: 'set',
				key: 'so.epicenter.settings.theme',
				value: { dark: true },
			},
			{ kind: 'unset', key: 'so.epicenter.settings.theme' },
		];
		for (const change of changes)
			expect(expectOk(parseChange(change))).toEqual(change);
		expect(expectOk(parseChange(changes[0]))).not.toBe(changes[0]);
	});

	test('updates reject empty, duplicate, overlapping, and excessive unset keys', () => {
		const update = (unset: string[], set: Record<string, string> = {}) => ({
			kind: 'update',
			key: KEY,
			rowId: ROW_ID,
			fields: { set, unset },
		});
		for (const change of [
			update([]),
			update(['x', 'x']),
			update(['x'], { x: 'overlap' }),
			update(
				Array.from(
					{ length: DATA_ADMISSION_LIMITS.unsetKeysPerChange + 1 },
					(_, index) => `x${index}`,
				),
			),
		]) {
			expect(expectErr(parseChange(change)).name).toBe('Invalid');
		}
	});

	test('exchange request binds a bounded batch and forbids batches on continuation pages', () => {
		const changes = [
			{ kind: 'unset', key: 'so.epicenter.settings.theme' },
		] as const;
		const batch = { seq: 1, digest: batchDigest(changes), changes };
		expect(
			expectOk(
				parseExchangeRequest({ replicaId: REPLICA_ID, after: 0, batch }),
			),
		).toMatchObject({ batch });
		expect(
			expectErr(
				parseExchangeRequest({
					replicaId: REPLICA_ID,
					after: 0,
					batch,
					cursor: { through: 2, position: 1 },
				}),
			).name,
		).toBe('Invalid');
	});

	test('exchange responses reject records beyond fixed through and moving cursors', () => {
		const record = {
			kind: 'value',
			key: 'so.epicenter.settings.theme',
			changedSequence: 2,
			value: 'dark',
		} as const;
		expect(
			expectOk(
				parseExchangeResponse({ through: 2, records: [record], next: null }),
			),
		).toMatchObject({ records: [record] });
		for (const response of [
			{ through: 1, records: [record], next: null },
			{ through: 2, records: [record], next: { through: 3, position: 2 } },
		]) {
			expect(expectErr(parseExchangeResponse(response)).name).toBe('Invalid');
		}
	});
});

test('canonical batch digest and SHA-256 are deterministic', () => {
	const left = [{ kind: 'set', key: KEY, value: { b: 2, a: 1 } }] as const;
	const right = [{ kind: 'set', key: KEY, value: { a: 1, b: 2 } }] as const;
	expect(batchDigest(left)).toBe(batchDigest(right));
	expect(sha256Hex('abc')).toBe(
		'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
	);
});
