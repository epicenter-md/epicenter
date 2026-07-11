import { consoleSink, type LogEvent } from 'wellcrafted/logger';

export const SOURCE = 'whispering/report';

/**
 * Diagnostic-only logger. Use for events that should appear in console for
 * debugging but should NEVER surface to the user as a toast or OS notification
 * (e.g. "Recording started", "Invalid device config, using default").
 *
 * This module is a leaf on purpose: unlike `report`, it reads nothing from
 * `#runtime`, so the runtime composition roots may import it without a cycle.
 */
export const log = {
	info(message: string, data?: unknown): void {
		consoleSink({
			ts: Date.now(),
			level: 'info',
			source: SOURCE,
			message,
			data,
		} satisfies LogEvent);
	},
	warn(error: Error, data?: unknown): void {
		consoleSink({
			ts: Date.now(),
			level: 'warn',
			source: SOURCE,
			message: error.message,
			data: data ?? error,
		} satisfies LogEvent);
	},
} as const;
