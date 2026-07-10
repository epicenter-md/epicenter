import { auth } from '$lib/platform/auth.browser';
import { os } from '$lib/platform/os.browser';
import { osNotify } from '$lib/report/os-notify.browser';
import { AudioBlobStoreLive } from '$lib/services/blob-store/index.browser';
import { DownloadServiceLive } from '$lib/services/download/index.browser';
import { ManualRecorderLive } from '$lib/services/recorder/index.browser';
import { TextServiceLive } from '$lib/services/text/index.browser';
import { manualRecorderConfig } from '$lib/state/manual-recorder-config.browser';
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
