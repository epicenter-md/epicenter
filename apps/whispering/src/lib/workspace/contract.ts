import { BLOB_ID_ROUTE_REGEX, type BlobId } from '@epicenter/blobs';
import {
	defineLens,
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
	'settings.sound.manualStart': defineValue({
		value: field.boolean(),
	}),
	'settings.sound.manualStop': defineValue({
		value: field.boolean(),
	}),
	'settings.sound.manualCancel': defineValue({
		value: field.boolean(),
	}),
	'settings.sound.vadStart': defineValue({
		value: field.boolean(),
	}),
	'settings.sound.vadCapture': defineValue({
		value: field.boolean(),
	}),
	'settings.sound.vadStop': defineValue({
		value: field.boolean(),
	}),
	'settings.sound.transcriptionComplete': defineValue({
		value: field.boolean(),
	}),
	'settings.sound.recipeComplete': defineValue({
		value: field.boolean(),
	}),
	'settings.output.transcription.clipboard': defineValue({
		value: field.boolean(),
	}),
	'settings.output.transcription.cursor': defineValue({
		value: field.boolean(),
	}),
	'settings.output.transcription.enter': defineValue({
		value: field.boolean(),
	}),
	'settings.output.recipe.clipboard': defineValue({
		value: field.boolean(),
	}),
	'settings.output.recipe.cursor': defineValue({
		value: field.boolean(),
	}),
	'settings.output.recipe.enter': defineValue({
		value: field.boolean(),
	}),
	'settings.recording.trigger': defineValue({
		value: field.select(RECORDING_TRIGGERS),
	}),
	'settings.recording.pausePlayback': defineValue({
		value: field.boolean(),
	}),
	'settings.recording.autoUpload': defineValue({
		value: field.boolean(),
	}),
	'settings.transcription.service': defineValue({
		value: field.select(TRANSCRIPTION_SERVICE_IDS),
	}),
	'settings.transcription.openai.model': defineValue({
		value: field.string(),
	}),
	'settings.transcription.groq.model': defineValue({
		value: field.string(),
	}),
	'settings.transcription.elevenlabs.model': defineValue({
		value: field.string(),
	}),
	'settings.transcription.deepgram.model': defineValue({
		value: field.string(),
	}),
	'settings.transcription.mistral.model': defineValue({
		value: field.string(),
	}),
	'settings.transcription.language': defineValue({
		value: field.select(SUPPORTED_LANGUAGES),
	}),
	'settings.transcription.prompt': defineValue({
		value: field.string(),
	}),
	'settings.completion.provider': defineValue({
		value: field.select(INFERENCE_PROVIDER_IDS),
	}),
	'settings.completion.model': defineValue({
		value: field.string(),
	}),
	'settings.dictionary': defineValue({
		value: field.tags(),
	}),
	'settings.polish.enabled': defineValue({
		value: field.boolean(),
	}),
	'settings.polish.instructions': defineValue({
		value: field.string(),
	}),
	'settings.analytics.enabled': defineValue({
		value: field.boolean(),
	}),
	'settings.shortcut.pushToTalk': defineValue({
		value: field.json(KeyBindingSchema),
	}),
	'settings.shortcut.toggleManualRecording': defineValue({
		value: field.json(KeyBindingSchema),
	}),
	'settings.shortcut.cancelRecording': defineValue({
		value: field.json(KeyBindingSchema),
	}),
	'settings.shortcut.toggleVadRecording': defineValue({
		value: field.json(KeyBindingSchema),
	}),
	'settings.shortcut.openRecipePicker': defineValue({
		value: field.json(KeyBindingSchema),
	}),
	'settings.shortcut.runRecipeOnClipboard': defineValue({
		value: field.json(KeyBindingSchema),
	}),
	'settings.shortcut.openSettings': defineValue({
		value: field.json(KeyBindingSchema),
	}),
} as const;

export type WhisperingSettingValues = {
	[K in keyof typeof whisperingSettingValues]: ValueFor<
		(typeof whisperingSettingValues)[K]
	>;
};

/** The inert Whispering lens. Runtimes bind it to one Epicenter. */
export const whisperingLens = defineLens({
	namespace: 'so.epicenter.whispering',
	tables: { recordings: recordingsTable, recipes: recipesTable },
	values: whisperingSettingValues,
});
