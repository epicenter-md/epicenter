/**
 * Schema-Blind Row Fold Tests
 *
 * Verifies the three total current-state transitions without schemas or
 * migration metadata.
 *
 * Key behaviors:
 * - create refuses a live identity
 * - patch preserves unknown keys and unsets explicitly
 * - absent patch and delete are no-ops
 */

import { expect, test } from 'bun:test';
import { foldRow } from './fold.js';

test('createRow stores the complete opaque JSON object', () => {
	expect(
		foldRow(undefined, {
			kind: 'createRow',
			table: 'skills',
			rowId: 'skill-1',
			value: { title: 'One', nested: { future: true }, nullable: null },
		}),
	).toEqual({
		kind: 'row',
		value: { title: 'One', nested: { future: true }, nullable: null },
	});
});

test('createRow refuses an already live identity', () => {
	expect(
		foldRow(
			{ title: 'Existing' },
			{
				kind: 'createRow',
				table: 'skills',
				rowId: 'skill-1',
				value: { title: 'Replacement' },
			},
		),
	).toEqual({ kind: 'create-conflict' });
});

test('patchRow preserves unknown keys and distinguishes null from unset', () => {
	expect(
		foldRow(
			{ title: 'Old', unknown: { preserved: true }, removeMe: 1 },
			{
				kind: 'patchRow',
				table: 'skills',
				rowId: 'skill-1',
				set: { title: 'New', nullable: null },
				unset: ['removeMe'],
			},
		),
	).toEqual({
		kind: 'row',
		value: {
			title: 'New',
			unknown: { preserved: true },
			nullable: null,
		},
	});
});

test('patchRow and deleteRow no-op when the row is absent', () => {
	expect(
		foldRow(undefined, {
			kind: 'patchRow',
			table: 'skills',
			rowId: 'missing',
			set: { title: 'No row' },
			unset: [],
		}),
	).toEqual({ kind: 'noop' });
	expect(
		foldRow(undefined, {
			kind: 'deleteRow',
			table: 'skills',
			rowId: 'missing',
		}),
	).toEqual({ kind: 'noop' });
});

test('deleteRow marks a live row for deletion', () => {
	expect(
		foldRow(
			{ title: 'Existing' },
			{ kind: 'deleteRow', table: 'skills', rowId: 'skill-1' },
		),
	).toEqual({ kind: 'deletion' });
});
