import { defineErrors } from 'wellcrafted/error';
import type { DesktopLocalTranscription } from '$lib/desktop/contract';
import { PROVIDERS } from '$lib/services/transcription/providers';
import { deviceConfig } from '$lib/state/device-config.svelte';
import { settings } from '$lib/state/settings.svelte';
import type { TranscriptionEngine } from './transcription-use-case';

const LocalTranscriptionError = defineErrors({
	ModelNotSelected: () => ({
		message: 'Please select a local model in settings.',
	}),
	ProviderUnavailable: () => ({
		message: 'Select local transcription for this Epicenter build.',
	}),
});

function withDictionaryTerms(prompt: string, dictionary: string[]): string {
	if (dictionary.length === 0) return prompt;
	const glossary = dictionary.join(', ');
	const trimmed = prompt.trim();
	return trimmed ? `${trimmed} ${glossary}` : glossary;
}

export function createEpicenterTranscription(
	local: DesktopLocalTranscription,
): TranscriptionEngine & { prewarmSelectedModel(): void } {
	function modelId() {
		return deviceConfig.get(PROVIDERS.local.modelConfigKey);
	}

	return {
		async transcribe(recordingId) {
			if (settings.get('transcription.service') !== 'local') {
				return LocalTranscriptionError.ProviderUnavailable();
			}
			const selectedModel = modelId();
			if (!selectedModel) return LocalTranscriptionError.ModelNotSelected();
			return local.transcribe(recordingId, {
				modelId: selectedModel,
				language:
					settings.get('transcription.language') === 'auto'
						? null
						: settings.get('transcription.language'),
				initialPrompt: withDictionaryTerms(
					settings.get('transcription.prompt'),
					settings.get('dictionary'),
				),
			});
		},
		prewarmSelectedModel() {
			if (settings.get('transcription.service') !== 'local') return;
			const selectedModel = modelId();
			if (!selectedModel) return;
			void local.prewarm({
				modelId: selectedModel,
				language: null,
				initialPrompt: null,
			});
		},
	};
}
