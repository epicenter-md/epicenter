import { expect, test } from 'bun:test';
import { foldRow } from './fold.js';

test('fold patches named cells and null clears one cell', () => {
	const patched = foldRow(
		{ kind: 'live', cells: { title: 'old', pinned: true } },
		{
			kind: 'patchRow',
			table: 'notes',
			rowId: 'n1',
			cells: { title: 'new', pinned: null },
		},
	);
	expect(patched).toEqual({ kind: 'live', cells: { title: 'new' } });
});

test('fold makes deletion terminal', () => {
	const tombstone = foldRow(undefined, {
		kind: 'deleteRow',
		table: 'notes',
		rowId: 'n1',
	});
	expect(
		foldRow(tombstone, {
			kind: 'patchRow',
			table: 'notes',
			rowId: 'n1',
			cells: { title: 'cannot resurrect' },
		}),
	).toEqual({ kind: 'tombstone' });
});
