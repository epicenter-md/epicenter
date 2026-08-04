import { describe, expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { addressesEqual, addressKey, parseAddress, type RowAddress } from './index.js';
import { makeLimits } from './kernel.test-support.js';

const LIMITS = makeLimits();
const ROW: RowAddress = {
	namespace: 'so.epicenter.notes', tableName: 'recordings', rowId: 'App.1_row',
};

describe('row addresses', () => {
	test('identity uses all three coordinates', () => {
		expect(addressesEqual(ROW, { ...ROW })).toBe(true);
		expect(addressesEqual(ROW, { ...ROW, rowId: 'other' })).toBe(false);
		expect(addressKey(ROW)).toBe(addressKey({ rowId: ROW.rowId, tableName: ROW.tableName, namespace: ROW.namespace }));
	});
	test('admits the row id grammar and rejects malformed shapes', () => {
		expect(expectOk(parseAddress(ROW, LIMITS))).toEqual(ROW);
		expectErr(parseAddress({ ...ROW, rowId: '.hidden' }, LIMITS));
		expectErr(parseAddress({ ...ROW, rowId: 'bad space' }, LIMITS));
		expectErr(parseAddress({ ...ROW, extra: 1 }, LIMITS));
	});
});
