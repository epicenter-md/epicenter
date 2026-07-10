import { createTranscriptionEnvironment } from '$lib/operations/transcribe';
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

export const environment: WhisperingEnvironment = {
	...baseEnvironment,
	transcription: {
		...createTranscriptionEnvironment({
			auth: baseEnvironment.auth,
			artifacts: baseEnvironment.artifacts,
			cloudTransport: { fetch: customFetch, http: HttpServiceLive },
			localTranscription: null,
			providers,
		}),
		localModels: createLocalModels(null),
	},
};
