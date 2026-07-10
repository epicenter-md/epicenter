import { auth } from '$lib/platform/auth.tauri';
import { os } from '$lib/platform/os.tauri';
import { osNotify } from '$lib/report/os-notify.tauri';
import { AudioBlobStoreLive } from '$lib/services/blob-store/index.tauri';
import { DownloadServiceLive } from '$lib/services/download/index.tauri';
import { ManualRecorderLive } from '$lib/services/recorder/index.tauri';
import { TextServiceLive } from '$lib/services/text/index.tauri';
import { manualRecorderConfig } from '$lib/state/manual-recorder-config.tauri';
import type { WhisperingEnvironment } from './contract';
import { createManualRecordingEnvironment } from './create-manual-recording-environment';

export const environment: WhisperingEnvironment = {
	auth,
	artifacts: AudioBlobStoreLive,
	downloads: DownloadServiceLive,
	notifications: osNotify,
	os,
	recording: createManualRecordingEnvironment({
		recorder: ManualRecorderLive,
		config: manualRecorderConfig,
	}),
	text: TextServiceLive,
};
