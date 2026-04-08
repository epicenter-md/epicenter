import { defineKv, defineTable, defineWorkspace } from '@epicenter/workspace';
import { type } from 'arktype';

// ── Constant imports ─────────────────────────────────────────────────────────

import { RECORDING_MODES } from '$lib/constants/audio/recording-modes';
import { INFERENCE_PROVIDER_IDS } from '$lib/constants/inference';
import {
	TRANSCRIPTION,
	TRANSCRIPTION_SERVICE_IDS,
} from '$lib/constants/transcription';
import { ALWAYS_ON_TOP_MODES } from '$lib/constants/ui/always-on-top';
import { FFMPEG_DEFAULT_COMPRESSION_OPTIONS } from '$lib/services/desktop/recorder/ffmpeg';

/**
 * Tables store normalized domain entities. Each row is replaced atomically via
 * `table.set()` — there's no field-level merging. Schemas validate on read, so old
 * data stays in storage until explicitly rewritten.
 */
/** Audio recordings captured by the user. One row per recording session. */
const recordings = defineTable(
	type({
		id: 'string',
		title: 'string',
		subtitle: 'string',
		timestamp: 'string',
		createdAt: 'string',
		updatedAt: 'string',
		transcribedText: 'string',
		transcriptionStatus: "'UNPROCESSED' | 'TRANSCRIBING' | 'DONE' | 'FAILED'",
		_v: '1',
	}),
);

/** User-defined transformation pipelines. Each transformation has ordered steps. */
const transformations = defineTable(
	type({
		id: 'string',
		title: 'string',
		description: 'string',
		createdAt: 'string',
		updatedAt: 'string',
		_v: '1',
	}),
);

/**
 * Individual steps within a transformation pipeline.
 *
 * Uses a flat row schema — all `prompt_transform` and `find_replace` fields are
 * present on every row, discriminated by the `type` field. This is intentional:
 *
 * - `table.set()` replaces the entire row. A discriminated union would lose the
 *   inactive variant's data on every write. Flat rows preserve everything.
 * - Per-provider model memory: each inference provider's model selection is stored
 *   independently. Switching providers and switching back retains your choices.
 *
 * @see {@link https://github.com/EpicenterHQ/epicenter/blob/main/specs/20260312T170000-whispering-workspace-polish-and-migration.md | Spec Decision 1}
 */
const transformationSteps = defineTable(
	type({
		id: 'string',
		transformationId: 'string',
		order: 'number',
		type: "'prompt_transform' | 'find_replace'",

		// Prompt transform: active provider
		inferenceProvider: type.enumerated(...INFERENCE_PROVIDER_IDS),

		// Prompt transform: per-provider model memory
		openaiModel: 'string',
		groqModel: 'string',
		anthropicModel: 'string',
		googleModel: 'string',
		openrouterModel: 'string',
		customModel: 'string',
		customBaseUrl: 'string',

		// Prompt transform: prompt templates
		systemPromptTemplate: 'string',
		userPromptTemplate: 'string',

		// Find & replace
		findText: 'string',
		replaceText: 'string',
		useRegex: 'boolean',

		_v: '1',
	}),
);

/**
 * Execution records for transformation pipelines. One run per invocation.
 *
 * Uses a discriminated union on `status`—unlike `transformationSteps` (which uses
 * flat rows to preserve per-provider model memory across type switches), runs have
 * one-way state transitions (running → completed | failed) with no data to preserve
 * across states. The union ensures `output` exists only on completed runs and `error`
 * exists only on failed runs, eliminating null checks after status narrowing.
 *
 * @see {@link https://github.com/EpicenterHQ/epicenter/blob/main/specs/20260312T170000-whispering-workspace-polish-and-migration.md | Spec Decision 1}
 */
const TransformationRunBase = type({
	id: 'string',
	transformationId: 'string',
	recordingId: 'string | null',
	input: 'string',
	startedAt: 'string',
	completedAt: 'string | null',
	_v: '1',
});

const transformationRuns = defineTable(
	TransformationRunBase.merge(
		type.or(
			{ status: "'running'" },
			{ status: "'completed'", output: 'string' },
			{ status: "'failed'", error: 'string' },
		),
	),
);

/**
 * Per-step execution records within a transformation run.
 *
 * Same discriminated union pattern as `transformationRuns`—`output` and `error`
 * are only present on the relevant status variant.
 */
const TransformationStepRunBase = type({
	id: 'string',
	transformationRunId: 'string',
	stepId: 'string',
	order: 'number',
	input: 'string',
	startedAt: 'string',
	completedAt: 'string | null',
	_v: '1',
});

const transformationStepRuns = defineTable(
	TransformationStepRunBase.merge(
		type.or(
			{ status: "'running'" },
			{ status: "'completed'", output: 'string' },
			{ status: "'failed'", error: 'string' },
		),
	),
);

/**
 * Synced settings stored as individual KV entries with last-write-wins resolution.
 *
 * Each key is independently resolved — two devices can change different settings
 * simultaneously without one overwriting the other. Dot-notation keys create a
 * natural namespace hierarchy and give per-key LWW granularity (unlike table rows
 * which are replaced atomically).
 *
 * Only preferences that roam across devices live here. API keys, filesystem paths,
 * hardware device IDs, base URLs, and global shortcuts stay in localStorage.
 */
/**
 * Sound effect toggles. Each event can independently play/mute a sound.
 * Manual = user-initiated recording. VAD = voice activity detection.
 */
const sound = {
	'sound.manualStart': defineKv(type('boolean'), true),
	'sound.manualStop': defineKv(type('boolean'), true),
	'sound.manualCancel': defineKv(type('boolean'), true),
	'sound.vadStart': defineKv(type('boolean'), true),
	'sound.vadCapture': defineKv(type('boolean'), true),
	'sound.vadStop': defineKv(type('boolean'), true),
	'sound.transcriptionComplete': defineKv(type('boolean'), true),
	'sound.transformationComplete': defineKv(type('boolean'), true),
} as const;

/**
 * Output behavior after transcription/transformation completes.
 * Controls clipboard, cursor paste, and simulated Enter key per pipeline stage.
 *
 * Uses `output.*` prefix to separate post-processing behavior from service
 * configuration—avoids polluting `transcription.*` and `transformation.*`
 * namespaces with unrelated concerns.
 */
const output = {
	'output.transcription.clipboard': defineKv(type('boolean'), true),
	'output.transcription.cursor': defineKv(type('boolean'), true),
	'output.transcription.enter': defineKv(type('boolean'), false),
	'output.transformation.clipboard': defineKv(type('boolean'), true),
	'output.transformation.cursor': defineKv(type('boolean'), false),
	'output.transformation.enter': defineKv(type('boolean'), false),
} as const;

/** Window behavior and navigation layout preferences. */
const ui = {
	'ui.alwaysOnTop': defineKv(type.enumerated(...ALWAYS_ON_TOP_MODES), 'Never'),
} as const;

/**
 * Recording retention policy. `maxCount` is stored as an integer — the old
 * settings schema used `string.digits` for localStorage; the workspace uses
 * the semantically correct numeric type.
 */
const dataRetention = {
	'retention.strategy': defineKv(
		type("'keep-forever' | 'limit-count'"),
		'keep-forever',
	),
	'retention.maxCount': defineKv(type('number.integer >= 1'), 100),
} as const;

/** User's preferred recording mode — manual trigger vs voice activity detection. */
const recording = {
	'recording.mode': defineKv(type.enumerated(...RECORDING_MODES), 'manual'),
} as const;

/**
 * Transcription service and per-service model selections.
 *
 * Each service's model is its own KV entry so switching from OpenAI → Groq and
 * back preserves your OpenAI model choice. `temperature` is stored as a number
 * (0–1) — the old settings schema used a string for localStorage.
 *
 * @see {@link https://github.com/EpicenterHQ/epicenter/blob/main/specs/20260312T170000-whispering-workspace-polish-and-migration.md | Spec Decision 2}
 */
const transcription = {
	'transcription.service': defineKv(
		type.enumerated(...TRANSCRIPTION_SERVICE_IDS),
		'moonshine',
	),
	'transcription.openai.model': defineKv(
		type('string'),
		TRANSCRIPTION.OpenAI.defaultModel,
	),
	'transcription.groq.model': defineKv(
		type('string'),
		TRANSCRIPTION.Groq.defaultModel,
	),
	'transcription.elevenlabs.model': defineKv(
		type('string'),
		TRANSCRIPTION.ElevenLabs.defaultModel,
	),
	'transcription.deepgram.model': defineKv(
		type('string'),
		TRANSCRIPTION.Deepgram.defaultModel,
	),
	'transcription.mistral.model': defineKv(
		type('string'),
		TRANSCRIPTION.Mistral.defaultModel,
	),
	'transcription.language': defineKv(type('string'), 'auto'),
	'transcription.prompt': defineKv(type('string'), ''),
	'transcription.temperature': defineKv(type('0 <= number <= 1'), 0),
	'transcription.compressionEnabled': defineKv(type('boolean'), false),
	'transcription.compressionOptions': defineKv(
		type('string'),
		FFMPEG_DEFAULT_COMPRESSION_OPTIONS,
	),
} as const;

/**
 * Currently active transformation pipeline and default completion model.
 *
 * `selectedId`: FK to `transformations` table. `null` = no transformation selected.
 * `openrouterModel`: Default OpenRouter model for new transformation steps.
 * Merged from `completion.*` — this is transformation pipeline config, not a separate domain.
 */
const transformation = {
	'transformation.selectedId': defineKv(type('string | null'), null),
	'transformation.openrouterModel': defineKv(
		type('string'),
		'mistralai/mixtral-8x7b',
	),
} as const;

/** Anonymized event logging toggle (Aptabase). */
const analytics = {
	'analytics.enabled': defineKv(type('boolean'), true),
} as const;

/**
 * In-app keyboard shortcuts. System-global shortcuts are device-specific and stay
 * in localStorage — these are only the shortcuts within the Whispering window.
 * `null` = unbound.
 */
const shortcuts = {
	'shortcut.toggleManualRecording': defineKv(type('string | null'), ' '),
	'shortcut.startManualRecording': defineKv(type('string | null'), null),
	'shortcut.stopManualRecording': defineKv(type('string | null'), null),
	'shortcut.cancelManualRecording': defineKv(type('string | null'), 'c'),
	'shortcut.toggleVadRecording': defineKv(type('string | null'), 'v'),
	'shortcut.startVadRecording': defineKv(type('string | null'), null),
	'shortcut.stopVadRecording': defineKv(type('string | null'), null),
	'shortcut.pushToTalk': defineKv(type('string | null'), 'p'),
	'shortcut.openTransformationPicker': defineKv(type('string | null'), 't'),
	'shortcut.runTransformationOnClipboard': defineKv(type('string | null'), 'r'),
} as const;

/**
 * The Whispering workspace definition — 5 normalized tables for domain data
 * and ~40 KV entries for synced preferences.
 */
export const whisperingDefinition = defineWorkspace({
	id: 'whispering',
	tables: {
		recordings,
		transformations,
		transformationSteps,
		transformationRuns,
		transformationStepRuns,
	},
	kv: {
		...sound,
		...output,
		...ui,
		...dataRetention,
		...recording,
		...transcription,
		...transformation,
		...analytics,
		...shortcuts,
	},
});
