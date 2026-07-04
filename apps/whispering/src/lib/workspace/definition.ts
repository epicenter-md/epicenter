import { field } from '@epicenter/field';
import {
	defineKv,
	defineTable,
	defineWorkspace,
	type IanaTimeZone,
	type InferTableRow,
	nullable,
} from '@epicenter/workspace';
import { Type } from 'typebox';
import type { KeyBinding } from '$lib/tauri/commands';

// ── Constant imports ─────────────────────────────────────────────────────────

import { RECORDING_TRIGGERS } from '$lib/constants/audio/recording-triggers';
import { INFERENCE_PROVIDER_IDS } from '$lib/constants/inference';
import { SUPPORTED_LANGUAGES } from '$lib/constants/languages';
import {
	PERSISTED_TRANSCRIPTION_SERVICE_IDS,
	PROVIDERS,
	type TranscriptionServiceId,
} from '$lib/services/transcription/providers';

/**
 * Tables store normalized domain entities. Each row is replaced atomically via
 * `table.set()`, there's no field-level merging. Schemas validate rows on read.
 */
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

/**
 * Audio recordings captured by the user. One row per recording session.
 *
 * `transcription` holds only the terminal outcome (completed or failed). A
 * recording that is currently transcribing has no `transcription`; liveness is
 * derived from the in-flight mutation, never stored.
 */
const recordings = defineTable({
	id: field.string(),
	title: field.string(),
	recordedAt: field.instant(),
	recordedAtZone: field.string<IanaTimeZone>(),
	transcript: field.string(),
	polishedTranscript: nullable(field.string()),
	duration: nullable(field.number()),
	transcription: nullable(field.json(TranscriptionOutcome)),
});

/** Recording row type inferred from the workspace table schema. */
export type Recording = InferTableRow<typeof recordings>;

/**
 * A reusable text action: a name and a single instruction, run on demand over
 * whatever text the host hands it (text in, text out). Recipes are the portable,
 * plural, on-demand reshape library; they know nothing about voice and carry no
 * correction plumbing (that is Polish's job, run once before any Recipe). See
 * ADR-0099.
 *
 * Deliberately tiny: no pre/post replacements, no system/user prompt split, no
 * `{{input}}` placeholder, no per-Recipe model or provider (model comes from the
 * global `completion.*` default). `icon` is optional; null until one is assigned.
 */
const recipes = defineTable({
	id: field.string(),
	name: field.string(),
	instructions: field.string(),
	icon: nullable(field.string()),
});

/** Recipe row type inferred from the workspace table schema. */
export type Recipe = InferTableRow<typeof recipes>;

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
	'sound.recipeComplete': defineKv(field.boolean(), () => true),
} as const;

/**
 * Output behavior after transcription/recipe completes.
 * Controls clipboard, cursor paste, and simulated Enter key per pipeline stage.
 *
 * Uses `output.*` prefix to separate post-processing behavior from service
 * configuration: avoids polluting `transcription.*` and `recipe.*` namespaces
 * with unrelated concerns.
 *
 * Clipboard is the permission-free default; cursor paste is opt-in. Pasting at
 * the cursor synthesizes a Cmd/Ctrl+V keystroke (`write_text` -> enigo), and on
 * macOS injecting keystrokes into another app requires Accessibility. So both
 * cursor defaults are `false`: out of the box the transcript lands on the
 * clipboard (no permission, works on first launch) and the user pastes it.
 * Turning cursor paste on is the deliberate step that asks for Accessibility.
 * Recipe cursor also stays off so it cannot double-type over a transcription
 * that already pasted itself once a user turns both on.
 */
const output = {
	'output.transcription.clipboard': defineKv(field.boolean(), () => true),
	'output.transcription.cursor': defineKv(field.boolean(), () => false),
	'output.transcription.enter': defineKv(field.boolean(), () => false),
	'output.recipe.clipboard': defineKv(field.boolean(), () => true),
	'output.recipe.cursor': defineKv(field.boolean(), () => false),
	'output.recipe.enter': defineKv(field.boolean(), () => false),
} as const;

/**
 * Recording retention policy. `retention.strategy` is the source of truth for
 * how many recordings to keep: `keep-forever` (all), `limit-count` (the newest
 * `maxCount`), or `keep-none` (zero). `maxCount` only applies under
 * `limit-count`; it stays `>= 1` so the original "0 means never save" overload
 * can never be persisted again. "Keep zero" lives in the strategy enum, not in
 * a sentinel count: `keep-none` maps to a runtime count of 0 without storing 0.
 */
const dataRetention = {
	'retention.strategy': defineKv(
		field.select(['keep-forever', 'limit-count', 'keep-none']),
		() => 'keep-forever' as const,
	),
	'retention.maxCount': defineKv(field.integer({ minimum: 1 }), () => 100),
} as const;

/**
 * How the microphone starts capturing: manual trigger vs voice activity
 * detection. File import is a separate surface, not a trigger, so it is not a
 * value here.
 */
const recording = {
	'recording.trigger': defineKv(
		field.select(RECORDING_TRIGGERS),
		() => 'manual' as const,
	),
	// Pause system media playback while your voice is being captured, resume it
	// after. Off by default (opt-in): the resume cannot keep its promise on macOS,
	// where MediaRemote's Play is single-target so it can wake whatever app the OS
	// last marked now-playing, not the app we actually paused (see ADR-0045). A
	// convenience that can occasionally start unrelated media should be chosen, not
	// sprung. Discoverable via the settings toggle's description and the home-row
	// quick toggle, both of which explain it at the moment you turn it on. A
	// roaming preference, not a per-device capability, so it follows you across
	// machines like the sound toggles.
	'recording.pausePlayback': defineKv(field.boolean(), () => false),
} as const;

/**
 * Transcription service and per-service model selections.
 *
 * Each service's model is its own KV entry so switching from OpenAI to Groq and
 * back preserves your OpenAI model choice.
 *
 * @see {@link https://github.com/EpicenterHQ/epicenter/blob/main/specs/20260312T170000-whispering-workspace-polish-and-migration.md | Spec Decision 2}
 */
function defineTranscriptionSettings(
	defaultTranscriptionService: TranscriptionServiceId,
) {
	return {
		'transcription.service': defineKv(
			// Accept legacy multi-engine on-device ids (whispercpp/parakeet/moonshine)
			// from old synced workspaces so the settings facade can normalize them to
			// `local` on read; the field stays typed as the canonical id union.
			Type.Unsafe<TranscriptionServiceId>(
				field.select(PERSISTED_TRANSCRIPTION_SERVICE_IDS),
			),
			() => defaultTranscriptionService,
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
		'transcription.language': defineKv(
			field.select(SUPPORTED_LANGUAGES),
			() => 'auto' as const,
		),
		'transcription.prompt': defineKv(field.string(), () => ''),
	} as const;
}

/**
 * The single global AI default used for completions: which inference provider
 * and model the Polish pass and every Recipe run against. There is no per-Recipe
 * model or provider; this is the one place it lives. API keys and endpoints stay
 * in deviceConfig (local, never synced); only the provider/model choice roams.
 */
const completion = {
	'completion.provider': defineKv(
		field.select(INFERENCE_PROVIDER_IDS),
		() => 'Google' as const,
	),
	'completion.model': defineKv(field.string(), () => 'gemini-2.5-flash'),
} as const;

/**
 * Dictionary: a flat list of words Whispering should know, proper nouns and
 * domain terms ("Kubernetes", "Braden"). Injection-only: the runtime composes
 * these terms into every AI prompt (via `buildSystemPrompt`) and, where the
 * transcription model accepts one, into its `initial_prompt`. It is not
 * find/replace and not an algorithm; the AI is the matcher. See ADR-0099.
 */
const dictionary = {
	dictionary: defineKv(Type.Array(Type.String()), (): string[] => []),
} as const;

/** Default Polish instruction. Kept faithful: fix mechanics, preserve wording. */
const DEFAULT_POLISH_INSTRUCTIONS =
	'Fix grammar and punctuation. Keep my wording.';

/**
 * Polish: the always-on, meaning-preserving AI base, run once after every
 * transcription. One optional pass that fixes grammar and punctuation while
 * keeping the user's wording. On by default, but it only fires when the selected
 * provider can actually serve a completion (a runtime gate, not a flag), so a
 * fresh unconfigured install never pays a surprise cost. Turn `enabled` off for
 * speed mode: the raw transcript ships instantly with no AI call. `instructions`
 * is editable under Advanced. Polish is not a Recipe; it is the base layer every
 * Recipe stands on. See ADR-0099.
 */
const polish = {
	'polish.enabled': defineKv(field.boolean(), () => true),
	'polish.instructions': defineKv(
		field.string(),
		() => DEFAULT_POLISH_INSTRUCTIONS,
	),
} as const;

/** Anonymized event logging toggle (Aptabase). */
const analytics = {
	'analytics.enabled': defineKv(field.boolean(), () => true),
} as const;

/**
 * A stored in-app shortcut: the structured `KeyBinding` the keydown matcher and
 * the system tier both speak (physical-key space). `modifiers` is enumerated;
 * `keys` is validated as strings here and against the real `Key` vocabulary by
 * Rust at the IPC boundary. This is the same shape device-config stores for the
 * global tier; persisting it here too (not a joined string) lets both stores read
 * and write the binding directly, with no manual-grammar codec in between.
 */
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

/**
 * In-app keyboard shortcuts. System-global shortcuts are device-specific and stay
 * in localStorage: these are only the shortcuts within the Whispering window.
 * `null` = unbound.
 */
const shortcuts = {
	// These getDefault thunks are the single source for the in-app shortcut
	// defaults. The focused backend (platform/focused-shortcuts.ts) reads them back
	// through `settings.getDefault('shortcut.*')` instead of redeclaring them, so
	// the schema and the backend can never drift. Values are the structured
	// `KeyBinding` (`field.json(KeyBindingSchema)`), the shape the global tier also
	// stores in device-config. A stored value that fails the schema (such as one
	// saved in the old manual-grammar string format) reads as the default below.
	//
	// Push-to-talk ships unbound in-app: a stray Space-style tap would fire
	// start+immediate-stop and feed a junk recording to the pipeline, so the safe
	// in-app default is the toggle below.
	'shortcut.pushToTalk': defineKv(
		nullable(field.json(KeyBindingSchema)),
		(): KeyBinding | null => null,
	),
	'shortcut.toggleManualRecording': defineKv(
		nullable(field.json(KeyBindingSchema)),
		(): KeyBinding | null => ({ modifiers: [], keys: ['space'] }),
	),
	// Renamed from `shortcut.cancelManualRecording` (cancel now aborts manual or
	// VAD capture, so the "manual" qualifier is gone). No migration: pre-release,
	// the old key is simply orphaned and this falls back to its default.
	'shortcut.cancelRecording': defineKv(
		nullable(field.json(KeyBindingSchema)),
		(): KeyBinding | null => ({ modifiers: [], keys: ['keyC'] }),
	),
	'shortcut.toggleVadRecording': defineKv(
		nullable(field.json(KeyBindingSchema)),
		(): KeyBinding | null => ({ modifiers: [], keys: ['keyV'] }),
	),
	'shortcut.openRecipePicker': defineKv(
		nullable(field.json(KeyBindingSchema)),
		(): KeyBinding | null => ({ modifiers: [], keys: ['keyT'] }),
	),
	'shortcut.runRecipeOnClipboard': defineKv(
		nullable(field.json(KeyBindingSchema)),
		(): KeyBinding | null => ({ modifiers: [], keys: ['keyR'] }),
	),
	// Navigation, focused by nature: Cmd+, (the platform "open preferences"
	// gesture) opens settings in-app. A chord on a `focused` command still clamps
	// to focused reach, so this never registers globally; it lives only in the
	// synced focused store. `meta` + `comma` is platform-free here (the synced
	// default must be), surfacing as Cmd+, on macOS and Win+, elsewhere.
	'shortcut.openSettings': defineKv(
		nullable(field.json(KeyBindingSchema)),
		(): KeyBinding | null => ({ modifiers: ['meta'], keys: ['comma'] }),
	),
} as const;

/**
 * Define the Whispering workspace model for one platform's default service.
 *
 * The KV schema map (~40 entries for synced preferences) stays local so it is
 * never a module-level export; callers reach the key list, per-key defaults,
 * and the bulk reset through the workspace's own `kv.keys` / `kv.getDefault` /
 * `kv.reset` (ADR-0093).
 */
export function defineWhispering(
	defaultTranscriptionService: TranscriptionServiceId,
) {
	return defineWorkspace({
		// Workspace/Y.Doc identity, not an OAuth client id or Tauri bundle id.
		// This keys local storage and cloud rooms; change only with a data migration.
		id: 'epicenter-whispering',
		name: 'Whispering',
		tables: {
			recordings,
			recipes,
		},
		kv: {
			...sound,
			...output,
			...dataRetention,
			...recording,
			...defineTranscriptionSettings(defaultTranscriptionService),
			...completion,
			...dictionary,
			...polish,
			...analytics,
			...shortcuts,
		},
	});
}
