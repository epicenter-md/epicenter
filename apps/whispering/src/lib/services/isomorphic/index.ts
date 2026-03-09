import { AnalyticsServiceLive } from './analytics';
import * as completions from './completion';
import { ConfigExportService } from './config-export';
import { DbServiceLive } from './db';
import { DownloadServiceLive } from './download';
import { LocalShortcutManagerLive } from './local-shortcut-manager';
import { NotificationServiceLive } from './notifications';
import { OsServiceLive } from './os';
import { NavigatorRecorderServiceLive } from './recorder/navigator';
import { PlaySoundServiceLive } from './sound';
import { TextServiceLive } from './text';
import { ToastServiceLive } from './toast';
import * as transcriptions from './transcription';

/**
 * Cross-platform services.
 * These are available on both web and desktop.
 */
export const services = {
	analytics: AnalyticsServiceLive,
	text: TextServiceLive,
	completions,
	configExport: ConfigExportService.create({ db: DbServiceLive }),
	db: DbServiceLive,
	download: DownloadServiceLive,
	localShortcutManager: LocalShortcutManagerLive,
	notification: NotificationServiceLive,
	navigatorRecorder: NavigatorRecorderServiceLive,
	toast: ToastServiceLive,
	os: OsServiceLive,
	sound: PlaySoundServiceLive,
	transcriptions,
} as const;
