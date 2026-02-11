/**
 * @fileoverview Regex patterns for datetime and timezone validation.
 *
 * These patterns are used throughout the schema system to validate DateTimeString values.
 * Uses arkregex for type-safe regex with inferred capture groups.
 */

import { regex } from 'arkregex';

/**
 * Regex pattern for flexible ISO 8601 datetime validation.
 *
 * Supported formats:
 * - YYYY-MM-DD (date only)
 * - YYYY-MM-DDTHH:mm (date + time)
 * - YYYY-MM-DDTHH:mm:ss (date + time + seconds)
 * - YYYY-MM-DDTHH:mm:ss.SSS (date + time + milliseconds)
 * - All above with Z (UTC) or ±HH:mm (timezone offset)
 *
 * References:
 * - ISO 8601: https://en.wikipedia.org/wiki/ISO_8601
 * - Date.parse(): https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date/parse
 *
 * @example "2024-01-01"
 * @example "2024-01-01T20:00:00.000Z"
 */
export const ISO_DATETIME_REGEX = regex(
	'\\d{4}-\\d{2}-\\d{2}(?:T\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d{1,3})?)?(?:Z|[+-]\\d{2}:\\d{2})?)?',
);

/**
 * Regex pattern for exact UTC datetime format from Date.toISOString().
 *
 * Format: "YYYY-MM-DDTHH:mm:ss.sssZ" (exactly 24 characters)
 *
 * This strict format ensures:
 * - Consistent storage (always 24 chars)
 * - Correct SQLite string sorting (UTC-first)
 * - Cross-platform compatibility (fixed format)
 *
 * @example "2024-01-01T20:00:00.000Z"
 */
export const ISO_UTC_EXACT_REGEX = regex(
	'\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z',
);

/**
 * Regex pattern for IANA timezone identifier validation (TimezoneId portion).
 *
 * Format rules:
 * - Must start with a letter
 * - Can contain letters, digits, underscores, forward slashes, hyphens, plus signs
 *
 * References:
 * - IANA Time Zones: https://www.iana.org/time-zones
 *
 * @example "America/New_York"
 * @example "UTC"
 * @example "Europe/London"
 * @example "Etc/GMT+5"
 */
export const TIMEZONE_ID_REGEX = regex('[A-Za-z][A-Za-z0-9_/+-]*');

/**
 * Regex pattern for DateTimeString validation.
 *
 * Format: "YYYY-MM-DDTHH:mm:ss.sssZ|TIMEZONE_ID"
 *
 * Uses {@link ISO_UTC_EXACT_REGEX} (not the flexible one) to ensure:
 * - Fixed 24-char UTC prefix for correct SQLite string sorting
 * - Consistent parsing with hardcoded slice(0, 24)
 *
 * @example "2024-01-01T20:00:00.000Z|America/New_York"
 */
export const DATE_TIME_STRING_REGEX = regex(
	`^(${ISO_UTC_EXACT_REGEX.source})\\|(${TIMEZONE_ID_REGEX.source})$`,
);
