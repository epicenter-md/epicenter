import { createPersistedMap, defineEntry } from '@epicenter/svelte';
import { type } from 'arktype';
import { extractErrorMessage } from 'wellcrafted/error';
import { BITRATES_KBPS, DEFAULT_BITRATE_KBPS } from '$lib/constants/audio';
import { CommandOrAlt, CommandOrControl } from '$lib/constants/keyboard';
import { LOCAL_MODEL_UNLOAD_POLICIES } from '$lib/constants/local-model-unload-policy';
import { log, report } from '$lib/report';

// ── Per-key definitions ──────────────────────────────────────────────────────

/**
 * Device-bound configuration definitions: secrets, hardware IDs, filesystem
 * paths, and global OS shortcuts that should NEVER sync across devices.
 *
 * Each key has its own schema and default value. Stored individually in
 * localStorage under the `whispering.device.{key}` prefix.
 */
const DEVICE_DEFINITIONS = {
	// ── API keys (secrets, never synced) ──────────────────────────────
	'apiKeys.openai': defineEntry(type('string'), ''),
	'apiKeys.anthropic': defineEntry(type('string'), ''),
	'apiKeys.groq': defineEntry(type('string'), ''),
	'apiKeys.google': defineEntry(type('string'), ''),
	'apiKeys.deepgram': defineEntry(type('string'), ''),
	'apiKeys.elevenlabs': defineEntry(type('string'), ''),
	'apiKeys.mistral': defineEntry(type('string'), ''),
	'apiKeys.openrouter': defineEntry(type('string'), ''),
	'apiKeys.custom': defineEntry(type('string'), ''),

	// ── API endpoint overrides ────────────────────────────────────────
	'apiEndpoints.openai': defineEntry(type('string'), ''),
	'apiEndpoints.groq': defineEntry(type('string'), ''),

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
	'transcription.speaches.baseUrl': defineEntry(
		type('string'),
		'http://localhost:8000',
	),
	'transcription.speaches.modelId': defineEntry(
		type('string'),
		'Systran/faster-distil-whisper-small.en',
	),
	'transcription.whispercpp.modelPath': defineEntry(type('string'), ''),
	'transcription.parakeet.modelPath': defineEntry(type('string'), ''),
	'transcription.moonshine.modelPath': defineEntry(type('string'), ''),

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

	// ── Self-hosted server URLs ───────────────────────────────────────
	'completion.custom.baseUrl': defineEntry(
		type('string'),
		'http://localhost:11434/v1',
	),

	// ── Global OS shortcuts (device-specific, never synced) ───────────
	'shortcuts.global.toggleManualRecording': defineEntry(
		type('string | null'),
		`${CommandOrControl}+Shift+;` as string | null,
	),
	'shortcuts.global.cancelManualRecording': defineEntry(
		type('string | null'),
		`${CommandOrControl}+Shift+'` as string | null,
	),
	'shortcuts.global.toggleVadRecording': defineEntry(
		type('string | null'),
		null,
	),
	'shortcuts.global.pushToTalk': defineEntry(
		type('string | null'),
		`${CommandOrAlt}+Shift+D` as string | null,
	),
	'shortcuts.global.openTransformationPicker': defineEntry(
		type('string | null'),
		`${CommandOrControl}+Shift+X` as string | null,
	),
	'shortcuts.global.runTransformationOnClipboard': defineEntry(
		type('string | null'),
		`${CommandOrControl}+Shift+R` as string | null,
	),
};

// ── Types ────────────────────────────────────────────────────────────────────

type DeviceConfigDefs = typeof DEVICE_DEFINITIONS;
export type DeviceConfigKey = keyof DeviceConfigDefs & string;

// ── Singleton ────────────────────────────────────────────────────────────────

export const deviceConfig = createPersistedMap({
	prefix: 'whispering.device.',
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
