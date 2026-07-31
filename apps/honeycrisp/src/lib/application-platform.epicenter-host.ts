import { openDesktopEpicenter } from '@epicenter/data/desktop';
import { createLogger } from 'wellcrafted/logger';
import type { HoneycrispDependencies } from './application.js';

const log = createLogger('honeycrisp/application');

/**
 * Dependencies for the build the desktop Epicenter host serves.
 *
 * This build opens the host-owned replica rather than one of its own, so
 * Honeycrisp's folders, notes, and note documents live in the same
 * `epicenter.sqlite3` every other trusted surface writes to, kept apart by the
 * `so.epicenter.honeycrisp` namespace its Lens declares. Sync belongs to the
 * host process for the same reason: a window that attached its own would be a
 * second writer to one replica.
 *
 * Only the host ever serves this build, and it is selected by the
 * `epicenter-host` resolve condition, so "am I hosted" is answered by which file
 * compiled and never has to be asked of the DOM at runtime.
 */
export const honeycrispPlatform: HoneycrispDependencies = {
	openEpicenter: openDesktopEpicenter,
	reportBackgroundError: (cause) =>
		log.warn(new Error('Honeycrisp background refresh failed', { cause })),
};
