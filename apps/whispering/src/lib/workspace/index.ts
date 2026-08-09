/**
 * Whispering's inert Lens.
 *
 * Pure JSON: arktype expressions for the fields and nothing that knows about
 * storage, sync or documents (ADR-0213). Runtimes own all of that.
 *
 * Three things about this file are decisions rather than transcription of the
 * old contract, and each is load-bearing.
 *
 * **Settings live in `kv`, not in a table.** They used to be one row at the
 * chosen id `'settings'`. A chosen row id is a nested container addressed by
 * the operation that created it, so two devices both writing settings on their
 * own boot path create two containers and map LWW discards one along with every
 * value in it. KV lives at a name-addressed root, where independent minting
 * converges (ADR-0216).
 *
 * **Transcripts stay in the row.** They are machine-produced, replaced
 * wholesale, and rendered in the recordings list, so nothing about them wants
 * per-character merging. That is the opposite of Honeycrisp's call for prose
 * (ADR-0207) and it is deliberate: a note is written by a person a character at
 * a time, a transcript arrives finished.
 *
 * **There are no optional fields.** A field has to be one type through the CRDT
 * attribute, the projection column and the row alike, and "absent" is not a SQL
 * type. What would have been optional is nullable with a `= null` default,
 * which a read applies and a write never stores.
 */

import type { BoundOf } from '@epicenter/data';
import { defineLens, type RowOf } from '@epicenter/lens';

/** Runtime-minted structural row ids. */
export type RecordingId = string;
export type RecipeId = string;

const recordingsTable = {
	/**
	 * Opaque local and remote identity for this recording's immutable audio.
	 *
	 * The pattern survives; the `BlobId` brand does not, because `RowOf` yields
	 * the field's own type and a brand is a TypeScript fiction the CRDT never
	 * saw. Re-brand with `parseBlobId` where a row meets the blob store.
	 */
	audioBlobId: '/^blob_[a-z0-9]{21}$/',
	/** Set only after an explicit replica upload succeeds. */
	uploadedAt: 'string.date.iso|null = null',
	title: "string = ''",
	recordedAt: 'string.date.iso',
	recordedAtZone: 'string',
	transcript: "string = ''",
	polishedTranscript: 'string|null = null',
	duration: 'number|null = null',
	/**
	 * The transcription outcome, flattened into three columns.
	 *
	 * It was one nullable discriminated union, and a Lens cannot express an
	 * inline object: `'{ status: ... }'` does not parse, and `'object|null'`
	 * parses but validates nothing and makes the whole outcome one LWW value.
	 * Three columns keep every field checked and let a failure's message merge
	 * independently of its timestamp.
	 */
	transcriptionStatus: "'pending'|'completed'|'failed' = 'pending'",
	transcriptionCompletedAt: 'string.date.iso|null = null',
	transcriptionError: 'string|null = null',
} as const;

const recipesTable = {
	/**
	 * No `sourceId`. It existed because the old store let an application choose
	 * a row id and a recipe needed a portable one; the store now refuses chosen
	 * ids by construction (ADR-0206), so a user recipe's identity IS its minted
	 * row id. Built-in recipes keep their `builtin:` ids and remain non-rows.
	 */
	name: 'string',
	instructions: 'string',
	icon: 'string|null = null',
} as const;

/**
 * A shortcut, as two fields.
 *
 * Same gap as the transcription outcome: a `{ modifiers, keys }` object has no
 * string expression. There is no lossless label codec in `utils/key-binding.ts`
 * either (`keyBindingToLabel` and `keyBindingToAccelerator` are one-way), so a
 * canonical single-string encoding would have to be invented and tested. Two
 * arrays need neither.
 *
 * `|null = null` rather than a default array, because a Lens CANNOT express an
 * array default: `'string[] = []'` fails to parse. Every array field in every
 * lens hits this, so it is worth saying once loudly.
 */
const shortcut = {
	modifiers: "('ctrl'|'alt'|'shift'|'meta'|'fn')[]|null = null",
	keys: 'string[]|null = null',
} as const;

const settingsKv = {
	soundManualStart: 'boolean = true',
	soundManualStop: 'boolean = true',
	soundManualCancel: 'boolean = true',
	soundVadStart: 'boolean = true',
	soundVadCapture: 'boolean = true',
	soundVadStop: 'boolean = true',
	soundTranscriptionComplete: 'boolean = true',
	soundRecipeComplete: 'boolean = true',

	outputTranscriptionClipboard: 'boolean = true',
	outputTranscriptionCursor: 'boolean = false',
	outputTranscriptionEnter: 'boolean = false',
	outputRecipeClipboard: 'boolean = true',
	outputRecipeCursor: 'boolean = false',
	outputRecipeEnter: 'boolean = false',

	recordingTrigger: "'manual'|'vad' = 'manual'",
	recordingPausePlayback: 'boolean = false',
	recordingAutoUpload: 'boolean = false',

	transcriptionService:
		"'epicenter'|'OpenAI'|'Groq'|'ElevenLabs'|'Deepgram'|'Mistral'|'local'|'speaches' = 'local'",
	transcriptionOpenaiModel: "string = 'whisper-1'",
	transcriptionGroqModel: "string = 'whisper-large-v3-turbo'",
	transcriptionElevenlabsModel: "string = 'scribe_v2'",
	transcriptionDeepgramModel: "string = 'nova-3'",
	transcriptionMistralModel: "string = 'voxtral-mini-latest'",
	/**
	 * A plain string, not a union of the 58 supported languages.
	 *
	 * A hand-written union here would drift from `constants/languages.ts`, and
	 * drift means the Lens refusing a write the UI offered. The app validates
	 * against the const; the three SMALL selects above are spelled out because
	 * a two-to-eight-member union is worth checking at the storage boundary.
	 */
	transcriptionLanguage: "string = 'auto'",
	transcriptionPrompt: "string = ''",

	completionProvider:
		"'OpenAI'|'Groq'|'Anthropic'|'Google'|'OpenRouter'|'Custom' = 'Google'",
	completionModel: "string = 'gemini-2.5-flash'",

	dictionary: 'string[]|null = null',
	polishEnabled: 'boolean = true',
	polishInstructions:
		"string = 'Fix grammar and punctuation. Keep my wording.'",
	analyticsEnabled: 'boolean = true',

	shortcutPushToTalkModifiers: shortcut.modifiers,
	shortcutPushToTalkKeys: shortcut.keys,
	shortcutToggleManualRecordingModifiers: shortcut.modifiers,
	shortcutToggleManualRecordingKeys: "string[]|null = null",
	shortcutCancelRecordingModifiers: shortcut.modifiers,
	shortcutCancelRecordingKeys: 'string[]|null = null',
	shortcutToggleVadRecordingModifiers: shortcut.modifiers,
	shortcutToggleVadRecordingKeys: 'string[]|null = null',
	shortcutOpenRecipePickerModifiers: shortcut.modifiers,
	shortcutOpenRecipePickerKeys: 'string[]|null = null',
	shortcutRunRecipeOnClipboardModifiers: shortcut.modifiers,
	shortcutRunRecipeOnClipboardKeys: 'string[]|null = null',
	shortcutOpenSettingsModifiers: shortcut.modifiers,
	shortcutOpenSettingsKeys: 'string[]|null = null',
} as const;

export const whisperingLens = defineLens({
	namespace: 'so.epicenter.whispering',
	title: 'Whispering',
	kv: settingsKv,
	tables: { recordings: recordingsTable, recipes: recipesTable },
});

/** The typed view of one store through Whispering's Lens. */
export type WhisperingData = BoundOf<typeof whisperingLens>;

export type Recording = RowOf<typeof recordingsTable>;
export type Recipe = RowOf<typeof recipesTable>;
export type WhisperingSettings = typeof settingsKv;

/**
 * Default shortcuts, applied by the app rather than declared in the Lens.
 *
 * A Lens cannot default an array, so `keys` defaults to null and "no shortcut
 * configured" and "the shipped shortcut" would otherwise be the same value.
 * These are release-local product policy anyway, which is where they were
 * before (`definition.ts`), and they are the only part of that file worth
 * keeping.
 */
export const DEFAULT_SHORTCUT_KEYS = {
	toggleManualRecording: ['space'],
	cancelRecording: ['keyC'],
	toggleVadRecording: ['keyV'],
	openRecipePicker: ['keyT'],
	runRecipeOnClipboard: ['keyR'],
	openSettings: ['comma'],
} as const;
