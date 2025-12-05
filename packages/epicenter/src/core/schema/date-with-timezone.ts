/**
 * @fileoverview DateWithTimezone type and utilities
 *
 * Provides timezone-aware date handling with serialization support.
 * A DateWithTimezone stores both a UTC date and an IANA timezone identifier,
 * and can serialize itself to a string format for storage.
 */

import type { Brand } from 'wellcrafted/brand';
import { DATE_WITH_TIMEZONE_STRING_REGEX, ISO_DATETIME_REGEX } from './regex';

/**
 * ISO 8601 UTC datetime string from Date.toISOString()
 * @example "2024-01-01T20:00:00.000Z"
 */
export type DateIsoString = string & Brand<'DateIsoString'>;

/**
 * IANA timezone identifier
 * @example "America/New_York"
 * @example "Europe/London"
 * @example "Asia/Tokyo"
 * @example "UTC"
 */
export type TimezoneId = string & Brand<'TimezoneId'>;

/**
 * Database storage format combining UTC datetime and timezone
 * @example "2024-01-01T20:00:00.000Z|America/New_York"
 */
export type DateWithTimezoneString = `${DateIsoString}|${TimezoneId}` &
	Brand<'DateWithTimezoneString'>;

/**
 * A datetime value that knows its timezone and can serialize itself
 * @property date - JavaScript Date object (internally stored as UTC)
 * @property timezone - IANA timezone identifier
 * @property toJSON - Method to serialize to DateWithTimezoneString format
 */
export type DateWithTimezone = {
	date: Date;
	timezone: string;
	toJSON(): DateWithTimezoneString;
};

/**
 * Type guard to check if a value is a valid DateWithTimezone
 *
 * @param value - Value to check
 * @returns true if value is a DateWithTimezone object
 * @example
 * ```typescript
 * const dt = DateWithTimezone({ date: new Date(), timezone: 'UTC' });
 * isDateWithTimezone(dt) // true
 * isDateWithTimezone({}) // false
 * ```
 */
export function isDateWithTimezone(value: unknown): value is DateWithTimezone {
	return (
		typeof value === 'object' &&
		value !== null &&
		'date' in value &&
		value.date instanceof Date &&
		'timezone' in value &&
		typeof value.timezone === 'string' &&
		'toJSON' in value &&
		typeof value.toJSON === 'function'
	);
}

/**
 * Creates a DateWithTimezone object from a Date and timezone.
 * The returned object includes a toJSON() method for serialization.
 *
 * @param params.date - JavaScript Date object
 * @param params.timezone - IANA timezone identifier (e.g., "America/New_York", "UTC")
 * @returns DateWithTimezone object with toJSON method
 * @example
 * ```typescript
 * const now = DateWithTimezone({ date: new Date(), timezone: 'America/New_York' });
 * console.log(now.date);       // Date object
 * console.log(now.timezone);   // "America/New_York"
 * console.log(now.toJSON());   // "2024-01-01T20:00:00.000Z|America/New_York"
 * ```
 */
export function DateWithTimezone({
	date,
	timezone,
}: {
	date: Date;
	timezone: string;
}): DateWithTimezone {
	return {
		date,
		timezone,
		toJSON() {
			return `${date.toISOString()}|${timezone}` as DateWithTimezoneString;
		},
	};
}

/**
 * Type guard to check if a value is a valid ISO 8601 datetime string.
 * Validates the format but doesn't verify the date itself is valid.
 *
 * Supported formats:
 * - YYYY-MM-DD (date only)
 * - YYYY-MM-DDTHH:mm (date + time)
 * - YYYY-MM-DDTHH:mm:ss (date + time + seconds)
 * - YYYY-MM-DDTHH:mm:ss.SSS (date + time + milliseconds)
 * - All above with Z (UTC) or ±HH:mm (timezone offset)
 *
 * @param value - Value to check
 * @returns true if value is a valid ISO datetime string format
 *
 * @example
 * ```typescript
 * isIsoDateTimeString("2024-01-01") // true
 * isIsoDateTimeString("2024-01-01T20:00:00.000Z") // true
 * isIsoDateTimeString("2024-01-01T20:00:00.000Z|America/New_York") // false (has timezone)
 * isIsoDateTimeString("not-a-date") // false
 * isIsoDateTimeString(12345) // false
 * ```
 */
export function isIsoDateTimeString(value: unknown): value is string {
	if (typeof value !== 'string') return false;
	return ISO_DATETIME_REGEX.test(value);
}

/**
 * Type guard to check if a string is a valid DateWithTimezoneString.
 * Validates format: "ISO_UTC|TIMEZONE" where ISO string is exactly 24 chars.
 *
 * ISO 8601 UTC format from Date.toISOString() is always 24 characters:
 * "YYYY-MM-DDTHH:mm:ss.sssZ" (e.g., "2024-01-01T20:00:00.000Z")
 *
 * This is a fast structural check - it doesn't validate that the ISO date is valid
 * or that the timezone is a real IANA identifier, just that the format is correct.
 *
 * @param value - Value to check
 * @returns true if value is a valid DateWithTimezoneString format
 *
 * @example
 * ```typescript
 * isDateWithTimezoneString("2024-01-01T20:00:00.000Z|America/New_York") // true
 * isDateWithTimezoneString("2024-01-01T20:00:00.000Z|") // false (empty timezone)
 * isDateWithTimezoneString("2024-01-01") // false (no pipe separator)
 * ```
 */
export function isDateWithTimezoneString(
	value: unknown,
): value is DateWithTimezoneString {
	if (typeof value !== 'string') return false;

	// Use regex to validate format: ISO_8601_DATE|TIMEZONE
	return DATE_WITH_TIMEZONE_STRING_REGEX.test(value);
}

/**
 * Parses a DateWithTimezone object from a serialized string.
 * The returned object includes a toJSON() method for serialization.
 *
 * @param serialized - String in format "ISO_UTC|TIMEZONE"
 * @returns DateWithTimezone object with toJSON method
 * @throws Error if the serialized string is not in the correct format
 * @example
 * ```typescript
 * const parsed = DateWithTimezoneFromString("2024-01-01T20:00:00.000Z|America/New_York" as DateWithTimezoneString);
 * console.log(parsed.date);    // Date object for 2024-01-01T20:00:00.000Z
 * console.log(parsed.timezone);// "America/New_York"
 * ```
 */
export function DateWithTimezoneFromString(
	serialized: DateWithTimezoneString,
): DateWithTimezone {
	if (!isDateWithTimezoneString(serialized)) {
		throw new Error(`Invalid DateWithTimezone format: ${serialized}`);
	}

	// ISO string is always first 24 characters, pipe at index 24, timezone after
	const isoUtc = serialized.slice(0, 24);
	const timezone = serialized.slice(25);

	return DateWithTimezone({ date: new Date(isoUtc), timezone });
}
