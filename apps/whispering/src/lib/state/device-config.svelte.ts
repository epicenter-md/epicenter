import {
	createPersistedMap,
	defineEntry,
	type PersistedMap,
} from '@epicenter/svelte';
import { type } from 'arktype';
import { extractErrorMessage } from 'wellcrafted/error';
import { BITRATES_KBPS, DEFAULT_BITRATE_KBPS } from '$lib/constants/audio';
import { CommandOrAlt, CommandOrControl } from '$lib/constants/keyboard';
import { rpc } from '$lib/query';
import {
	FFMPEG_DEFAULT_GLOBAL_OPTIONS,
	FFMPEG_DEFAULT_INPUT_OPTIONS,
	FFMPEG_DEFAULT_OUTPUT_OPTIONS,
} from '$lib/services/desktop/recorder/ffmpeg';

// ── Per-key definitions ──────────────────────────────────────────────────────

/**
 * Device-bound configuration definitions — secrets, hardware IDs, filesystem
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
	'recording.method': defineEntry(
		type("'cpal' | 'navigator' | 'ffmpeg'"),
		'cpal',
	),
	'recording.cpal.deviceId': defineEntry(type('string | null'), null),
	'recording.navigator.deviceId': defineEntry(type('string | null'), null),
	'recording.ffmpeg.deviceId': defineEntry(type('string | null'), null),
	'recording.navigator.bitrateKbps': defineEntry(
		type.enumerated(...BITRATES_KBPS),
		DEFAULT_BITRATE_KBPS,
	),
	'recording.cpal.outputFolder': defineEntry(type('string | null'), null),
	'recording.cpal.sampleRate': defineEntry(
		type("'16000' | '44100' | '48000'"),
		'16000',
	),
	'recording.ffmpeg.globalOptions': defineEntry(
		type('string'),
		FFMPEG_DEFAULT_GLOBAL_OPTIONS,
	),
	'recording.ffmpeg.inputOptions': defineEntry(
		type('string'),
		FFMPEG_DEFAULT_INPUT_OPTIONS,
	),
	'recording.ffmpeg.outputOptions': defineEntry(
		type('string'),
		FFMPEG_DEFAULT_OUTPUT_OPTIONS,
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

	// ── Self-hosted server URLs ───────────────────────────────────────
	'completion.custom.baseUrl': defineEntry(
		type('string'),
		'http://localhost:11434/v1',
	),

	// ── Global OS shortcuts (device-specific, never synced) ───────────
	'shortcuts.global.passthrough': defineEntry(type('boolean'), false),
	'shortcuts.global.toggleManualRecording': defineEntry(
		type('string | null'),
		`${CommandOrControl}+Shift+;` as string | null,
	),
	'shortcuts.global.startManualRecording': defineEntry(
		type('string | null'),
		null,
	),
	'shortcuts.global.stopManualRecording': defineEntry(
		type('string | null'),
		null,
	),
	'shortcuts.global.cancelManualRecording': defineEntry(
		type('string | null'),
		`${CommandOrControl}+Shift+'` as string | null,
	),
	'shortcuts.global.toggleVadRecording': defineEntry(
		type('string | null'),
		null,
	),
	'shortcuts.global.startVadRecording': defineEntry(
		type('string | null'),
		null,
	),
	'shortcuts.global.stopVadRecording': defineEntry(type('string | null'), null),
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

/** Infer the value type for a device config key from its definition. */
export type InferDeviceValue<K extends DeviceConfigKey> =
	DeviceConfigDefs[K]['defaultValue'];

// ── Singleton ────────────────────────────────────────────────────────────────

export const deviceConfig: PersistedMap<typeof DEVICE_DEFINITIONS> =
	createPersistedMap({
		prefix: 'whispering.device.',
		definitions: DEVICE_DEFINITIONS,
		onError: (key) => {
			console.warn(`Invalid device config for "${key}", using default`);
		},
		onUpdateError: (key, error) => {
			rpc.notify.error({
				title: 'Error updating device config',
				description: extractErrorMessage(error),
			});
		},
	});
