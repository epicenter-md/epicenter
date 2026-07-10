import { createBrowserTranscription } from '$lib/operations/transcribe.browser';
import { createTranscriptionUseCase } from '$lib/operations/transcription-use-case';
import { customFetch, HttpServiceLive } from '$lib/services/http/index.browser';
import type { TranscriptionServiceId } from '$lib/services/transcription/providers';
import { createLocalModels } from '$lib/state/local-models.svelte';
import { baseEnvironment } from './base.browser';
import type { WhisperingEnvironment } from './contract';

const providers = [
	'epicenter',
	'OpenAI',
	'Groq',
	'ElevenLabs',
	'Deepgram',
	'Mistral',
	'speaches',
] as const satisfies readonly TranscriptionServiceId[];
const transcriptionEngine = createBrowserTranscription({
	auth: baseEnvironment.auth,
	artifacts: baseEnvironment.artifacts,
	cloudTransport: { fetch: customFetch, http: HttpServiceLive },
});

export const environment: WhisperingEnvironment = {
	...baseEnvironment,
	transcription: {
		transcribeAndPersist: createTranscriptionUseCase(transcriptionEngine),
		prewarmSelectedModel() {},
		providers,
		localModels: createLocalModels(null),
	},
};
