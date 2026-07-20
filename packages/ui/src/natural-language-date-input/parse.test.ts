/**
 * Natural-language date parsing tests.
 *
 * Key behaviors:
 * - Wall-clock phrases resolve in the selected IANA zone
 * - Relative-hour phrases remain zone-independent
 */

import { describe, expect, it } from 'bun:test';
import type { IanaTimeZone } from './iana-time-zone.js';
import { parseInZone } from './parse.js';

const LA = 'America/Los_Angeles' as IanaTimeZone;
const NY = 'America/New_York' as IanaTimeZone;
const TOKYO = 'Asia/Tokyo' as IanaTimeZone;

describe('parseInZone', () => {
	it('returns no suggestions for empty input', () => {
		expect(
			parseInZone({
				text: '',
				referenceNow: new Date('2026-05-25T17:00:00Z'),
				timeZone: LA,
			}),
		).toEqual([]);
	});

	it('resolves "tomorrow at 5pm" in Los Angeles (PDT, UTC-7)', () => {
		// 2026-05-25 17:00 UTC = 2026-05-25 10:00 PDT, so "tomorrow 5pm PDT"
		// = 2026-05-26 17:00 PDT = 2026-05-27 00:00 UTC.
		const out = parseInZone({
			text: 'tomorrow at 5pm',
			referenceNow: new Date('2026-05-25T17:00:00Z'),
			timeZone: LA,
		});
		expect(out).toHaveLength(1);
		expect(out[0]?.date.toISOString()).toBe('2026-05-27T00:00:00.000Z');
	});

	it('resolves "tomorrow at 5pm" in New York (EDT, UTC-4)', () => {
		// "tomorrow 5pm EDT" = 2026-05-26 17:00 EDT = 2026-05-26 21:00 UTC.
		const out = parseInZone({
			text: 'tomorrow at 5pm',
			referenceNow: new Date('2026-05-25T17:00:00Z'),
			timeZone: NY,
		});
		expect(out).toHaveLength(1);
		expect(out[0]?.date.toISOString()).toBe('2026-05-26T21:00:00.000Z');
	});

	it('resolves "tomorrow at 5pm" in Tokyo (JST, UTC+9)', () => {
		// 2026-05-25 17:00 UTC = 2026-05-26 02:00 JST, so "tomorrow" in JST
		// is 2026-05-27. "tomorrow 5pm JST" = 2026-05-27 17:00 JST
		// = 2026-05-27 08:00 UTC.
		const out = parseInZone({
			text: 'tomorrow at 5pm',
			referenceNow: new Date('2026-05-25T17:00:00Z'),
			timeZone: TOKYO,
		});
		expect(out).toHaveLength(1);
		expect(out[0]?.date.toISOString()).toBe('2026-05-27T08:00:00.000Z');
	});

	it('treats "in 2 hours" as relative to referenceNow regardless of zone', () => {
		const referenceNow = new Date('2026-05-25T17:00:00Z');
		const inLA = parseInZone({
			text: 'in 2 hours',
			referenceNow,
			timeZone: LA,
		});
		const inTokyo = parseInZone({
			text: 'in 2 hours',
			referenceNow,
			timeZone: TOKYO,
		});
		expect(inLA[0]?.date.toISOString()).toBe('2026-05-25T19:00:00.000Z');
		expect(inTokyo[0]?.date.toISOString()).toBe('2026-05-25T19:00:00.000Z');
	});
});
