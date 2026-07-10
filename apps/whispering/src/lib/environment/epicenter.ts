import { desktop } from '#desktop';
import { createEpicenterTranscription } from '$lib/operations/transcribe.epicenter';
import { createTranscriptionUseCase } from '$lib/operations/transcription-use-case';
import type { TranscriptionServiceId } from '$lib/services/transcription/providers';
import { createLocalModels } from '$lib/state/local-models.svelte';
import { baseEnvironment } from './base.epicenter';
import type { WhisperingEnvironment } from './contract';

const providers = [
	'local',
] as const satisfies readonly TranscriptionServiceId[];
const transcriptionEngine = createEpicenterTranscription(
	desktop.localTranscription,
);

export const environment: WhisperingEnvironment = {
	...baseEnvironment,
	transcription: {
		providers,
		transcribeAndPersist: createTranscriptionUseCase(transcriptionEngine),
		prewarmSelectedModel: transcriptionEngine.prewarmSelectedModel,
		localModels: createLocalModels(desktop.localTranscription),
	},
};
