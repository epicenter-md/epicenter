import { describe, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { parseFact, parseIntent, type RowAddress } from './index.js';
import { makeLimits } from './kernel.test-support.js';

const LIMITS = makeLimits();
const ADDRESS: RowAddress = { namespace: 'so.epicenter.notes', tableName: 'records', rowId: 'r1' };

describe('row schemas', () => {
	test('accepts present and terminal absent row facts', () => {
		expectOk(parseFact({ address: ADDRESS, sequence: 1, presence: 'present', fields: {} }, LIMITS));
		expectOk(parseFact({ address: ADDRESS, sequence: 2, presence: 'absent' }, LIMITS));
	});
	test('accepts row patch and delete intents, rejects value-shaped payloads', () => {
		expectOk(parseIntent({ address: ADDRESS, presence: 'present', set: { title: 'A' }, unset: [] }, LIMITS));
		expectOk(parseIntent({ address: ADDRESS, presence: 'absent' }, LIMITS));
		expectErr(parseIntent({ address: ADDRESS, presence: 'present', content: 'A' }, LIMITS));
	});
});
