import { describe, expect, test } from 'bun:test';
import {
	isAdmissibleIntent,
	isCanonicalRowId,
	RESERVED_KV_ROW_ID,
	RESERVED_KV_TABLE,
	ROW_SYNC_ADMISSION_LIMITS,
} from './admission.js';
import type { WireRowIntent } from './protocol.js';

const ROW_ID = 'abc123def456ghi789jkl012';

describe('row-id shape (ADR-0130)', () => {
	test('exactly 24 lowercase alphanumerics', () => {
		expect(isCanonicalRowId(ROW_ID)).toBeTrue();
		expect(isCanonicalRowId('abc123def456ghi789jkl01')).toBeFalse();
		expect(isCanonicalRowId(`${ROW_ID}0`)).toBeFalse();
		expect(isCanonicalRowId('ABC123DEF456GHI789JKL012')).toBeFalse();
		expect(isCanonicalRowId('abc-123def456ghi789jkl01')).toBeFalse();
	});

	test('ordinary intents require the canonical row id', () => {
		expect(
			isAdmissibleIntent({
				kind: 'create',
				table: 'notes',
				rowId: 'custom-id',
				fields: {},
			}),
		).toBeFalse();
		expect(
			isAdmissibleIntent({
				kind: 'create',
				table: 'notes',
				rowId: ROW_ID,
				fields: {},
			}),
		).toBeTrue();
	});
});

describe('reserved addresses (ADR-0132)', () => {
	test('only field-bearing updates are admissible at the KV address', () => {
		const address = { table: RESERVED_KV_TABLE, rowId: RESERVED_KV_ROW_ID };
		expect(
			isAdmissibleIntent({
				kind: 'update',
				...address,
				fields: { set: { theme: 'dark' }, unset: [] },
			}),
		).toBeTrue();
		expect(
			isAdmissibleIntent({ kind: 'create', ...address, fields: {} }),
		).toBeFalse();
		expect(isAdmissibleIntent({ kind: 'delete', ...address })).toBeFalse();
	});

	test('every other __epicenter_ table refuses application rows', () => {
		expect(
			isAdmissibleIntent({
				kind: 'update',
				table: RESERVED_KV_TABLE,
				rowId: 'other',
				fields: { set: { a: 1 }, unset: [] },
			}),
		).toBeFalse();
		expect(
			isAdmissibleIntent({
				kind: 'create',
				table: '__epicenter_anything',
				rowId: ROW_ID,
				fields: {},
			}),
		).toBeFalse();
	});
});

describe('update field changes', () => {
	const update = (fields: {
		set: Record<string, unknown>;
		unset: string[];
	}): WireRowIntent => ({
		kind: 'update',
		table: 'notes',
		rowId: ROW_ID,
		fields: fields as never,
	});

	test('an update needs at least one field change', () => {
		expect(isAdmissibleIntent(update({ set: {}, unset: [] }))).toBeFalse();
		expect(isAdmissibleIntent(update({ set: { a: 1 }, unset: [] }))).toBeTrue();
	});

	test('set and unset keys are disjoint and unset keys unique', () => {
		expect(
			isAdmissibleIntent(update({ set: { a: 1 }, unset: ['a'] })),
		).toBeFalse();
		expect(
			isAdmissibleIntent(update({ set: {}, unset: ['b', 'b'] })),
		).toBeFalse();
		expect(isAdmissibleIntent(update({ set: {}, unset: ['b'] }))).toBeTrue();
	});
});

describe('protocol constant nesting', () => {
	test('the bounds form a strictly nested chain', () => {
		const limits = ROW_SYNC_ADMISSION_LIMITS;
		expect(limits.encodedIntentBytes).toBeLessThan(limits.encodedRoundBytes);
		expect(limits.encodedRoundBytes).toBeLessThan(limits.encodedPageBytes);
	});
});
