import { AnalyticsServiceLive } from '#platform/analytics';
import { DownloadServiceLive } from '#platform/download';
import { TextServiceLive } from '#platform/text';
import { LocalShortcutManagerLive } from './local-shortcut-manager';
import { PlaySoundServiceLive } from './sound';

/**
 * Cross-platform services.
 * These are available on both web and desktop.
 *
 * Blobs are not here. A blob store is one account's (ADR-0349), so it is built
 * per session and reached as `app.blobs`, never as a module-level value.
 */
export const services = {
	analytics: AnalyticsServiceLive,
	text: TextServiceLive,
	download: DownloadServiceLive,
	localShortcutManager: LocalShortcutManagerLive,
	sound: PlaySoundServiceLive,
} as const;
