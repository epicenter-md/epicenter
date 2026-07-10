import { desktop } from '#desktop';
import { createTranscriptionEnvironment } from '$lib/operations/transcribe';
import type { TranscriptionServiceId } from '$lib/services/transcription/providers';
import { createLocalModels } from '$lib/state/local-models.svelte';
import { baseEnvironment } from './base.epicenter';
import type { WhisperingEnvironment } from './contract';

const providers = [
	'local',
] as const satisfies readonly TranscriptionServiceId[];

export const environment: WhisperingEnvironment = {
	...baseEnvironment,
	transcription: {
		...createTranscriptionEnvironment({
			auth: baseEnvironment.auth,
			artifacts: baseEnvironment.artifacts,
			cloudTransport: null,
			localTranscription: desktop.localTranscription,
			providers,
		}),
		localModels: createLocalModels(desktop.localTranscription),
	},
};
