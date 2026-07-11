import { createNodeId } from '@epicenter/workspace';
import { Ok } from 'wellcrafted/result';
import type { WhisperingEnvironment } from '$lib/environment/contract';
import { createManualRecordingEnvironment } from '$lib/environment/create-manual-recording-environment';
import { createBrowserTranscription } from '$lib/operations/transcribe.browser';
import type { TranscriptionSettings } from '$lib/operations/transcription-ports';
import { createTranscriptionUseCase } from '$lib/operations/transcription-use-case';
import { auth } from '$lib/platform/auth.browser';
import { reportRecordingMicLevel } from '$lib/recording-pill/mic-level.browser';
import { osNotify } from '$lib/report/os-notify.browser';
import { AudioBlobStoreLive } from '$lib/services/blob-store/index.browser';
import { DownloadServiceLive } from '$lib/services/download/index.browser';
import { customFetch, HttpServiceLive } from '$lib/services/http/index.browser';
import { ManualRecorderLive } from '$lib/services/recorder/index.browser';
import { TextServiceLive } from '$lib/services/text/index.browser';
import { TextError } from '$lib/services/text/types';
import type { TranscriptionServiceId } from '$lib/services/transcription/providers';
import { createLocalModels } from '$lib/state/local-models.svelte';
import { manualRecorderConfig } from '$lib/state/manual-recorder-config.browser';
import { openWhisperingBrowser } from '$lib/workspace/browser';

export const whispering = openWhisperingBrowser({
	auth,
	nodeId: createNodeId({ storage: window.localStorage }),
	defaultTranscriptionService: 'OpenAI',
	downloads: DownloadServiceLive,
});

const providers = [
	'epicenter',
	'OpenAI',
	'Groq',
	'ElevenLabs',
	'Deepgram',
	'Mistral',
	'speaches',
] as const satisfies readonly TranscriptionServiceId[];
const transcriptionSettings = {
	service: () => whispering.kv.get('transcription.service'),
	language: () => whispering.kv.get('transcription.language'),
	prompt: () => whispering.kv.get('transcription.prompt'),
	dictionary: () => whispering.kv.get('dictionary'),
	model: (key) => whispering.kv.get(key),
} satisfies TranscriptionSettings;
const transcriptionEngine = createBrowserTranscription({
	auth,
	artifacts: AudioBlobStoreLive,
	cloudTransport: { fetch: customFetch, http: HttpServiceLive },
	settings: transcriptionSettings,
});

export const environment: WhisperingEnvironment = {
	auth,
	artifacts: AudioBlobStoreLive,
	captureSurfaces: ['manual', 'vad', 'import'],
	downloads: DownloadServiceLive,
	delivery: {
		supportsCursor: false,
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
	// Browsers cannot touch other apps' audio, so both verbs are no-ops.
	playback: {
		canSuppress: false,
		async begin() {},
		async end() {},
	},
	recording: createManualRecordingEnvironment({
		recorder: ManualRecorderLive,
		config: manualRecorderConfig,
		configuration: 'bitrate',
		reportLevel: reportRecordingMicLevel,
	}),
	text: TextServiceLive,
	transcription: {
		transcribeAndPersist: createTranscriptionUseCase(
			transcriptionEngine,
			whispering.tables.recordings,
		),
		prewarmSelectedModel() {},
		providers,
		localModels: createLocalModels(null),
	},
};
