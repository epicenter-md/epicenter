/**
 * Shared date/time formatting utilities for Fuji.
 *
 * Centralizes `DateTimeString` → display string conversions so
 * components don't duplicate formatting logic.
 */

import { formatDistanceToNowStrict } from 'date-fns';
import type { IanaTimeZone } from '@epicenter/workspace';

/**
 * Format a `DateTimeString` as a human-readable relative time, e.g.
 * "3 minutes ago", "2 days ago".
 */
export function relativeTime(dts: string): string {
	return formatDistanceToNowStrict(new Date(dts), {
		addSuffix: true,
	});
}

/**
 * Format a UTC ISO `date` in the given IANA `zone` for display.
 * Renders the user's local wall-clock time (e.g. "May 25, 2026, 2:30 PM").
 */
export function formatInZone(date: string, zone: IanaTimeZone): string {
	return new Intl.DateTimeFormat('en-US', {
		timeZone: zone,
		month: 'short',
		day: 'numeric',
		year: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
		hour12: true,
	}).format(new Date(date));
}
