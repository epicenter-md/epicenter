/**
 * Record Admission Tests
 *
 * Verifies portable aggregate row limits independently from per-command wire
 * limits.
 *
 * Key behaviors:
 * - the maximum JSON object key count is admitted
 * - one additional key is refused before storage
 */

import { expect, test } from 'bun:test';
import {
	isAdmissibleCanonicalRow,
	isAdmissibleCommand,
	RECORD_SYNC_ADMISSION_LIMITS,
	RESERVED_KV_ROW_ID,
	RESERVED_KV_TABLE,
} from './admission.js';

test('canonical row admission refuses an aggregate object above the key ceiling', () => {
	const value: Record<string, number | boolean> = Object.fromEntries(
		Array.from(
			{ length: RECORD_SYNC_ADMISSION_LIMITS.propertiesPerObject },
			(_, index) => [`key${index}`, index],
		),
	);
	const row = { table: 'skills', rowId: 'skill-1', value };

	expect(isAdmissibleCanonicalRow(row)).toBeTrue();
	value.tooMany = true;
	expect(isAdmissibleCanonicalRow(row)).toBeFalse();
});

test('the reserved KV address admits only patches (ADR-0132)', () => {
	expect(
		isAdmissibleCommand({
			kind: 'patchRow',
			table: RESERVED_KV_TABLE,
			rowId: RESERVED_KV_ROW_ID,
			set: { theme: 'dark' },
			unset: [],
		}),
	).toBeTrue();
	expect(
		isAdmissibleCommand({
			kind: 'createRow',
			table: RESERVED_KV_TABLE,
			rowId: RESERVED_KV_ROW_ID,
			value: {},
		}),
	).toBeFalse();
	expect(
		isAdmissibleCommand({
			kind: 'deleteRow',
			table: RESERVED_KV_TABLE,
			rowId: RESERVED_KV_ROW_ID,
		}),
	).toBeFalse();
	expect(
		isAdmissibleCommand({
			kind: 'bodyAppend',
			table: RESERVED_KV_TABLE,
			rowId: RESERVED_KV_ROW_ID,
			update: 'dXBkYXRl',
		}),
	).toBeFalse();
});

test('body appends admit bounded non-empty updates (ADR-0133)', () => {
	expect(
		isAdmissibleCommand({
			kind: 'bodyAppend',
			table: 'notes',
			rowId: 'note-1',
			update: 'dXBkYXRl',
		}),
	).toBeTrue();
	expect(
		isAdmissibleCommand({
			kind: 'bodyAppend',
			table: 'notes',
			rowId: 'note-1',
			update: '',
		}),
	).toBeFalse();
	expect(
		isAdmissibleCommand({
			kind: 'bodyAppend',
			table: 'notes',
			rowId: 'note-1',
			update: 'x'.repeat(RECORD_SYNC_ADMISSION_LIMITS.encodedCommandBytes),
		}),
	).toBeFalse();
});
