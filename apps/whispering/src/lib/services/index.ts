import { AnalyticsServiceLive } from './analytics';
import { CommandServiceLive } from './command';
import * as completions from './completion';
import { DbServiceLive } from './db';
import { DownloadServiceLive } from './download';
import { FfmpegServiceLive } from './ffmpeg';
import { FsServiceLive } from './fs';
import { GlobalShortcutManagerLive } from './global-shortcut-manager';
import { LocalShortcutManagerLive } from './local-shortcut-manager';
import { NotificationServiceLive } from './notifications';
import { OsServiceLive } from './os';
import { PermissionsServiceLive } from './permissions';
import { CpalRecorderServiceLive } from './recorder/cpal';
import { NavigatorRecorderServiceLive } from './recorder/navigator';
import { FfmpegRecorderServiceLive } from './recorder/ffmpeg';
import { PlaySoundServiceLive } from './sound';
import { TextServiceLive } from './text';
import { ToastServiceLive } from './toast';
import * as transcriptions from './transcription';
import { TrayIconServiceLive } from './tray';
import { VadServiceLive } from './vad-recorder';

/**
 * Unified services object providing consistent access to all services.
 */
export {
	AnalyticsServiceLive as analytics,
	TextServiceLive as text,
	CommandServiceLive as command,
	completions,
	TrayIconServiceLive as tray,
	DbServiceLive as db,
	DownloadServiceLive as download,
	FfmpegServiceLive as ffmpeg,
	FsServiceLive as fs,
	GlobalShortcutManagerLive as globalShortcutManager,
	LocalShortcutManagerLive as localShortcutManager,
	NotificationServiceLive as notification,
	CpalRecorderServiceLive as cpalRecorder,
	NavigatorRecorderServiceLive as navigatorRecorder,
	FfmpegRecorderServiceLive as ffmpegRecorder,
	PermissionsServiceLive as permissions,
	ToastServiceLive as toast,
	OsServiceLive as os,
	PlaySoundServiceLive as sound,
	transcriptions,
	VadServiceLive as vad,
};
