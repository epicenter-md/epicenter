import { auth } from '$lib/platform/auth.tauri';
import { os } from '$lib/platform/os.tauri';
import { reportRecordingMicLevel } from '$lib/recording-overlay/mic-level.tauri';
import { osNotify } from '$lib/report/os-notify.tauri';
import { AudioBlobStoreLive } from '$lib/services/blob-store/index.tauri';
import { DownloadServiceLive } from '$lib/services/download/index.tauri';
import { ManualRecorderLive } from '$lib/services/recorder/index.tauri';
import { TextServiceLive } from '$lib/services/text/index.tauri';
import { manualRecorderConfig } from '$lib/state/manual-recorder-config.tauri';
import type { WhisperingBaseEnvironment } from './contract';
import { createManualRecordingEnvironment } from './create-manual-recording-environment';

export const baseEnvironment: WhisperingBaseEnvironment = {
	auth,
	artifacts: AudioBlobStoreLive,
	captureSurfaces: ['manual'],
	downloads: DownloadServiceLive,
	delivery: desktop.delivery,
	notifications: osNotify,
	os,
	recording: createManualRecordingEnvironment({
		recorder: ManualRecorderLive,
		config: manualRecorderConfig,
		reportLevel: reportRecordingMicLevel,
	}),
	text: TextServiceLive,
};

export const defaultTranscriptionService = 'local' as const;
import { desktop } from '#desktop';
