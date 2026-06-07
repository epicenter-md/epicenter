/**
 * @fileoverview `IanaTimeZone` branded type and runtime companion.
 *
 * An IANA timezone identifier (e.g. `"America/New_York"`, `"Asia/Tokyo"`,
 * `"UTC"`), branded so it can't be accidentally mixed with arbitrary strings.
 *
 * The validator is `Intl.DateTimeFormat`: any zone the runtime accepts is
 * valid; any zone it rejects is not. This avoids a hand-maintained regex and
 * keeps the predicate in sync with whatever the host runtime supports.
 *
 * Paired with `DateTimeString` for zoned-datetime composition: a
 * `field.datetime()` instant plus a `field.string<IanaTimeZone>()` zone, the
 * `<field>` + `<field>Zone` convention.
 */

import type { Brand } from 'wellcrafted/brand';

/**
 * Branded IANA timezone identifier.
 *
 * @example `"America/New_York"`, `"Europe/London"`, `"Asia/Tokyo"`, `"UTC"`
 * @see https://en.wikipedia.org/wiki/List_of_tz_database_time_zones
 */
export type IanaTimeZone = string & Brand<'IanaTimeZone'>;

/**
 * Runtime predicate for `IanaTimeZone`. Returns `true` iff
 * `Intl.DateTimeFormat` accepts the value as a `timeZone` option.
 */
function isIanaTimeZone(value: unknown): value is IanaTimeZone {
	if (typeof value !== 'string') return false;
	try {
		new Intl.DateTimeFormat('en', { timeZone: value });
		return true;
	} catch {
		return false;
	}
}

export const IanaTimeZone = {
	/**
	 * Type guard: returns `true` iff `Intl.DateTimeFormat` accepts `value` as
	 * a `timeZone` option.
	 */
	is: isIanaTimeZone,

	/**
	 * The runtime's resolved IANA zone, branded.
	 *
	 * @example `IanaTimeZone.current()` → `"America/Los_Angeles"`
	 */
	current(): IanaTimeZone {
		return Intl.DateTimeFormat().resolvedOptions().timeZone as IanaTimeZone;
	},
};
