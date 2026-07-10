import { auth } from '$lib/platform/auth.browser';
import { os } from '$lib/platform/os.browser';
import { reportRecordingMicLevel } from '$lib/recording-pill/mic-level.browser';
import { osNotify } from '$lib/report/os-notify.browser';
import { AudioBlobStoreLive } from '$lib/services/blob-store/index.browser';
import { DownloadServiceLive } from '$lib/services/download/index.browser';
import { ManualRecorderLive } from '$lib/services/recorder/index.browser';
import { TextServiceLive } from '$lib/services/text/index.browser';
import { TextError } from '$lib/services/text/types';
import { manualRecorderConfig } from '$lib/state/manual-recorder-config.browser';
import type { WhisperingBaseEnvironment } from './contract';
import { createManualRecordingEnvironment } from './create-manual-recording-environment';

export const baseEnvironment: WhisperingBaseEnvironment = {
	auth,
	artifacts: AudioBlobStoreLive,
	captureSurfaces: ['manual', 'vad', 'import'],
	downloads: DownloadServiceLive,
	delivery: {
		async write(text) {
			const result = await TextServiceLive.copyToClipboard(text);
			return result.error ? result : Ok('leftOnClipboard');
		},
		async pressEnter() {
			return TextError.NotSupported({ operation: 'Simulating keystrokes' });
		},
		async copySelection() {
			return TextError.NotSupported({ operation: 'Simulating keystrokes' });
		},
	},
	notifications: osNotify,
	os,
	recording: createManualRecordingEnvironment({
		recorder: ManualRecorderLive,
		config: manualRecorderConfig,
		reportLevel: reportRecordingMicLevel,
	}),
	text: TextServiceLive,
};

export const defaultTranscriptionService = 'OpenAI' as const;
import { Ok } from 'wellcrafted/result';
