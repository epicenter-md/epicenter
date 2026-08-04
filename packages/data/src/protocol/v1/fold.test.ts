import { describe, expect, test } from 'bun:test';
import { foldIntent, type Fact, type Intent, type JsonObject, type RowAddress } from './index.js';

const ADDRESS: RowAddress = { namespace: 'so.epicenter.notes', tableName: 'records', rowId: 'r1' };
const present = (fields: JsonObject, sequence = 1): Fact => ({ address: ADDRESS, sequence, presence: 'present', fields });
const patch = (set: JsonObject, unset: string[] = []): Intent => ({ address: ADDRESS, presence: 'present', set, unset });

describe('row fold', () => {
	test('patches an empty row and composes fields', () => {
		const first = foldIntent(undefined, patch({ title: 'A' }), 1);
		expect(first).toEqual({ kind: 'changed', fact: present({ title: 'A' }) });
		expect(foldIntent(first.kind === 'changed' ? first.fact : undefined, patch({ open: true }), 2)).toEqual({ kind: 'changed', fact: present({ title: 'A', open: true }, 2) });
	});
	test('tombstones are terminal and deletes are idempotent', () => {
		const deleted: Fact = { address: ADDRESS, sequence: 1, presence: 'absent' };
		expect(foldIntent(deleted, patch({ title: 'A' }), 2)).toEqual({ kind: 'unchanged' });
		expect(foldIntent(deleted, { address: ADDRESS, presence: 'absent' }, 2)).toEqual({ kind: 'unchanged' });
	});
});
