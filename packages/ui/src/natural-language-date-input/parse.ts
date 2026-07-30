import * as chrono from 'chrono-node';
import type { IanaTimeZone } from './iana-time-zone.js';

type ParsedSuggestion = { label: string; date: Date };

type ParseInZoneOptions = {
	text: string;
	referenceNow: Date;
	timeZone: IanaTimeZone;
};

/**
 * Parse natural-language datetime phrases as if "now" were in `timeZone`.
 *
 * Bare wall-clock phrases like "5pm" or "tomorrow at 9" resolve to the
 * matching UTC instant in `timeZone`, not in the runtime's local zone.
 * Relative phrases like "in 2 hours" ignore `timeZone` (chrono adds the
 * delta to `referenceNow` directly).
 *
 * DST note: the zone offset is computed at `referenceNow`. A phrase
 * straddling a DST transition uses the offset at the reference instant,
 * not at the resolved instant. This matches chrono's own behavior.
 */
export function parseInZone(opts: ParseInZoneOptions): ParsedSuggestion[] {
	const { text, referenceNow, timeZone } = opts;
	if (!text.trim()) return [];

	const offsetMinutes = getZoneOffsetMinutes(timeZone, referenceNow);
	const parsed = chrono.parse(text, {
		instant: referenceNow,
		timezone: offsetMinutes,
	});

	return parsed.map((result) => ({
		label: result.text,
		date: result.start.date(),
	}));
}

/**
 * Offset of `timeZone` at `instant`, in positive minutes east of UTC.
 * Chrono's `ParsingReference.timezone` uses this convention.
 *
 * `Intl.DateTimeFormat` with `timeZoneName: 'longOffset'` emits a part like
 * `GMT-07:00` (PDT) or `GMT+09:00` (JST). Parse it back to minutes.
 */
function getZoneOffsetMinutes(timeZone: IanaTimeZone, instant: Date): number {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone,
		timeZoneName: 'longOffset',
	}).formatToParts(instant);
	const offsetPart = parts.find((p) => p.type === 'timeZoneName')?.value;
	if (!offsetPart) return 0;

	const match = /(?:GMT|UTC)([+-])(\d{2}):?(\d{2})?/.exec(offsetPart);
	if (!match) return 0;
	const [, sign, hh, mm] = match;
	const magnitude = Number(hh) * 60 + Number(mm ?? 0);
	return sign === '-' ? -magnitude : magnitude;
}
