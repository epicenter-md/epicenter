import { BLOB_ID_ROUTE_REGEX, type BlobId } from '@epicenter/blobs';
import {
	defineLens,
	defineTable,
	type RowFor,
} from '@epicenter/data/legacy';
import { field } from '@epicenter/field';
import { Type } from 'typebox';
import type { Static } from 'typebox';
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

export const whisperingSettingFields = {
	settings_sound_manualStart: field.boolean(), settings_sound_manualStop: field.boolean(), settings_sound_manualCancel: field.boolean(),
	settings_sound_vadStart: field.boolean(), settings_sound_vadCapture: field.boolean(), settings_sound_vadStop: field.boolean(),
	settings_sound_transcriptionComplete: field.boolean(), settings_sound_recipeComplete: field.boolean(),
	settings_output_transcription_clipboard: field.boolean(), settings_output_transcription_cursor: field.boolean(), settings_output_transcription_enter: field.boolean(),
	settings_output_recipe_clipboard: field.boolean(), settings_output_recipe_cursor: field.boolean(), settings_output_recipe_enter: field.boolean(),
	settings_recording_trigger: field.select(RECORDING_TRIGGERS), settings_recording_pausePlayback: field.boolean(), settings_recording_autoUpload: field.boolean(),
	settings_transcription_service: field.select(TRANSCRIPTION_SERVICE_IDS), settings_transcription_openai_model: field.string(), settings_transcription_groq_model: field.string(),
	settings_transcription_elevenlabs_model: field.string(), settings_transcription_deepgram_model: field.string(), settings_transcription_mistral_model: field.string(),
	settings_transcription_language: field.select(SUPPORTED_LANGUAGES), settings_transcription_prompt: field.string(),
	settings_completion_provider: field.select(INFERENCE_PROVIDER_IDS), settings_completion_model: field.string(), settings_dictionary: field.tags(),
	settings_polish_enabled: field.boolean(), settings_polish_instructions: field.string(), settings_analytics_enabled: field.boolean(),
	settings_shortcut_pushToTalk: field.json(KeyBindingSchema), settings_shortcut_toggleManualRecording: field.json(KeyBindingSchema), settings_shortcut_cancelRecording: field.json(KeyBindingSchema),
	settings_shortcut_toggleVadRecording: field.json(KeyBindingSchema), settings_shortcut_openRecipePicker: field.json(KeyBindingSchema), settings_shortcut_runRecipeOnClipboard: field.json(KeyBindingSchema), settings_shortcut_openSettings: field.json(KeyBindingSchema),
} as const;

type DottedSettingName<TName extends string> = TName extends `${infer Head}_${infer Tail}`
	? `${Head}.${DottedSettingName<Tail>}`
	: TName;

export type WhisperingSettingValues = {
	[K in keyof typeof whisperingSettingFields as K extends `settings_${infer Rest}`
		? `settings.${DottedSettingName<Rest>}`
		: never]: Static<(typeof whisperingSettingFields)[K]>;
};

/** The inert Whispering lens. Runtimes bind it to one Epicenter. */
export const whisperingLens = defineLens({
	namespace: 'so.epicenter.whispering',
	tables: {
		recordings: recordingsTable,
		recipes: recipesTable,
		settings: defineTable({ fields: whisperingSettingFields }),
	},
});

export const WHISPERING_SETTINGS_ROW_ID = 'settings';

/**
 * Whispering's dotted setting key spelled as the field it addresses.
 *
 * The fields above are the source of truth and the dotted keys are derived from
 * them, so the two cannot drift. This is Whispering's own ergonomics over its
 * own row, not a second durable name: nothing dotted reaches storage or the
 * wire.
 */
export function settingFieldName(
	key: keyof WhisperingSettingValues,
): keyof typeof whisperingSettingFields {
	return key.replaceAll('.', '_') as keyof typeof whisperingSettingFields;
}

/** The declared defaults as one complete settings row. */
export function whisperingSettingRow(
	values: WhisperingSettingValues,
): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(values).map(([key, value]) => [
			settingFieldName(key as keyof WhisperingSettingValues),
			value,
		]),
	);
}
