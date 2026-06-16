import { createPersistedMap, defineEntry } from '@epicenter/svelte';
import { type } from 'arktype';
import { extractErrorMessage } from 'wellcrafted/error';
import { os } from '#platform/os';
import { BITRATES_KBPS, DEFAULT_BITRATE_KBPS } from '$lib/constants/audio';
import { LOCAL_MODEL_UNLOAD_POLICIES } from '$lib/constants/local-model-unload-policy';
import { log, report } from '$lib/report';
import type { KeyBinding } from '$lib/tauri/commands';

// ── Global shortcut binding shape ────────────────────────────────────────────

/**
 * Runtime shape of a stored global shortcut: the structured `KeyBinding` the
 * desktop rdev backend matches on (physical-key space). `modifiers` is strictly
 * enumerated; `keys` is validated as strings here and against the real `Key`
 * vocabulary by Rust at the IPC boundary (so a bad key is rejected on register,
 * not silently stored as garbage).
 */
const globalBinding = type({
	modifiers: "('ctrl' | 'alt' | 'shift' | 'meta' | 'fn')[]",
	keys: 'string[]',
}).or('null');

// Default bindings as global gestures, not mnemonic app hotkeys. Every gesture
// is a distinct, non-overlapping combo: the rdev matcher fires on exact set
// equality with no prefix resolution, so no gesture's keys may be a subset of
// another's (the shorter one would fire first and shadow the longer). That is
// why push-to-talk gets its own dedicated key and nothing else reuses it.
//
//   macOS:   Fn = push-to-talk,        Cmd + Shift + Space  = toggle
//   Windows: Ctrl+Win = push-to-talk,  Ctrl + Shift + Space = toggle
//
// Fn is a single physical key on Apple keyboards; elsewhere we reach for
// Ctrl+Win, a held chord that no common OS shortcut claims. Toggle adds Shift
// so it shares no prefix with push-to-talk while keeping Space as the "record"
// affordance. Cancel is the platform cancel chord (Cmd + . on macOS, the system
// cancel gesture since classic Mac OS; Ctrl + Shift + . elsewhere); it carries a
// modifier so it is safe to hold globally and registers like any other gesture
// with no session gating. Transformation gestures ship unbound: opt-in only.
// This map is the single source for the per-key schema defaults below; the reset
// path reads them back through `deviceConfig.getDefault`, not this map directly.
const PUSH_TO_TALK_MODIFIERS: KeyBinding['modifiers'] = os.isApple
	? ['fn']
	: ['ctrl', 'meta'];

const TOGGLE_MODIFIERS: KeyBinding['modifiers'] = os.isApple
	? ['meta', 'shift']
	: ['ctrl', 'shift'];

const CANCEL_MODIFIERS: KeyBinding['modifiers'] = os.isApple
	? ['meta']
	: ['ctrl', 'shift'];

const DEFAULT_GLOBAL_BINDINGS = {
	pushToTalk: { modifiers: PUSH_TO_TALK_MODIFIERS, keys: [] },
	toggleManualRecording: { modifiers: TOGGLE_MODIFIERS, keys: ['space'] },
	cancelRecording: { modifiers: CANCEL_MODIFIERS, keys: ['dot'] },
	toggleVadRecording: null,
	openTransformationPicker: null,
	runTransformationOnClipboard: null,
} satisfies Record<string, KeyBinding | null>;

// ── Per-key definitions ──────────────────────────────────────────────────────

/**
 * Device-bound configuration definitions: secrets, hardware IDs, filesystem
 * paths, and global OS shortcuts that should NEVER sync across devices.
 *
 * Each key has its own schema and default value. Stored individually in
 * localStorage under the `whispering.device.{key}` prefix.
 */
const DEVICE_DEFINITIONS = {
	// ── Provider backends ─────────────────────────────────────────────
	// One record per network backend: how this device reaches it.
	// API keys are secrets and never sync. Empty `endpoint` means the
	// provider's official API; Custom and Speaches have no official API,
	// so their endpoints carry real defaults.
	'providers.openai.apiKey': defineEntry(type('string'), ''),
	'providers.anthropic.apiKey': defineEntry(type('string'), ''),
	'providers.groq.apiKey': defineEntry(type('string'), ''),
	'providers.google.apiKey': defineEntry(type('string'), ''),
	'providers.deepgram.apiKey': defineEntry(type('string'), ''),
	'providers.elevenlabs.apiKey': defineEntry(type('string'), ''),
	'providers.mistral.apiKey': defineEntry(type('string'), ''),
	'providers.openrouter.apiKey': defineEntry(type('string'), ''),
	'providers.custom.apiKey': defineEntry(type('string'), ''),
	'providers.openai.endpoint': defineEntry(type('string'), ''),
	'providers.groq.endpoint': defineEntry(type('string'), ''),
	'providers.custom.endpoint': defineEntry(
		type('string'),
		'http://localhost:11434/v1',
	),
	'providers.speaches.endpoint': defineEntry(
		type('string'),
		'http://localhost:8000',
	),
	/**
	 * Model installed on the Speaches server. Device-local like the rest
	 * of the record: which models are pulled depends on the machine.
	 */
	'providers.speaches.modelId': defineEntry(
		type('string'),
		'Systran/faster-distil-whisper-small.en',
	),

	// ── Recording hardware ────────────────────────────────────────────
	'recording.cpal.deviceId': defineEntry(type('string | null'), null),
	'recording.navigator.deviceId': defineEntry(type('string | null'), null),
	'recording.navigator.bitrateKbps': defineEntry(
		type.enumerated(...BITRATES_KBPS),
		DEFAULT_BITRATE_KBPS,
	),
	'recording.cpal.sampleRate': defineEntry(
		type("'16000' | '44100' | '48000'"),
		'16000',
	),

	// ── Local model paths ─────────────────────────────────────────────
	/**
	 * The engine's selected model as an entry name inside its models folder
	 * (e.g. "ggml-tiny.bin", "parakeet-tdt-0.6b-v3-int8"), never a path. The
	 * folder under appdata is the single source of truth for where models
	 * live; `$lib/services/transcription/local-model-folder.ts` resolves
	 * names back to paths.
	 */
	'transcription.whispercpp.model': defineEntry(type('string'), ''),
	'transcription.parakeet.model': defineEntry(type('string'), ''),
	'transcription.moonshine.model': defineEntry(type('string'), ''),

	// ── Local model lifecycle (per device: memory pressure is physical) ─
	/**
	 * When to drop the resident local transcription model. Pushed to Rust
	 * on change via the `set_unload_policy` Tauri command; the Rust side
	 * owns the actual eviction (synchronous for `immediately`, idle-watcher
	 * for timed values). Device-local because the right answer depends on
	 * available RAM (a 64 GB workstation and a 16 GB laptop want different
	 * policies for the same workflow).
	 */
	'transcription.localModelUnloadPolicy': defineEntry(
		type.enumerated(...LOCAL_MODEL_UNLOAD_POLICIES),
		'after_5_minutes',
	),

	// ── Global OS shortcuts (device-specific, never synced) ───────────
	// Structured KeyBinding (physical-key space) for the rdev backend. Old
	// accelerator-string values are not migrated: they fail this schema and reset
	// to the defaults (clean break, see the note below the singleton).
	'shortcuts.global.toggleManualRecording': defineEntry(
		globalBinding,
		DEFAULT_GLOBAL_BINDINGS.toggleManualRecording,
	),
	'shortcuts.global.cancelRecording': defineEntry(
		globalBinding,
		DEFAULT_GLOBAL_BINDINGS.cancelRecording,
	),
	'shortcuts.global.toggleVadRecording': defineEntry(
		globalBinding,
		DEFAULT_GLOBAL_BINDINGS.toggleVadRecording,
	),
	'shortcuts.global.pushToTalk': defineEntry(
		globalBinding,
		DEFAULT_GLOBAL_BINDINGS.pushToTalk,
	),
	'shortcuts.global.openTransformationPicker': defineEntry(
		globalBinding,
		DEFAULT_GLOBAL_BINDINGS.openTransformationPicker,
	),
	'shortcuts.global.runTransformationOnClipboard': defineEntry(
		globalBinding,
		DEFAULT_GLOBAL_BINDINGS.runTransformationOnClipboard,
	),
};

// ── Types ────────────────────────────────────────────────────────────────────

type DeviceConfigDefs = typeof DEVICE_DEFINITIONS;
export type DeviceConfigKey = keyof DeviceConfigDefs & string;

// ── Legacy migration ─────────────────────────────────────────────────────────

const DEVICE_CONFIG_PREFIX = 'whispering.device.';

const LEGACY_LOCAL_MODEL_SELECTIONS = [
	{
		from: 'transcription.whispercpp.modelPath',
		to: 'transcription.whispercpp.model',
	},
	{
		from: 'transcription.parakeet.modelPath',
		to: 'transcription.parakeet.model',
	},
	{
		from: 'transcription.moonshine.modelPath',
		to: 'transcription.moonshine.model',
	},
] as const satisfies readonly {
	from: string;
	to: DeviceConfigKey;
}[];

function modelEntryNameFromLegacyPath(path: string) {
	return path.replace(/\\/g, '/').replace(/\/+$/, '').split('/').at(-1) ?? '';
}

function readLegacyString(key: string) {
	const raw = window.localStorage.getItem(`${DEVICE_CONFIG_PREFIX}${key}`);
	if (raw === null) return null;
	try {
		const value = JSON.parse(raw) as unknown;
		return typeof value === 'string' ? value : null;
	} catch {
		return null;
	}
}

// ── Singleton ────────────────────────────────────────────────────────────────

export const deviceConfig = createPersistedMap({
	prefix: DEVICE_CONFIG_PREFIX,
	definitions: DEVICE_DEFINITIONS,
	onError: (key) => {
		log.info(`Invalid device config for "${key}", using default`);
	},
	onUpdateError: (_key, error) => {
		report.error({
			title: 'Error updating device config',
			cause: {
				name: 'DeviceConfigUpdateFailed',
				message: extractErrorMessage(error),
			},
		});
	},
});

for (const migration of LEGACY_LOCAL_MODEL_SELECTIONS) {
	if (deviceConfig.get(migration.to)) continue;
	const legacyPath = readLegacyString(migration.from);
	if (!legacyPath) continue;
	const entryName = modelEntryNameFromLegacyPath(legacyPath);
	if (entryName) deviceConfig.set(migration.to, entryName);
}

// Global shortcuts are NOT migrated from the old accelerator-string format. A
// clean break: a legacy value fails the `globalBinding` schema on read and falls
// back to the default (see `createPersistedMap`), so upgrading users get the new
// defaults. We refuse to carry a parser for a format nothing writes anymore.
