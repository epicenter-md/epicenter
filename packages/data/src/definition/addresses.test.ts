import { describe, expect, test } from 'bun:test';

import {
	DATA_ADDRESS_CEILINGS,
	documentAddress,
	isRowAddress,
} from './addresses.js';

describe('documentAddress (ADR-0248)', () => {
	test('composes the fixed-depth derived string, deterministically', () => {
		const address = {
			databaseId: 'so.epicenter.honeycrisp',
			tableName: 'notes',
			rowId: 'abc123',
		};
		expect(documentAddress(address)).toBe('so.epicenter.honeycrisp/notes/abc123');
		expect(documentAddress(address)).toBe(documentAddress({ ...address }));
	});

	test('coordinate validation lives at the grammar, not in the composer', () => {
		// The composer never escapes, so a slash-bearing coordinate must already
		// be unrepresentable. The grammar refuses each coordinate that could
		// make the interpolation ambiguous.
		for (const candidate of [
			{ databaseId: 'a/b.example', tableName: 'notes', rowId: 'r1' },
			{ databaseId: 'so.example', tableName: 'no/tes', rowId: 'r1' },
			{ databaseId: 'so.example', tableName: 'notes', rowId: 'r/1' },
			{ databaseId: 'so.example', tableName: '', rowId: 'r1' },
			{ databaseId: 'so.example', tableName: 'notes', rowId: '.hidden' },
		]) {
			expect(isRowAddress(candidate, DATA_ADDRESS_CEILINGS)).toBe(false);
		}
		expect(
			isRowAddress(
				{ databaseId: 'so.example', tableName: 'notes', rowId: 'r1' },
				DATA_ADDRESS_CEILINGS,
			),
		).toBe(true);
	});
});
