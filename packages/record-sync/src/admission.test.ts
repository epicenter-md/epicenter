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
	RECORD_SYNC_ADMISSION_LIMITS,
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
