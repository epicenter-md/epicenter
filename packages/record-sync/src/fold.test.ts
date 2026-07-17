/**
 * Mirror-Rule Fold Tests (ADR-0131/0132)
 *
 * `foldRow` is shared by the authority and every replica's optimistic
 * replay, so these semantics ARE the convergence contract.
 *
 * Key behaviors:
 * - first create wins; a duplicate create folds to a no-op
 * - patches on absent rows fold to no-ops, except the reserved KV address
 * - composed rows over their capacity cap fold to no-ops on both sides
 * - folding never aliases caller state and keeps __proto__ an own key
 */

import { expect, test } from 'bun:test';
import {
	RECORD_SYNC_ADMISSION_LIMITS,
	RESERVED_KV_ROW_ID,
	RESERVED_KV_TABLE,
} from './admission.js';
import { foldRow } from './fold.js';
import type { JsonObject } from './protocol.js';

test('first create wins and a duplicate create folds to a no-op', () => {
	const created = foldRow(undefined, {
		kind: 'createRow',
		table: 'skills',
		rowId: 'skill-1',
		value: { title: 'First' },
	});
	expect(created).toEqual({ kind: 'row', value: { title: 'First' } });

	expect(
		foldRow(
			{ title: 'First' },
			{
				kind: 'createRow',
				table: 'skills',
				rowId: 'skill-1',
				value: { title: 'Second' },
			},
		),
	).toEqual({ kind: 'noop' });
});

test('patch and delete on an absent row fold to no-ops', () => {
	expect(
		foldRow(undefined, {
			kind: 'patchRow',
			table: 'skills',
			rowId: 'missing',
			set: { title: 'Ghost' },
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

test('a patch applies set and unset without aliasing its inputs', () => {
	const current: JsonObject = { title: 'Old', stale: true, kept: 1 };
	const set: JsonObject = { title: 'New', nested: { deep: true } };
	const folded = foldRow(current, {
		kind: 'patchRow',
		table: 'skills',
		rowId: 'skill-1',
		set,
		unset: ['stale'],
	});
	if (folded.kind !== 'row') throw new Error('Expected a folded row');

	expect(folded.value).toEqual({
		title: 'New',
		kept: 1,
		nested: { deep: true },
	});
	expect(current).toEqual({ title: 'Old', stale: true, kept: 1 });
	(set.nested as JsonObject).deep = false;
	expect(folded.value.nested).toEqual({ deep: true });
});

test('__proto__ stays an ordinary own key through the fold', () => {
	const folded = foldRow(
		{},
		{
			kind: 'patchRow',
			table: 'skills',
			rowId: 'skill-1',
			set: JSON.parse('{"__proto__":{"polluted":true}}') as JsonObject,
			unset: [],
		},
	);
	if (folded.kind !== 'row') throw new Error('Expected a folded row');
	expect(Object.getPrototypeOf(folded.value)).toBe(Object.prototype);
	expect(Object.hasOwn(folded.value, '__proto__')).toBeTrue();
	expect(Object.getPrototypeOf({})).not.toHaveProperty('polluted');
});

test('a composed row over the general capacity cap folds to a no-op', () => {
	const half = 'x'.repeat(260 * 1024);
	const base = foldRow(undefined, {
		kind: 'createRow',
		table: 'skills',
		rowId: 'skill-1',
		value: { a: half },
	});
	if (base.kind !== 'row') throw new Error('Expected the base row');

	expect(
		foldRow(base.value, {
			kind: 'patchRow',
			table: 'skills',
			rowId: 'skill-1',
			set: { b: half },
			unset: [],
		}),
	).toEqual({ kind: 'noop' });
	// Replacing the key instead of adding one stays under the cap.
	expect(
		foldRow(base.value, {
			kind: 'patchRow',
			table: 'skills',
			rowId: 'skill-1',
			set: { a: 'small' },
			unset: [],
		}),
	).toEqual({ kind: 'row', value: { a: 'small' } });
});

test('the reserved KV address folds from {} and owns the aggregate cap', () => {
	const materialized = foldRow(undefined, {
		kind: 'patchRow',
		table: RESERVED_KV_TABLE,
		rowId: RESERVED_KV_ROW_ID,
		set: { 'editor.spellcheck': true },
		unset: [],
	});
	expect(materialized).toEqual({
		kind: 'row',
		value: { 'editor.spellcheck': true },
	});

	const nearCap = {
		big: 'x'.repeat(RECORD_SYNC_ADMISSION_LIMITS.encodedKvAggregateBytes - 1024),
	};
	expect(
		foldRow(nearCap, {
			kind: 'patchRow',
			table: RESERVED_KV_TABLE,
			rowId: RESERVED_KV_ROW_ID,
			set: { overflow: 'y'.repeat(2 * 1024) },
			unset: [],
		}),
	).toEqual({ kind: 'noop' });
	// An unset always fits: absence in the newest image is the unset story.
	expect(
		foldRow(nearCap, {
			kind: 'patchRow',
			table: RESERVED_KV_TABLE,
			rowId: RESERVED_KV_ROW_ID,
			set: {},
			unset: ['big'],
		}),
	).toEqual({ kind: 'row', value: {} });
});

test('deletion of a live row is permanent, never conditional', () => {
	expect(
		foldRow(
			{ title: 'Doomed' },
			{ kind: 'deleteRow', table: 'skills', rowId: 'skill-1' },
		),
	).toEqual({ kind: 'deletion' });
});
