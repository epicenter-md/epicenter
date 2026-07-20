import { BLOB_ID_ROUTE_REGEX, type BlobId } from '@epicenter/blobs';
import {
	defineTable,
	defineValue,
	type RowFor,
	type ValueFor,
} from '@epicenter/data';
import { field } from '@epicenter/field';
import { Type } from 'typebox';
import type { Brand } from 'wellcrafted/brand';
import { RECORDING_TRIGGERS } from '../constants/audio/recording-triggers';
import { INFERENCE_PROVIDER_IDS } from '../constants/inference-provider-ids';
import { SUPPORTED_LANGUAGES } from '../constants/languages';
import { TRANSCRIPTION_SERVICE_IDS } from '../services/transcription/provider-ids';

const TranscriptionOutcome = Type.Union([
	Type.Object({
		status: Type.Literal('completed'),
		completedAt: field.instant(),
	}),
	Type.Object({
		status: Type.Literal('failed'),
		completedAt: field.instant(),
		error: Type.String(),
	}),
]);

export const recordingsTable = defineTable({
	key: 'so.epicenter.whispering.recordings',
	fields: {
		/** Opaque local and remote identity for this recording's immutable audio. */
		audioBlobId: field.string<BlobId>({ pattern: `^${BLOB_ID_ROUTE_REGEX}$` }),
		/** Set only after a future explicit replica upload succeeds. */
		uploadedAt: field.json(Type.Union([field.instant(), Type.Null()])),
		title: field.string(),
		recordedAt: field.instant(),
		recordedAtZone: field.string(),
		transcript: field.string(),
		polishedTranscript: field.json(Type.Union([Type.String(), Type.Null()])),
		duration: field.json(Type.Union([Type.Number(), Type.Null()])),
		transcription: field.json(Type.Union([TranscriptionOutcome, Type.Null()])),
	},
});

type RecordingRow = RowFor<typeof recordingsTable>;

/** Structural data identity, independent from the recording's audio blob. */
export type RecordingId = string & Brand<'RecordingId'>;

export type Recording = Omit<RecordingRow, 'id'> & { id: RecordingId };

export const recipesTable = defineTable({
	key: 'so.epicenter.whispering.recipes',
	fields: {
		/** Stable portable recipe identity. The canonical record id stays structural. */
		sourceId: field.string(),
		name: field.string(),
		instructions: field.string(),
		icon: field.json(Type.Union([Type.String(), Type.Null()])),
	},
});

type RecipeRecord = RowFor<typeof recipesTable>;

/** App-facing recipe identity remains its portable source id. */
export type Recipe = Omit<RecipeRecord, 'id' | 'sourceId'> & { id: string };

const KeyBindingSchema = Type.Object({
	modifiers: Type.Array(
		Type.Union([
			Type.Literal('ctrl'),
			Type.Literal('alt'),
			Type.Literal('shift'),
			Type.Literal('meta'),
			Type.Literal('fn'),
		]),
	),
	keys: Type.Array(Type.String()),
});

/** Inert singleton definitions for every persisted Whispering setting. */
export const whisperingSettingValues = {
	'sound.manualStart': defineValue({
		key: 'so.epicenter.whispering.settings.sound.manual-start',
		value: field.boolean(),
	}),
	'sound.manualStop': defineValue({
		key: 'so.epicenter.whispering.settings.sound.manual-stop',
		value: field.boolean(),
	}),
	'sound.manualCancel': defineValue({
		key: 'so.epicenter.whispering.settings.sound.manual-cancel',
		value: field.boolean(),
	}),
	'sound.vadStart': defineValue({
		key: 'so.epicenter.whispering.settings.sound.vad-start',
		value: field.boolean(),
	}),
	'sound.vadCapture': defineValue({
		key: 'so.epicenter.whispering.settings.sound.vad-capture',
		value: field.boolean(),
	}),
	'sound.vadStop': defineValue({
		key: 'so.epicenter.whispering.settings.sound.vad-stop',
		value: field.boolean(),
	}),
	'sound.transcriptionComplete': defineValue({
		key: 'so.epicenter.whispering.settings.sound.transcription-complete',
		value: field.boolean(),
	}),
	'sound.recipeComplete': defineValue({
		key: 'so.epicenter.whispering.settings.sound.recipe-complete',
		value: field.boolean(),
	}),
	'output.transcription.clipboard': defineValue({
		key: 'so.epicenter.whispering.settings.output.transcription.clipboard',
		value: field.boolean(),
	}),
	'output.transcription.cursor': defineValue({
		key: 'so.epicenter.whispering.settings.output.transcription.cursor',
		value: field.boolean(),
	}),
	'output.transcription.enter': defineValue({
		key: 'so.epicenter.whispering.settings.output.transcription.enter',
		value: field.boolean(),
	}),
	'output.recipe.clipboard': defineValue({
		key: 'so.epicenter.whispering.settings.output.recipe.clipboard',
		value: field.boolean(),
	}),
	'output.recipe.cursor': defineValue({
		key: 'so.epicenter.whispering.settings.output.recipe.cursor',
		value: field.boolean(),
	}),
	'output.recipe.enter': defineValue({
		key: 'so.epicenter.whispering.settings.output.recipe.enter',
		value: field.boolean(),
	}),
	'recording.trigger': defineValue({
		key: 'so.epicenter.whispering.settings.recording.trigger',
		value: field.select(RECORDING_TRIGGERS),
	}),
	'recording.pausePlayback': defineValue({
		key: 'so.epicenter.whispering.settings.recording.pause-playback',
		value: field.boolean(),
	}),
	'recording.autoUpload': defineValue({
		key: 'so.epicenter.whispering.settings.recording.auto-upload',
		value: field.boolean(),
	}),
	'transcription.service': defineValue({
		key: 'so.epicenter.whispering.settings.transcription.service',
		value: field.select(TRANSCRIPTION_SERVICE_IDS),
	}),
	'transcription.openai.model': defineValue({
		key: 'so.epicenter.whispering.settings.transcription.openai.model',
		value: field.string(),
	}),
	'transcription.groq.model': defineValue({
		key: 'so.epicenter.whispering.settings.transcription.groq.model',
		value: field.string(),
	}),
	'transcription.elevenlabs.model': defineValue({
		key: 'so.epicenter.whispering.settings.transcription.elevenlabs.model',
		value: field.string(),
	}),
	'transcription.deepgram.model': defineValue({
		key: 'so.epicenter.whispering.settings.transcription.deepgram.model',
		value: field.string(),
	}),
	'transcription.mistral.model': defineValue({
		key: 'so.epicenter.whispering.settings.transcription.mistral.model',
		value: field.string(),
	}),
	'transcription.language': defineValue({
		key: 'so.epicenter.whispering.settings.transcription.language',
		value: field.select(SUPPORTED_LANGUAGES),
	}),
	'transcription.prompt': defineValue({
		key: 'so.epicenter.whispering.settings.transcription.prompt',
		value: field.string(),
	}),
	'completion.provider': defineValue({
		key: 'so.epicenter.whispering.settings.completion.provider',
		value: field.select(INFERENCE_PROVIDER_IDS),
	}),
	'completion.model': defineValue({
		key: 'so.epicenter.whispering.settings.completion.model',
		value: field.string(),
	}),
	dictionary: defineValue({
		key: 'so.epicenter.whispering.settings.dictionary',
		value: field.tags(),
	}),
	'polish.enabled': defineValue({
		key: 'so.epicenter.whispering.settings.polish.enabled',
		value: field.boolean(),
	}),
	'polish.instructions': defineValue({
		key: 'so.epicenter.whispering.settings.polish.instructions',
		value: field.string(),
	}),
	'analytics.enabled': defineValue({
		key: 'so.epicenter.whispering.settings.analytics.enabled',
		value: field.boolean(),
	}),
	'shortcut.pushToTalk': defineValue({
		key: 'so.epicenter.whispering.settings.shortcut.push-to-talk',
		value: field.json(KeyBindingSchema),
	}),
	'shortcut.toggleManualRecording': defineValue({
		key: 'so.epicenter.whispering.settings.shortcut.toggle-manual-recording',
		value: field.json(KeyBindingSchema),
	}),
	'shortcut.cancelRecording': defineValue({
		key: 'so.epicenter.whispering.settings.shortcut.cancel-recording',
		value: field.json(KeyBindingSchema),
	}),
	'shortcut.toggleVadRecording': defineValue({
		key: 'so.epicenter.whispering.settings.shortcut.toggle-vad-recording',
		value: field.json(KeyBindingSchema),
	}),
	'shortcut.openRecipePicker': defineValue({
		key: 'so.epicenter.whispering.settings.shortcut.open-recipe-picker',
		value: field.json(KeyBindingSchema),
	}),
	'shortcut.runRecipeOnClipboard': defineValue({
		key: 'so.epicenter.whispering.settings.shortcut.run-recipe-on-clipboard',
		value: field.json(KeyBindingSchema),
	}),
	'shortcut.openSettings': defineValue({
		key: 'so.epicenter.whispering.settings.shortcut.open-settings',
		value: field.json(KeyBindingSchema),
	}),
} as const;

export type WhisperingSettingValues = {
	[K in keyof typeof whisperingSettingValues]: ValueFor<
		(typeof whisperingSettingValues)[K]
	>;
};

/** The inert Whispering definitions. Runtimes bind them to one Epicenter. */
export const whisperingDefinitions = {
	tables: { recordings: recordingsTable, recipes: recipesTable },
	values: whisperingSettingValues,
} as const;
