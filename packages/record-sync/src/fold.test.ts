import { expect, test } from 'bun:test';
import { foldRow } from './fold.js';

test('createRow materializes an absent row and drops null cells', () => {
	expect(
		foldRow(undefined, {
			kind: 'createRow',
			table: 'notes',
			rowId: 'n1',
			cells: { title: 'new', archivedAt: null },
		}),
	).toEqual({ kind: 'created', cells: { title: 'new' } });
});

test('createRow on a live row is a create conflict, never a no-op', () => {
	expect(
		foldRow(
			{ title: 'existing' },
			{ kind: 'createRow', table: 'notes', rowId: 'n1', cells: { title: 'x' } },
		),
	).toEqual({ kind: 'create-conflict' });
});

test('updateRow patches named cells and null clears one cell', () => {
	expect(
		foldRow(
			{ title: 'old', pinned: true },
			{
				kind: 'updateRow',
				table: 'notes',
				rowId: 'n1',
				cells: { title: 'new', pinned: null },
			},
		),
	).toEqual({ kind: 'updated', cells: { title: 'new' } });
});

test('updateRow on an absent row folds to an accepted no-op', () => {
	expect(
		foldRow(undefined, {
			kind: 'updateRow',
			table: 'notes',
			rowId: 'n1',
			cells: { title: 'cannot resurrect' },
		}),
	).toEqual({ kind: 'noop' });
});

test('deleteRow removes a live row and no-ops on an absent one', () => {
	expect(
		foldRow({ title: 'x' }, { kind: 'deleteRow', table: 'notes', rowId: 'n1' }),
	).toEqual({ kind: 'deleted' });
	expect(
		foldRow(undefined, { kind: 'deleteRow', table: 'notes', rowId: 'n1' }),
	).toEqual({ kind: 'noop' });
});
