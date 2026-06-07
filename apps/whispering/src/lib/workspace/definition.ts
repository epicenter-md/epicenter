import { field } from '@epicenter/field';
import {
	createWorkspace,
	defineKv,
	defineTable,
	defineWorkspace,
	type InferKvValue,
	type InferTableRow,
	nullable,
} from '@epicenter/workspace';
import { type Static, Type } from 'typebox';

// ── Constant imports ─────────────────────────────────────────────────────────

import { ALWAYS_ON_TOP_MODES } from '$lib/constants/always-on-top';
import { RECORDING_MODES } from '$lib/constants/audio/recording-modes';
import { INFERENCE_PROVIDER_IDS } from '$lib/constants/inference';
import { TRANSFORMATION_STEP_TYPES } from '$lib/constants/transformations';
import {
	PROVIDERS,
	TRANSCRIPTION_SERVICE_IDS,
} from '$lib/services/transcription/providers';

/**
 * Tables store normalized domain entities. Each row is replaced atomically via
 * `table.set()`, there's no field-level merging. Schemas validate rows on read.
 */
/** Audio recordings captured by the user. One row per recording session. */
const recordings = defineTable({
	id: field.string(),
	title: field.string(),
	recordedAt: field.string(),
	updatedAt: field.string(),
	transcript: field.string(),
	transcriptionStatus: field.select([
		'UNPROCESSED',
		'TRANSCRIBING',
		'DONE',
		'FAILED',
	]),
	duration: nullable(field.number()),
});

/** Recording row type inferred from the workspace table schema. */
export type Recording = InferTableRow<typeof recordings>;

/** User-defined transformation pipelines. Each transformation has ordered steps. */
const transformations = defineTable({
	id: field.string(),
	title: field.string(),
	description: field.string(),
	createdAt: field.string(),
	updatedAt: field.string(),
});

/** Transformation row type inferred from the workspace table schema. */
export type Transformation = InferTableRow<typeof transformations>;

/**
 * Individual steps within a transformation pipeline.
 *
 * Uses a flat row schema: all `prompt_transform` and `find_replace` fields are
 * present on every row, discriminated by the `type` field. This is intentional:
 *
 * - `table.set()` replaces the entire row. A discriminated union would lose the
 *   inactive variant's data on every write. Flat rows preserve everything.
 * - Per-provider model memory: each inference provider's model selection is stored
 *   independently. Switching providers and switching back retains your choices.
 *
 * @see {@link https://github.com/EpicenterHQ/epicenter/blob/main/specs/20260312T170000-whispering-workspace-polish-and-migration.md | Spec Decision 1}
 */
const transformationSteps = defineTable({
	id: field.string(),
	transformationId: field.string(),
	order: field.number(),
	type: field.select(TRANSFORMATION_STEP_TYPES),

	// Prompt transform: active provider
	inferenceProvider: field.select(INFERENCE_PROVIDER_IDS),

	// Prompt transform: per-provider model memory
	openaiModel: field.string(),
	groqModel: field.string(),
	anthropicModel: field.string(),
	googleModel: field.string(),
	openrouterModel: field.string(),
	customModel: field.string(),
	customBaseUrl: field.string(),

	// Prompt transform: prompt templates
	systemPromptTemplate: field.string(),
	userPromptTemplate: field.string(),

	// Find & replace
	findText: field.string(),
	replaceText: field.string(),
	useRegex: field.boolean(),
});

/** Transformation step row type inferred from the workspace table schema. */
export type TransformationStep = InferTableRow<typeof transformationSteps>;

/**
 * Per-variant result shapes for a transformation run or step run. Each
 * variant has a single source of truth (one schema, one shadowed type) and
 * higher-level unions compose them.
 *
 * Storage is one JSON-encoded TEXT column (`result`) on the row; nothing in
 * the read path filters or sorts on these fields, so the JSON envelope is
 * cheaper than the loss of per-status invariants a flat nullable layout
 * would cause.
 *
 * Run and step run share the same result schema.
 */
const RunningResult = Type.Object({ status: Type.Literal('running') });
export type RunningResult = Static<typeof RunningResult>;

const CompletedResult = Type.Object({
	status: Type.Literal('completed'),
	completedAt: Type.String(),
	output: Type.String(),
});
export type CompletedResult = Static<typeof CompletedResult>;

const FailedResult = Type.Object({
	status: Type.Literal('failed'),
	completedAt: Type.String(),
	error: Type.String(),
});
export type FailedResult = Static<typeof FailedResult>;

/** Every possible result a run or step run can carry. */
const TransformationRunResult = Type.Union([
	RunningResult,
	CompletedResult,
	FailedResult,
]);
export type TransformationRunResult = Static<typeof TransformationRunResult>;

/**
 * Execution records for transformation pipelines. One run per invocation.
 * State queries filter by top-level `recordingId` / `transformationId` and
 * sort by `startedAt`; status-dependent fields live inside `result`.
 */
const transformationRuns = defineTable({
	id: field.string(),
	transformationId: field.string(),
	recordingId: nullable(field.string()),
	input: field.string(),
	startedAt: field.string(),
	result: field.json(TransformationRunResult),
});

/** Transformation run row type inferred from the workspace table schema. */
export type TransformationRun = InferTableRow<typeof transformationRuns>;

/** Per-step execution records within a transformation run. */
const transformationStepRuns = defineTable({
	id: field.string(),
	transformationRunId: field.string(),
	stepId: field.string(),
	order: field.number(),
	input: field.string(),
	startedAt: field.string(),
	result: field.json(TransformationRunResult),
});

/** Transformation step run row type inferred from the workspace table schema. */
export type TransformationStepRun = InferTableRow<
	typeof transformationStepRuns
>;

/**
 * Synced settings stored as individual KV entries with last-write-wins resolution.
 *
 * Each key is independently resolved: two devices can change different settings
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
	'sound.manualStart': defineKv(field.boolean(), () => true),
	'sound.manualStop': defineKv(field.boolean(), () => true),
	'sound.manualCancel': defineKv(field.boolean(), () => true),
	'sound.vadStart': defineKv(field.boolean(), () => true),
	'sound.vadCapture': defineKv(field.boolean(), () => true),
	'sound.vadStop': defineKv(field.boolean(), () => true),
	'sound.transcriptionComplete': defineKv(field.boolean(), () => true),
	'sound.transformationComplete': defineKv(field.boolean(), () => true),
} as const;

/**
 * Output behavior after transcription/transformation completes.
 * Controls clipboard, cursor paste, and simulated Enter key per pipeline stage.
 *
 * Uses `output.*` prefix to separate post-processing behavior from service
 * configuration: avoids polluting `transcription.*` and `transformation.*`
 * namespaces with unrelated concerns.
 *
 * Cursor default asymmetry (transcription=true, transformation=false): when a
 * transformation runs on the just-finished transcription, the transcription
 * has already typed itself at the cursor. Defaulting transformation.cursor to
 * true would double-type. Users who turn off transcription.cursor specifically
 * to let the transformation be the cursor output can flip the transformation
 * toggle on.
 */
const output = {
	'output.transcription.clipboard': defineKv(field.boolean(), () => true),
	'output.transcription.cursor': defineKv(field.boolean(), () => true),
	'output.transcription.enter': defineKv(field.boolean(), () => false),
	'output.transformation.clipboard': defineKv(field.boolean(), () => true),
	'output.transformation.cursor': defineKv(field.boolean(), () => false),
	'output.transformation.enter': defineKv(field.boolean(), () => false),
} as const;

/** Window behavior and navigation layout preferences. */
const ui = {
	'ui.alwaysOnTop': defineKv(
		field.select(ALWAYS_ON_TOP_MODES),
		() => 'Never' as const,
	),
} as const;

/**
 * Recording retention policy. `maxCount` is stored as an integer: the old
 * settings schema used `string.digits` for localStorage; the workspace uses
 * the semantically correct numeric type.
 */
const dataRetention = {
	'retention.strategy': defineKv(
		field.select(['keep-forever', 'limit-count']),
		() => 'keep-forever' as const,
	),
	'retention.maxCount': defineKv(field.integer({ minimum: 1 }), () => 100),
} as const;

/** User's preferred recording mode: manual trigger vs voice activity detection. */
const recording = {
	'recording.mode': defineKv(
		field.select(RECORDING_MODES),
		() => 'manual' as const,
	),
} as const;

/**
 * Transcription service and per-service model selections.
 *
 * Each service's model is its own KV entry so switching from OpenAI to Groq and
 * back preserves your OpenAI model choice.
 *
 * @see {@link https://github.com/EpicenterHQ/epicenter/blob/main/specs/20260312T170000-whispering-workspace-polish-and-migration.md | Spec Decision 2}
 */
const transcription = {
	'transcription.service': defineKv(
		field.select(TRANSCRIPTION_SERVICE_IDS),
		() => 'moonshine' as const,
	),
	'transcription.openai.model': defineKv(
		field.string(),
		() => PROVIDERS.OpenAI.defaultModel as string,
	),
	'transcription.groq.model': defineKv(
		field.string(),
		() => PROVIDERS.Groq.defaultModel as string,
	),
	'transcription.elevenlabs.model': defineKv(
		field.string(),
		() => PROVIDERS.ElevenLabs.defaultModel as string,
	),
	'transcription.deepgram.model': defineKv(
		field.string(),
		() => PROVIDERS.Deepgram.defaultModel as string,
	),
	'transcription.mistral.model': defineKv(
		field.string(),
		() => PROVIDERS.Mistral.defaultModel as string,
	),
	'transcription.language': defineKv(field.string(), () => 'auto'),
	'transcription.prompt': defineKv(field.string(), () => ''),
} as const;

/**
 * Currently active transformation pipeline.
 *
 * `selectedId`: FK to `transformations` table. `null` = no transformation selected.
 *
 * Per-provider model defaults for new steps live in `generateDefaultStep`
 * (transformation-steps.svelte.ts), not as KV entries. Each step row carries
 * its own per-provider model memory, so a global default KV would be redundant.
 */
const transformation = {
	'transformation.selectedId': defineKv(
		nullable(field.string()),
		(): string | null => null,
	),
} as const;

/** Anonymized event logging toggle (Aptabase). */
const analytics = {
	'analytics.enabled': defineKv(field.boolean(), () => true),
} as const;

/**
 * In-app keyboard shortcuts. System-global shortcuts are device-specific and stay
 * in localStorage: these are only the shortcuts within the Whispering window.
 * `null` = unbound.
 */
const shortcuts = {
	'shortcut.toggleManualRecording': defineKv(
		nullable(field.string()),
		(): string | null => ' ',
	),
	'shortcut.cancelManualRecording': defineKv(
		nullable(field.string()),
		(): string | null => 'c',
	),
	'shortcut.toggleVadRecording': defineKv(
		nullable(field.string()),
		(): string | null => 'v',
	),
	'shortcut.pushToTalk': defineKv(
		nullable(field.string()),
		(): string | null => 'p',
	),
	'shortcut.openTransformationPicker': defineKv(
		nullable(field.string()),
		(): string | null => 't',
	),
	'shortcut.runTransformationOnClipboard': defineKv(
		nullable(field.string()),
		(): string | null => 'r',
	),
} as const;

export function createWhispering() {
	/**
	 * Whispering KV schemas: ~40 entries for synced preferences. Defined locally
	 * so the raw schema map is not a module-level export. Callers reach the
	 * defaults and key list through the `settings` namespace on the returned
	 * workspace bundle.
	 */
	const kvDefinitions = {
		...sound,
		...output,
		...ui,
		...dataRetention,
		...recording,
		...transcription,
		...transformation,
		...analytics,
		...shortcuts,
	};
	type SettingKey = keyof typeof kvDefinitions & string;

	const workspace = createWorkspace({
		id: 'epicenter-whispering',
		tables: {
			recordings,
			transformations,
			transformationSteps,
			transformationRuns,
			transformationStepRuns,
		},
		kv: kvDefinitions,
	});

	const settingKeys = Object.keys(kvDefinitions) as SettingKey[];

	return defineWorkspace({
		...workspace,
		/**
		 * Synced setting metadata for the Whispering workspace.
		 *
		 * Owns the KV schema map: callers never see the raw `defineKv` definitions.
		 * Use `kv.get`/`kv.set`/`kv.observeAll` for live values; reach for `settings`
		 * for the key list, per-key defaults, and the bulk reset.
		 */
		settings: {
			/** Every synced setting key, in declaration order. */
			keys: settingKeys,
			/** Return the default value for a setting key (factory-evaluated). */
			getDefault<K extends SettingKey>(
				key: K,
			): InferKvValue<(typeof kvDefinitions)[K]> {
				return kvDefinitions[key].defaultValue() as InferKvValue<
					(typeof kvDefinitions)[K]
				>;
			},
			/**
			 * Reset every synced workspace setting to its default in a single Yjs
			 * transaction (one `observeAll` firing, not one per key).
			 */
			reset(): void {
				workspace.ydoc.transact(() => {
					for (const key of settingKeys) {
						(workspace.kv.set as (key: string, value: unknown) => void)(
							key,
							kvDefinitions[key].defaultValue(),
						);
					}
				});
			},
		},
	});
}
