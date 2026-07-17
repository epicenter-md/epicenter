import { describe, expect, test } from 'bun:test';
import {
	base64DecodedBytes,
	isAdmissibleIntent,
	isCanonicalRowId,
	RESERVED_KV_ROW_ID,
	RESERVED_KV_TABLE,
	ROW_SYNC_ADMISSION_LIMITS,
	roundRequestsGrowth,
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
		expect(
			isAdmissibleIntent({
				kind: 'update',
				...address,
				fields: { set: { theme: 'dark' }, unset: [] },
				documentUpdate: 'AAAA',
			}),
		).toBeFalse();
		expect(
			isAdmissibleIntent({
				kind: 'update',
				...address,
				documentUpdate: 'AAAA',
			}),
		).toBeFalse();
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
	const update = (
		fields?: { set: Record<string, unknown>; unset: string[] },
		documentUpdate?: string,
	): WireRowIntent => ({
		kind: 'update',
		table: 'notes',
		rowId: ROW_ID,
		...(fields === undefined ? {} : { fields: fields as never }),
		...(documentUpdate === undefined ? {} : { documentUpdate }),
	});

	test('an update needs field changes, a document update, or both', () => {
		expect(isAdmissibleIntent(update())).toBeFalse();
		expect(isAdmissibleIntent(update({ set: {}, unset: [] }))).toBeFalse();
		expect(isAdmissibleIntent(update({ set: { a: 1 }, unset: [] }))).toBeTrue();
		expect(isAdmissibleIntent(update(undefined, 'AAAA'))).toBeTrue();
		expect(
			isAdmissibleIntent(update({ set: { a: 1 }, unset: [] }, 'AAAA')),
		).toBeTrue();
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

	test('document updates must be decodable base64 within the component cap', () => {
		expect(isAdmissibleIntent(update(undefined, 'not base64!'))).toBeFalse();
		expect(isAdmissibleIntent(update(undefined, 'AAA'))).toBeFalse();
		const overCap = 'A'.repeat(
			Math.ceil((ROW_SYNC_ADMISSION_LIMITS.documentComponentBytes + 3) / 3) * 4,
		);
		expect(isAdmissibleIntent(update(undefined, overCap))).toBeFalse();
	});
});

describe('delete-only growth classification (ADR-0137)', () => {
	const deletion: WireRowIntent = {
		kind: 'delete',
		table: 'notes',
		rowId: ROW_ID,
	};
	const growth: WireRowIntent = {
		kind: 'update',
		table: 'notes',
		rowId: ROW_ID,
		fields: { set: { a: 1 }, unset: [] },
	};

	test('classification is syntactic: only all-delete rounds are non-growing', () => {
		expect(roundRequestsGrowth([deletion, deletion])).toBeFalse();
		expect(roundRequestsGrowth([deletion, growth])).toBeTrue();
		expect(roundRequestsGrowth([growth])).toBeTrue();
	});
});

describe('protocol constant nesting (ADR-0131)', () => {
	test('the bounds form a strictly nested chain', () => {
		const limits = ROW_SYNC_ADMISSION_LIMITS;
		expect(limits.canonicalDocumentBytes).toBeLessThan(
			limits.documentComponentBytes,
		);
		// A maximum document component must survive base64 inflation inside
		// one encoded intent.
		const componentAsBase64 = Math.ceil(limits.documentComponentBytes / 3) * 4;
		expect(componentAsBase64).toBeLessThan(limits.encodedIntentBytes);
		expect(limits.encodedIntentBytes).toBeLessThan(limits.encodedRoundBytes);
		expect(limits.encodedRoundBytes).toBeLessThan(limits.encodedPageBytes);
	});

	test('base64DecodedBytes matches real payload lengths', () => {
		expect(base64DecodedBytes('AAAA')).toBe(3);
		expect(base64DecodedBytes('AAA=')).toBe(2);
		expect(base64DecodedBytes('AA==')).toBe(1);
	});
});
