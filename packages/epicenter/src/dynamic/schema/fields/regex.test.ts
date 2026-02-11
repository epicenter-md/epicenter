/**
 * @fileoverview Test suite for datetime and timezone validation regex patterns.
 *
 * Tests three regex patterns used in the schema system:
 * - ISO_DATETIME_REGEX: Validates ISO 8601 datetime strings
 * - TIMEZONE_ID_REGEX: Validates IANA timezone identifiers
 * - DATE_TIME_STRING_REGEX: Validates DateTimeString format (ISO datetime + IANA timezone)
 *
 * References:
 * - ISO 8601: https://en.wikipedia.org/wiki/ISO_8601
 * - IANA Time Zones: https://www.iana.org/time-zones
 * - Date.toISOString(): https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date/toISOString
 */
import { describe, expect, test } from 'bun:test';
import {
	DATE_TIME_STRING_REGEX,
	ISO_DATETIME_REGEX,
	TIMEZONE_ID_REGEX,
} from './regex';

/**
 * Tests for ISO_DATETIME_REGEX
 *
 * This regex validates ISO 8601 datetime strings in the formats produced by Date.toISOString().
 * It's designed as a component regex (no anchors) for composition into larger patterns.
 *
 * Supported ISO 8601 formats:
 * - YYYY-MM-DD (date only)
 * - YYYY-MM-DDTHH:mm (date + time)
 * - YYYY-MM-DDTHH:mm:ss (+ seconds)
 * - YYYY-MM-DDTHH:mm:ss.SSS (+ milliseconds, 1-3 digits)
 * - All above with Z (UTC) or ±HH:mm (timezone offset)
 *
 * Note: This regex validates format structure only, not numeric ranges.
 * It will match "2024-13-01" (month 13) or "25:00" (hour 25) because validating
 * that months are 1-12, days are valid for the month, hours are 0-23, etc. would
 * make the regex significantly more complex. Range validation should be performed
 * separately using JavaScript's Date constructor or similar validation logic.
 */
describe('ISO_DATETIME_REGEX', () => {
	/**
	 * Tests that verify the regex matches all supported ISO 8601 datetime formats.
	 * These formats align with the output of Date.toISOString() and related date formatting.
	 */
	describe('matches valid ISO 8601 datetime formats', () => {
		test('date only (YYYY-MM-DD)', () => {
			expect(ISO_DATETIME_REGEX.test('2024-01-01')).toBe(true);
		});

		test('date + time (YYYY-MM-DDTHH:mm)', () => {
			expect(ISO_DATETIME_REGEX.test('2024-01-01T20:00')).toBe(true);
		});

		test('date + time + seconds (YYYY-MM-DDTHH:mm:ss)', () => {
			expect(ISO_DATETIME_REGEX.test('2024-01-01T20:00:00')).toBe(true);
		});

		test('date + time + milliseconds (YYYY-MM-DDTHH:mm:ss.SSS)', () => {
			expect(ISO_DATETIME_REGEX.test('2024-01-01T20:00:00.000')).toBe(true);
		});

		test('date + time + milliseconds + UTC (Z)', () => {
			expect(ISO_DATETIME_REGEX.test('2024-01-01T20:00:00.000Z')).toBe(true);
		});

		test('date + time + milliseconds + positive offset (+HH:mm)', () => {
			expect(ISO_DATETIME_REGEX.test('2024-01-01T20:00:00.000+05:00')).toBe(
				true,
			);
		});

		test('date + time + milliseconds + negative offset (-HH:mm)', () => {
			expect(ISO_DATETIME_REGEX.test('2024-01-01T20:00:00-05:00')).toBe(true);
		});

		test('single digit milliseconds', () => {
			expect(ISO_DATETIME_REGEX.test('2024-01-01T20:00:00.0Z')).toBe(true);
		});

		test('two digit milliseconds', () => {
			expect(ISO_DATETIME_REGEX.test('2024-01-01T20:00:00.00Z')).toBe(true);
		});

		test('max milliseconds (999)', () => {
			expect(ISO_DATETIME_REGEX.test('2024-01-01T20:00:00.999Z')).toBe(true);
		});

		test('Date.toISOString() output format', () => {
			const isoString = new Date('2024-01-01T20:00:00.000Z').toISOString();
			expect(ISO_DATETIME_REGEX.test(isoString)).toBe(true);
		});
	});

	/**
	 * Tests that verify the regex correctly rejects malformed datetime strings.
	 * These test cases ensure the regex doesn't match strings that don't follow ISO 8601 structure.
	 */
	describe('rejects malformed datetime strings', () => {
		test('2-digit year', () => {
			expect(ISO_DATETIME_REGEX.test('24-01-01')).toBe(false);
		});

		test('wrong separator (slash)', () => {
			expect(ISO_DATETIME_REGEX.test('2024/01/01')).toBe(false);
		});

		test('empty string', () => {
			expect(ISO_DATETIME_REGEX.test('')).toBe(false);
		});
	});

	/**
	 * Edge case tests documenting the regex's intentional limitations.
	 *
	 * Important: This regex validates format structure only, not numeric ranges.
	 * It will match strings like "2024-13-01" (month 13) or "25:00" (hour 25)
	 * because validating that months are 1-12, days are valid for the month,
	 * hours are 0-23, minutes/seconds are 0-59, etc. would make the regex
	 * significantly more complex.
	 *
	 * Range validation (valid months, days, hours, etc.) should be performed
	 * separately using JavaScript's Date constructor or similar validation logic.
	 */
	describe('validates format structure but not numeric ranges', () => {
		test('regex does not validate month ranges (accepts 13)', () => {
			// Note: regex validates format structure, not that month is 1-12
			expect(ISO_DATETIME_REGEX.test('2024-13-01')).toBe(true);
		});

		test('regex does not validate hour ranges (accepts 25)', () => {
			// Note: regex validates format structure, not that hour is 0-23
			expect(ISO_DATETIME_REGEX.test('2024-01-01T25:00:00Z')).toBe(true);
		});
	});
});

/**
 * Tests for TIMEZONE_ID_REGEX
 *
 * This regex validates IANA timezone identifiers (e.g., "America/New_York", "UTC").
 * It's designed as a component regex (no anchors) for composition into DATE_TIME_STRING_REGEX.
 *
 * IANA timezone identifier format:
 * - Must start with a letter
 * - Can contain letters, digits, underscores, forward slashes, hyphens, plus signs
 * - Examples: America/New_York, UTC, Europe/London, Etc/GMT+5
 *
 * Reference: https://www.iana.org/time-zones
 */
describe('TIMEZONE_ID_REGEX', () => {
	/**
	 * Tests that verify the regex matches valid IANA timezone identifier formats.
	 * These are real timezone identifiers from the IANA Time Zone Database.
	 */
	describe('matches valid IANA timezone identifiers', () => {
		test('UTC', () => {
			expect(TIMEZONE_ID_REGEX.test('UTC')).toBe(true);
		});

		test('America/New_York', () => {
			expect(TIMEZONE_ID_REGEX.test('America/New_York')).toBe(true);
		});

		test('Europe/London', () => {
			expect(TIMEZONE_ID_REGEX.test('Europe/London')).toBe(true);
		});

		test('Asia/Tokyo', () => {
			expect(TIMEZONE_ID_REGEX.test('Asia/Tokyo')).toBe(true);
		});

		test('Etc/GMT+5', () => {
			expect(TIMEZONE_ID_REGEX.test('Etc/GMT+5')).toBe(true);
		});

		test('Etc/GMT-5', () => {
			expect(TIMEZONE_ID_REGEX.test('Etc/GMT-5')).toBe(true);
		});

		test('US/Pacific', () => {
			expect(TIMEZONE_ID_REGEX.test('US/Pacific')).toBe(true);
		});

		test('single letter (Z)', () => {
			expect(TIMEZONE_ID_REGEX.test('Z')).toBe(true);
		});
	});

	/**
	 * Tests that verify the regex correctly rejects strings that don't contain valid timezone identifiers.
	 * These test cases ensure strings starting with invalid characters are rejected.
	 */
	describe('rejects strings without timezone identifiers', () => {
		test('only digits', () => {
			expect(TIMEZONE_ID_REGEX.test('123')).toBe(false);
		});

		test('starts with hyphen (offset notation)', () => {
			expect(TIMEZONE_ID_REGEX.test('-05:00')).toBe(false);
		});

		test('empty string', () => {
			expect(TIMEZONE_ID_REGEX.test('')).toBe(false);
		});
	});

	describe('component regex behavior (matches anywhere in string)', () => {
		test('finds timezone ID even if preceded by underscore', () => {
			// This is expected: component regexes don't have anchors
			// When composed into DATE_TIME_STRING_REGEX, anchors are added
			expect(TIMEZONE_ID_REGEX.test('_UTC')).toBe(true); // matches "UTC"
		});

		test('finds timezone ID even if preceded by slash', () => {
			expect(TIMEZONE_ID_REGEX.test('/America')).toBe(true); // matches "America"
		});
	});
});

/**
 * Tests for DATE_TIME_STRING_REGEX
 *
 * This regex validates the complete DateTimeString format: ISO datetime + pipe + IANA timezone.
 * It's composed from ISO_DATETIME_REGEX and TIMEZONE_ID_REGEX with anchors and a pipe separator.
 *
 * Format: YYYY-MM-DD[THH:mm[:ss[.SSS]]][Z|±HH:mm]|TIMEZONE_ID
 * Example: "2024-01-01T20:00:00.000Z|America/New_York"
 *
 * This is the primary validation pattern used throughout the schema system for date fields.
 */
describe('DATE_TIME_STRING_REGEX', () => {
	/**
	 * Tests that verify the regex matches valid DateTimeString formats.
	 * Format must be: "YYYY-MM-DDTHH:mm:ss.sssZ|TIMEZONE_ID" (strict UTC format)
	 */
	describe('matches valid DateTimeString format', () => {
		test('full ISO UTC datetime with timezone', () => {
			expect(
				DATE_TIME_STRING_REGEX.test(
					'2024-01-01T20:00:00.000Z|America/New_York',
				),
			).toBe(true);
		});

		test('UTC datetime with UTC timezone', () => {
			expect(DATE_TIME_STRING_REGEX.test('2024-01-01T00:00:00.000Z|UTC')).toBe(
				true,
			);
		});

		test('UTC datetime with simple timezone', () => {
			expect(
				DATE_TIME_STRING_REGEX.test('2024-06-15T12:30:45.123Z|Europe/London'),
			).toBe(true);
		});
	});

	describe('rejects invalid DateTimeString format', () => {
		test('date-only format (requires full ISO UTC)', () => {
			expect(DATE_TIME_STRING_REGEX.test('2024-01-01|UTC')).toBe(false);
		});

		test('datetime with offset instead of Z', () => {
			expect(
				DATE_TIME_STRING_REGEX.test('2024-01-01T20:00:00+05:00|Asia/Tokyo'),
			).toBe(false);
		});

		test('missing milliseconds', () => {
			expect(DATE_TIME_STRING_REGEX.test('2024-01-01T20:00:00Z|UTC')).toBe(
				false,
			);
		});

		test('no timezone (missing pipe)', () => {
			expect(DATE_TIME_STRING_REGEX.test('2024-01-01')).toBe(false);
		});

		test('empty timezone after pipe', () => {
			expect(DATE_TIME_STRING_REGEX.test('2024-01-01T00:00:00.000Z|')).toBe(
				false,
			);
		});

		test('no datetime (pipe at start)', () => {
			expect(DATE_TIME_STRING_REGEX.test('|America/New_York')).toBe(false);
		});

		test('space separator instead of pipe', () => {
			expect(
				DATE_TIME_STRING_REGEX.test(
					'2024-01-01T00:00:00.000Z America/New_York',
				),
			).toBe(false);
		});

		test('no pipe, no timezone', () => {
			expect(DATE_TIME_STRING_REGEX.test('2024-01-01T20:00:00.000Z')).toBe(
				false,
			);
		});

		test('empty string', () => {
			expect(DATE_TIME_STRING_REGEX.test('')).toBe(false);
		});
	});

	describe('extracts datetime and timezone via capture groups', () => {
		test('extracts datetime and timezone parts', () => {
			const input = '2024-01-01T20:00:00.000Z|America/New_York';
			const match = input.match(DATE_TIME_STRING_REGEX);

			expect(match).not.toBeNull();
			expect(match?.[1]).toBe('2024-01-01T20:00:00.000Z');
			expect(match?.[2]).toBe('America/New_York');
		});

		test('extracts UTC timezone', () => {
			const input = '2024-06-15T12:00:00.000Z|UTC';
			const match = input.match(DATE_TIME_STRING_REGEX);

			expect(match).not.toBeNull();
			expect(match?.[1]).toBe('2024-06-15T12:00:00.000Z');
			expect(match?.[2]).toBe('UTC');
		});

		test('extracts complex timezone path', () => {
			const input = '2024-01-01T09:00:00.000Z|Asia/Tokyo';
			const match = input.match(DATE_TIME_STRING_REGEX);

			expect(match).not.toBeNull();
			expect(match?.[1]).toBe('2024-01-01T09:00:00.000Z');
			expect(match?.[2]).toBe('Asia/Tokyo');
		});
	});

	/**
	 * Tests using real-world timezone examples from different regions.
	 * Verifies the regex works with commonly used timezone identifiers and realistic datetime values.
	 */
	describe('validates real-world timezone examples', () => {
		test('New York Eastern Time', () => {
			expect(
				DATE_TIME_STRING_REGEX.test(
					'2024-01-01T15:30:00.000Z|America/New_York',
				),
			).toBe(true);
		});

		test('Tokyo time', () => {
			expect(
				DATE_TIME_STRING_REGEX.test('2024-01-01T09:00:00.000Z|Asia/Tokyo'),
			).toBe(true);
		});

		test('London time', () => {
			expect(
				DATE_TIME_STRING_REGEX.test('2024-07-15T14:22:33.123Z|Europe/London'),
			).toBe(true);
		});

		test('UTC time', () => {
			expect(DATE_TIME_STRING_REGEX.test('2024-12-31T23:59:59.999Z|UTC')).toBe(
				true,
			);
		});
	});
});
