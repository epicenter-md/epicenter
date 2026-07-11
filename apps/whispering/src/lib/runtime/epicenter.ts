import { createNodeId } from '@epicenter/workspace';
import { desktop } from '#desktop';
import type { WhisperingEnvironment } from '$lib/environment/contract';
import { createManualRecordingEnvironment } from '$lib/environment/create-manual-recording-environment';
import { createEpicenterTranscription } from '$lib/operations/transcribe.epicenter';
import type { TranscriptionSettings } from '$lib/operations/transcription-ports';
import { createTranscriptionUseCase } from '$lib/operations/transcription-use-case';
import { auth } from '$lib/platform/auth.tauri';
import { os } from '$lib/platform/os.tauri';
import { osNotify } from '$lib/report/os-notify.tauri';
import { AudioBlobStoreLive } from '$lib/services/blob-store/index.tauri';
import { DownloadServiceLive } from '$lib/services/download/index.tauri';
import { ManualRecorderLive } from '$lib/services/recorder/index.tauri';
import { TextServiceLive } from '$lib/services/text/index.tauri';
import type { TranscriptionServiceId } from '$lib/services/transcription/providers';
import { createLocalModels } from '$lib/state/local-models.svelte';
import { manualRecorderConfig } from '$lib/state/manual-recorder-config.tauri';
import { openWhisperingBrowser } from '$lib/workspace/browser';

export const whispering = openWhisperingBrowser({
	auth,
	nodeId: createNodeId({ storage: window.localStorage }),
	defaultTranscriptionService: 'local',
	downloads: DownloadServiceLive,
});

const providers = [
	'local',
] as const satisfies readonly TranscriptionServiceId[];
const transcriptionSettings = {
	service: () => whispering.kv.get('transcription.service'),
	language: () => whispering.kv.get('transcription.language'),
	prompt: () => whispering.kv.get('transcription.prompt'),
	dictionary: () => whispering.kv.get('dictionary'),
	model: (key) => whispering.kv.get(key),
} satisfies TranscriptionSettings;
const transcriptionEngine = createEpicenterTranscription(
	desktop.localTranscription,
	transcriptionSettings,
);

export const environment: WhisperingEnvironment = {
	auth,
	artifacts: AudioBlobStoreLive,
	canSuppressPlayback: true,
	captureSurfaces: ['manual'],
	downloads: DownloadServiceLive,
	delivery: desktop.delivery,
	notifications: osNotify,
	os,
	recording: createManualRecordingEnvironment({
		recorder: ManualRecorderLive,
		config: manualRecorderConfig,
		configuration: 'sampleRate',
		reportLevel() {},
	}),
	text: TextServiceLive,
	transcription: {
		providers,
		transcribeAndPersist: createTranscriptionUseCase(
			transcriptionEngine,
			whispering.tables.recordings,
		),
		prewarmSelectedModel: transcriptionEngine.prewarmSelectedModel,
		localModels: createLocalModels(desktop.localTranscription),
	},
};
