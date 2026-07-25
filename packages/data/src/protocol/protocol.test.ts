/**
 * Portable Data Protocol Tests
 *
 * Verifies wire parsing, identifier grammar, admission ceilings, canonical
 * digests, and closed exchange envelopes.
 *
 * Key behaviors:
 * - Structured addresses and runtime IDs use their frozen grammar
 * - Changes and pages enforce structural and encoded-size bounds
 * - Canonical digests ignore object insertion order
 */
import { describe, expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';

import {
	batchDigest,
	type Change,
	DATA_ADDRESS_CEILINGS,
	DATA_ADMISSION_LIMITS,
	isAddress,
	isRowAddress,
	isValueAddress,
	parseChange,
	parseExchangeRequest,
	parseExchangeResponse,
	parseReplicaId,
	parseRowId,
	sha256Hex,
} from './index.js';

const ROW_ID = 'abc123def456ghi789jkl012';
const REPLICA_ID = 'rrrrrrrrrrrrrrrrrrrrrrrr';
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

describe('structured identifiers', () => {
	test('addresses require a reverse-domain namespace and legal local key', () => {
		expect(isRowAddress(ROW_ADDRESS, DATA_ADDRESS_CEILINGS)).toBe(true);
		expect(isValueAddress(VALUE_ADDRESS, DATA_ADDRESS_CEILINGS)).toBe(true);
		// A row address is not a value address and vice versa: `kind` keeps the two
		// key spaces disjoint rather than merely labelling them.
		expect(isValueAddress(ROW_ADDRESS, DATA_ADDRESS_CEILINGS)).toBe(false);
		expect(isRowAddress(VALUE_ADDRESS, DATA_ADDRESS_CEILINGS)).toBe(false);
		for (const address of [
			{ ...ROW_ADDRESS, namespace: 'single' },
			{ ...ROW_ADDRESS, namespace: 'So.epicenter.notes' },
			{ ...ROW_ADDRESS, table: 'my-notes' },
			{ ...VALUE_ADDRESS, value: '_theme' },
		]) {
			expect(isAddress(address, DATA_ADDRESS_CEILINGS)).toBe(false);
		}
	});

	test('namespace byte length stops at 128 bytes', () => {
		const exact = `a.${'c'.repeat(126)}`;
		expect(new TextEncoder().encode(exact)).toHaveLength(128);
		expect(
			isValueAddress(
				{ ...VALUE_ADDRESS, namespace: exact },
				DATA_ADDRESS_CEILINGS,
			),
		).toBe(true);
		expect(
			isValueAddress(
				{ ...VALUE_ADDRESS, namespace: `${exact}c` },
				DATA_ADDRESS_CEILINGS,
			),
		).toBe(false);
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
			{ kind: 'create', address: ROW_ADDRESS, fields: { title: 'A' } },
			{
				kind: 'update',
				address: ROW_ADDRESS,
				fields: { set: { title: 'B' }, unset: ['old'] },
			},
			{ kind: 'delete', address: ROW_ADDRESS },
			{
				kind: 'set',
				address: VALUE_ADDRESS,
				value: { dark: true },
			},
			{ kind: 'unset', address: VALUE_ADDRESS },
		];
		for (const change of changes)
			expect(expectOk(parseChange(change))).toEqual(change);
		expect(expectOk(parseChange(changes[0]))).not.toBe(changes[0]);
	});

	test('updates reject empty, duplicate, overlapping, and excessive unset keys', () => {
		const update = (unset: string[], set: Record<string, string> = {}) => ({
			kind: 'update',
			address: ROW_ADDRESS,
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
		const changes = [{ kind: 'unset', address: VALUE_ADDRESS }] as const;
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
			address: VALUE_ADDRESS,
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
	const left = [
		{ kind: 'set', address: VALUE_ADDRESS, value: { b: 2, a: 1 } },
	] as const;
	const right = [
		{ kind: 'set', address: VALUE_ADDRESS, value: { a: 1, b: 2 } },
	] as const;
	expect(batchDigest(left)).toBe(batchDigest(right));
	expect(sha256Hex('abc')).toBe(
		'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
	);
});
