/**
 * Parse a workspace datetime string into a native Date.
 *
 * Workspace stores timestamps as `"YYYY-MM-DDTHH:mm:ss|counter"` — the
 * pipe-delimited counter is a Lamport clock for CRDT ordering and must
 * be stripped before parsing.
 *
 * @example
 * ```typescript
 * import { parseDateTime } from '$lib/utils/date';
 *
 * const date = parseDateTime(note.updatedAt);
 * format(date, 'h:mm a'); // "3:42 PM"
 * ```
 */
export function parseDateTime(dts: string): Date {
	return new Date(dts.split('|')[0]!);
}
