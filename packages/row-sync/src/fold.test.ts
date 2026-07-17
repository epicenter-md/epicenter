import { describe, expect, test } from 'bun:test';
import {
	RESERVED_KV_ROW_ID,
	RESERVED_KV_TABLE,
	ROW_SYNC_ADMISSION_LIMITS,
} from './admission.js';
import { foldFields } from './fold.js';
import type { WireRowIntent } from './protocol.js';

const ROW_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';

const create = (fields: Record<string, unknown>): WireRowIntent => ({
	kind: 'create',
	table: 'notes',
	rowId: ROW_ID,
	fields: fields as never,
});

const update = (
	set: Record<string, unknown>,
	unset: string[] = [],
): WireRowIntent => ({
	kind: 'update',
	table: 'notes',
	rowId: ROW_ID,
	fields: { set: set as never, unset },
});

describe('foldFields mirror rule', () => {
	test('create on absence applies the complete field postimage', () => {
		expect(foldFields(undefined, create({ title: 'a' }))).toEqual({
			kind: 'fields',
			fields: { title: 'a' },
		});
	});

	test('create on a live row is a whole no-op; first create wins', () => {
		expect(foldFields({ title: 'live' }, create({ title: 'b' }))).toEqual({
			kind: 'noop',
		});
	});

	test('update unsets before setting and preserves unknown keys', () => {
		expect(
			foldFields(
				{ title: 'a', stale: true, unknown: { keep: 1 } },
				update({ title: 'b', nullable: null }, ['stale']),
			),
		).toEqual({
			kind: 'fields',
			fields: { title: 'b', nullable: null, unknown: { keep: 1 } },
		});
	});

	test('update on an absent ordinary row is a whole no-op', () => {
		expect(foldFields(undefined, update({ title: 'x' }))).toEqual({
			kind: 'noop',
		});
	});

	test('a document-only update leaves fields untouched', () => {
		expect(
			foldFields(
				{ title: 'a' },
				{
					kind: 'update',
					table: 'notes',
					rowId: ROW_ID,
					documentUpdate: 'AAAA',
				},
			),
		).toEqual({ kind: 'noop' });
	});

	test('delete on a live row emits deletion; on absence a no-op', () => {
		const intent: WireRowIntent = {
			kind: 'delete',
			table: 'notes',
			rowId: ROW_ID,
		};
		expect(foldFields({ title: 'a' }, intent)).toEqual({ kind: 'deletion' });
		expect(foldFields(undefined, intent)).toEqual({ kind: 'noop' });
	});

	test('a folded row above the general capacity cap is a no-op', () => {
		const oversized = 'x'.repeat(ROW_SYNC_ADMISSION_LIMITS.encodedRowBytes);
		expect(foldFields({ title: 'a' }, update({ big: oversized }))).toEqual({
			kind: 'noop',
		});
	});
});

describe('reserved KV address (ADR-0132)', () => {
	const kvUpdate = (
		set: Record<string, unknown>,
		unset: string[] = [],
	): WireRowIntent => ({
		kind: 'update',
		table: RESERVED_KV_TABLE,
		rowId: RESERVED_KV_ROW_ID,
		fields: { set: set as never, unset },
	});

	test('an update on the absent reserved address folds from {}', () => {
		expect(
			foldFields(undefined, kvUpdate({ 'editor.spellcheck': true })),
		).toEqual({ kind: 'fields', fields: { 'editor.spellcheck': true } });
	});

	test('unset removes the key entirely; absence is the whole unset story', () => {
		expect(foldFields({ a: 1, b: 2 }, kvUpdate({}, ['a']))).toEqual({
			kind: 'fields',
			fields: { b: 2 },
		});
	});

	test('a composed image above the KV aggregate cap is a no-op', () => {
		const nearCap = {
			existing: 'y'.repeat(
				ROW_SYNC_ADMISSION_LIMITS.encodedKvAggregateBytes - 1024,
			),
		};
		expect(foldFields(nearCap, kvUpdate({ more: 'z'.repeat(4096) }))).toEqual({
			kind: 'noop',
		});
	});
});
