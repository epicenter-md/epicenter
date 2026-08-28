/**
 * The row primitives, and the one line between them that a durable table used
 * to guard.
 *
 * `createRow` mints a row when it is absent; `updateRow` cannot. That
 * difference is the whole of why they are two functions, and these tests are
 * the difference stated where it can be seen.
 */
import { describe, expect, test } from 'bun:test';
import type * as Y from '@y/y';

import {
	createAppDocument,
	createRow,
	deleteRow,
	hasRow,
	readRow,
	tableRoot,
	updateRow,
} from './document.js';

function table(): { document: Y.Doc; notes: Y.Type } {
	const document = createAppDocument();
	return { document, notes: tableRoot(document, 'notes') };
}

describe('createRow mints, and it is the only thing that does', () => {
	test('a row that was not there is there afterwards', () => {
		const { document, notes } = table();
		document.transact(() => createRow(notes, 'a', { title: 'hello' }));
		expect(readRow(notes, 'a')).toEqual({ title: 'hello' });
	});

	test('creating over an existing row merges rather than replacing it', () => {
		const { document, notes } = table();
		document.transact(() => createRow(notes, 'a', { title: 'hello' }));
		document.transact(() => createRow(notes, 'a', { pinned: true }));
		expect(readRow(notes, 'a')).toEqual({ title: 'hello', pinned: true });
	});
});

describe('updateRow cannot bring a row into existence', () => {
	test('updating an absent row writes nothing and says so', () => {
		const { document, notes } = table();
		let wrote = true;
		document.transact(() => {
			wrote = updateRow(notes, 'missing', { title: 'ghost' });
		});
		expect(wrote).toBe(false);
		expect(hasRow(notes, 'missing')).toBe(false);
		expect([...notes.attrKeys()]).toEqual([]);
	});

	test('updating a row that exists writes and says so', () => {
		const { document, notes } = table();
		document.transact(() => createRow(notes, 'a', { title: 'hello' }));
		let wrote = false;
		document.transact(() => {
			wrote = updateRow(notes, 'a', { title: 'changed' });
		});
		expect(wrote).toBe(true);
		expect(readRow(notes, 'a')).toEqual({ title: 'changed' });
	});

	test('a deleted row stays deleted, which is what the split is for', () => {
		// The resurrection path, closed. `deriveOnCommit` writes `updatedAt`
		// whenever a row's document commits, so on a device whose row was deleted
		// elsewhere a minting write would create a NEW nested type at the same
		// key — new data, which nothing in Yjs can refuse
		// (`evidence/invariants.test.ts`). This is that write, dropped.
		const { document, notes } = table();
		document.transact(() => createRow(notes, 'a', { title: 'hello' }));
		document.transact(() => deleteRow(notes, 'a'));

		let wrote = true;
		document.transact(() => {
			wrote = updateRow(notes, 'a', { updatedAt: '2026-08-28T00:00:00Z' });
		});
		expect(wrote).toBe(false);
		expect(hasRow(notes, 'a')).toBe(false);
		expect([...notes.attrKeys()]).toEqual([]);
	});
});

describe('both refuse a reserved field name', () => {
	test.each([['createRow'], ['updateRow']])('%s', (which) => {
		const { document, notes } = table();
		document.transact(() => createRow(notes, 'a', { title: 'hello' }));
		expect(() =>
			document.transact(() =>
				which === 'createRow'
					? createRow(notes, 'a', { '!internal': 1 })
					: updateRow(notes, 'a', { '!internal': 1 }),
			),
		).toThrow(TypeError);
	});
});
