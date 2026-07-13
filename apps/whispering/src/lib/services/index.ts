import { environment } from '#runtime';
import { LocalShortcutManagerLive } from './local-shortcut-manager';
import { PlaySoundServiceLive } from './sound';

/**
 * Cross-platform services.
 * These are available on both web and desktop.
 */
export const services = {
	text: environment.text,
	blobs: { audio: environment.artifacts },
	download: environment.downloads,
	localShortcutManager: LocalShortcutManagerLive,
	sound: PlaySoundServiceLive,
} as const;
