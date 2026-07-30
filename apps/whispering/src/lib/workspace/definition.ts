import {
	PROVIDERS,
	type TranscriptionServiceId,
} from '../services/transcription/providers';
import type { KeyBinding } from '../utils/key-binding';
import type { WhisperingSettingValues } from './contract';

export * from './contract';

const EMPTY_BINDING: KeyBinding = { modifiers: [], keys: [] };

/** Product defaults are release-local policy, never persisted document schema. */
export function createWhisperingSettingDefaults(
	defaultTranscriptionService: TranscriptionServiceId,
): WhisperingSettingValues {
	return {
		'settings.sound.manualStart': true,
		'settings.sound.manualStop': true,
		'settings.sound.manualCancel': true,
		'settings.sound.vadStart': true,
		'settings.sound.vadCapture': true,
		'settings.sound.vadStop': true,
		'settings.sound.transcriptionComplete': true,
		'settings.sound.recipeComplete': true,
		'settings.output.transcription.clipboard': true,
		'settings.output.transcription.cursor': false,
		'settings.output.transcription.enter': false,
		'settings.output.recipe.clipboard': true,
		'settings.output.recipe.cursor': false,
		'settings.output.recipe.enter': false,
		'settings.recording.trigger': 'manual',
		'settings.recording.pausePlayback': false,
		'settings.recording.autoUpload': false,
		'settings.transcription.service': defaultTranscriptionService,
		'settings.transcription.openai.model': PROVIDERS.OpenAI.defaultModel,
		'settings.transcription.groq.model': PROVIDERS.Groq.defaultModel,
		'settings.transcription.elevenlabs.model':
			PROVIDERS.ElevenLabs.defaultModel,
		'settings.transcription.deepgram.model': PROVIDERS.Deepgram.defaultModel,
		'settings.transcription.mistral.model': PROVIDERS.Mistral.defaultModel,
		'settings.transcription.language': 'auto',
		'settings.transcription.prompt': '',
		'settings.completion.provider': 'Google',
		'settings.completion.model': 'gemini-2.5-flash',
		'settings.dictionary': [],
		'settings.polish.enabled': true,
		'settings.polish.instructions':
			'Fix grammar and punctuation. Keep my wording.',
		'settings.analytics.enabled': true,
		'settings.shortcut.pushToTalk': EMPTY_BINDING,
		'settings.shortcut.toggleManualRecording': {
			modifiers: [],
			keys: ['space'],
		},
		'settings.shortcut.cancelRecording': { modifiers: [], keys: ['keyC'] },
		'settings.shortcut.toggleVadRecording': { modifiers: [], keys: ['keyV'] },
		'settings.shortcut.openRecipePicker': { modifiers: [], keys: ['keyT'] },
		'settings.shortcut.runRecipeOnClipboard': { modifiers: [], keys: ['keyR'] },
		'settings.shortcut.openSettings': { modifiers: ['meta'], keys: ['comma'] },
	};
}
