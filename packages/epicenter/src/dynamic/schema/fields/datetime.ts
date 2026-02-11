/**
 * DateTime types and Temporal API helpers.
 *
 * Storage format: "2024-01-01T20:00:00.000Z|America/New_York"
 * Runtime type: Temporal.ZonedDateTime (use directly for all date operations)
 */

import { Temporal } from 'temporal-polyfill';
import type { Brand } from 'wellcrafted/brand';
import { DATE_TIME_STRING_REGEX } from './regex';

/** ISO 8601 UTC datetime string from Date.toISOString() */
export type DateIsoString = string & Brand<'DateIsoString'>;

/** IANA timezone identifier (e.g., "America/New_York", "UTC") */
export type TimezoneId = string & Brand<'TimezoneId'>;

/** Database storage format: "ISO_UTC|TIMEZONE" */
export type DateTimeString = `${DateIsoString}|${TimezoneId}` &
	Brand<'DateTimeString'>;

/**
 * Companion object for DateTimeString branded type.
 *
 * Follows the JSON API pattern for familiarity:
 * - `DateTimeString.parse()` - storage string → live Temporal
 * - `DateTimeString.stringify()` - live Temporal → storage string
 *
 * @example
 * // Read from storage, edit, write back
 * const stored: DateTimeString = row.createdAt;
 * const live = DateTimeString.parse(stored);
 * const edited = live.add({ months: 1 });
 * const toStore = DateTimeString.stringify(edited);
 *
 * @example
 * // Create with current time
 * const now = DateTimeString.now(); // Uses system timezone
 * const nowNY = DateTimeString.now('America/New_York');
 */
export const DateTimeString = {
	/**
	 * Type guard to check if a value is a valid DateTimeString.
	 * Format: "YYYY-MM-DDTHH:mm:ss.sssZ|TIMEZONE" (24 char ISO + pipe + timezone)
	 */
	is(value: unknown): value is DateTimeString {
		if (typeof value !== 'string') return false;
		return DATE_TIME_STRING_REGEX.test(value);
	},

	/**
	 * Parse storage string to Temporal.ZonedDateTime for editing.
	 *
	 * @example
	 * const dt = DateTimeString.parse(stored);
	 * dt.add({ months: 1 }); // Date math just works
	 */
	parse(str: DateTimeString): Temporal.ZonedDateTime {
		if (!DATE_TIME_STRING_REGEX.test(str)) {
			throw new Error(`Invalid DateTimeString format: ${str}`);
		}
		const instant = str.slice(0, 24) as DateIsoString;
		const timezone = str.slice(25) as TimezoneId;
		return Temporal.Instant.from(instant).toZonedDateTimeISO(timezone);
	},

	/**
	 * Stringify Temporal.ZonedDateTime to storage format.
	 *
	 * @example
	 * const stored = DateTimeString.stringify(Temporal.Now.zonedDateTimeISO('America/New_York'));
	 * // => "2024-01-01T20:00:00.000Z|America/New_York"
	 */
	stringify(dt: Temporal.ZonedDateTime): DateTimeString {
		const date = new Date(dt.epochMilliseconds);
		return `${date.toISOString()}|${dt.timeZoneId}` as DateTimeString;
	},

	/**
	 * Create a DateTimeString for the current moment.
	 *
	 * @param timezone - IANA timezone identifier. Defaults to system timezone.
	 *
	 * @example
	 * const now = DateTimeString.now(); // Uses system timezone
	 * const nowNY = DateTimeString.now('America/New_York');
	 */
	now(timezone?: TimezoneId | string): DateTimeString {
		const tz = timezone ?? Temporal.Now.timeZoneId();
		const dt = Temporal.Now.zonedDateTimeISO(tz);
		return this.stringify(dt);
	},
} as const;
