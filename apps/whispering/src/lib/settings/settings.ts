/**
 * @fileoverview Migration-free settings management system
 *
 * This module implements a robust settings system that eliminates the need for
 * version migrations. Instead of maintaining multiple schema versions and migration
 * functions, we use a progressive validation approach that:
 *
 * 1. Preserves valid settings from any previous version
 * 2. Silently discards invalid or unknown keys
 * 3. Applies defaults for missing required fields
 *
 * ## Design Decisions
 *
 * - **Flat key structure**: All settings use dot-notation keys (e.g., 'sound.playOn.manual-start')
 *   stored as a single-level object. This simplifies validation and merging.
 *
 * - **Schema with defaults**: Every field in the schema has a default value,
 *   ensuring we can always produce a valid settings object.
 *
 * - **Progressive validation**: When full validation fails, we attempt partial validation
 *   and finally key-by-key validation to recover as much valid data as possible.
 *
 * ## Benefits over versioned schemas
 *
 * - No migration code to maintain
 * - Automatic forward compatibility
 * - Graceful handling of corrupted settings
 * - Simpler codebase
 * - Easy to add/remove/rename settings
 */

import { type } from 'arktype';
import {
	BITRATES_KBPS,
	DEFAULT_BITRATE_KBPS,
	RECORDING_MODES,
} from '$lib/constants/audio';
import { CommandOrAlt, CommandOrControl } from '$lib/constants/keyboard';
import { SUPPORTED_LANGUAGES } from '$lib/constants/languages';
import { ALWAYS_ON_TOP_MODES, LAYOUT_MODES } from '$lib/constants/ui';
import {
	FFMPEG_DEFAULT_COMPRESSION_OPTIONS,
	FFMPEG_DEFAULT_GLOBAL_OPTIONS,
	FFMPEG_DEFAULT_INPUT_OPTIONS,
	FFMPEG_DEFAULT_OUTPUT_OPTIONS,
} from '$lib/services/desktop/recorder/ffmpeg';
import type { DeepgramModel } from '$lib/services/isomorphic/transcription/cloud/deepgram';
import type { ElevenLabsModel } from '$lib/services/isomorphic/transcription/cloud/elevenlabs';
import type { GroqModel } from '$lib/services/isomorphic/transcription/cloud/groq';
import type { MistralModel } from '$lib/services/isomorphic/transcription/cloud/mistral';
import type { OpenAIModel } from '$lib/services/isomorphic/transcription/cloud/openai';
import { TRANSCRIPTION_SERVICE_IDS } from '$lib/services/isomorphic/transcription/registry';
import { asDeviceIdentifier, type DeviceIdentifier } from '$lib/services/types';

// Helper to transform device identifiers
const deviceIdTransform = (val: string | null): DeviceIdentifier | null =>
	val ? asDeviceIdentifier(val) : null;

/**
 * The main settings schema that defines all application settings.
 *
 * All settings are stored as a flat object with dot-notation keys for logical grouping.
 * Every field has a default value to ensure the application can always start with valid settings.
 *
 * ## Key naming conventions:
 * - `sound.playOn.*` - Sound effect toggles for various events
 * - `transcription.*` - Transcription service configuration
 * - `transformation.*` - Text transformation settings
 * - `recording.*` - Recording mode and device settings
 * - `shortcuts.*` - Keyboard shortcut mappings
 * - `apiKeys.*` - Service API keys
 * - `system.*` - System-level preferences
 * - `database.*` - Data retention policies
 *
 * @example
 * // Access a setting
 * const shouldPlaySound = settings.value['sound.playOn.manual-start'];
 *
 * // Update a setting
 * settings.value = {
 *   ...settings.value,
 *   'transcription.outputLanguage': 'en'
 * };
 */
export const Settings = type({
	// Sound settings
	'sound.playOn.manual-start': 'boolean = true',
	'sound.playOn.manual-stop': 'boolean = true',
	'sound.playOn.manual-cancel': 'boolean = true',
	'sound.playOn.vad-start': 'boolean = true',
	'sound.playOn.vad-capture': 'boolean = true',
	'sound.playOn.vad-stop': 'boolean = true',
	'sound.playOn.transcriptionComplete': 'boolean = true',
	'sound.playOn.transformationComplete': 'boolean = true',

	'transcription.copyToClipboardOnSuccess': 'boolean = true',
	'transcription.writeToCursorOnSuccess': 'boolean = true',
	'transcription.simulateEnterAfterOutput': 'boolean = false',
	'transformation.copyToClipboardOnSuccess': 'boolean = true',
	'transformation.writeToCursorOnSuccess': 'boolean = false',
	'transformation.simulateEnterAfterOutput': 'boolean = false',

	'system.alwaysOnTop': type
		.enumerated(...ALWAYS_ON_TOP_MODES)
		.default('Never'),

	// UI settings
	/**
	 * Navigation layout mode.
	 * - `sidebar`: Uses the collapsible vertical sidebar. Nav items show on home, hidden on config pages.
	 * - `nav-items`: Uses inline header navigation. No sidebar, nav items visible on all pages.
	 */
	'ui.layoutMode': type.enumerated(...LAYOUT_MODES).default('sidebar'),

	'database.recordingRetentionStrategy': type
		.enumerated('keep-forever', 'limit-count')
		.default('keep-forever'),
	'database.maxRecordingCount': type('string.digits').default('100'),

	// Recording mode settings
	'recording.mode': type.enumerated(...RECORDING_MODES).default('manual'),
	/**
	 * Recording method to use for manual recording in desktop app.
	 * - 'cpal': Uses Rust audio recording method (CPAL)
	 * - 'navigator': Uses MediaRecorder API (web standard)
	 * - 'ffmpeg': Uses FFmpeg command-line tool for recording
	 */
	'recording.method': type
		.enumerated('cpal', 'navigator', 'ffmpeg')
		.default('cpal'),

	/**
	 * Device identifiers for each recording method.
	 * Each method remembers its own selected device.
	 * Note: VAD always uses navigator, so it shares the same device ID.
	 */
	'recording.cpal.deviceId': type('string | null')
		.pipe(deviceIdTransform)
		.default('default'),
	'recording.navigator.deviceId': type('string | null')
		.pipe(deviceIdTransform)
		.default('default'),
	'recording.ffmpeg.deviceId': type('string | null')
		.pipe(deviceIdTransform)
		.default('default'),

	// Browser recording settings (used when browser method is selected)
	'recording.navigator.bitrateKbps': type
		.enumerated(...BITRATES_KBPS)
		.default(DEFAULT_BITRATE_KBPS),

	// CPAL (Rust audio library) recording settings
	'recording.cpal.outputFolder': 'string | null = null', // null = use app data dir
	'recording.cpal.sampleRate': type
		.enumerated('16000', '44100', '48000')
		.default('16000'),

	// FFmpeg recording settings - split into three customizable parts
	'recording.ffmpeg.globalOptions': type('string').default(
		FFMPEG_DEFAULT_GLOBAL_OPTIONS,
	), // Global FFmpeg options (e.g., "-hide_banner -loglevel warning")
	'recording.ffmpeg.inputOptions': type('string').default(
		FFMPEG_DEFAULT_INPUT_OPTIONS,
	), // Input options (e.g., "-f avfoundation" - platform defaults applied if empty)
	'recording.ffmpeg.outputOptions': type('string').default(
		FFMPEG_DEFAULT_OUTPUT_OPTIONS,
	), // OGG Vorbis optimized for Whisper: 16kHz mono, 64kbps

	'transcription.selectedTranscriptionService': type
		.enumerated(...TRANSCRIPTION_SERVICE_IDS)
		.default('moonshine'),
	// Shared settings in transcription
	'transcription.outputLanguage': type
		.enumerated(...SUPPORTED_LANGUAGES)
		.default('auto'),
	'transcription.prompt': "string = ''",
	'transcription.temperature': "string = '0.0'",
	// Audio compression settings
	'transcription.compressionEnabled': 'boolean = false',
	'transcription.compressionOptions': type('string').default(
		FFMPEG_DEFAULT_COMPRESSION_OPTIONS,
	),

	// Service-specific settings
	'transcription.openai.model': type('string')
		.pipe((val) => val as (string & {}) | OpenAIModel['name'])
		.default('gpt-4o-mini-transcribe' satisfies OpenAIModel['name']),
	'transcription.elevenlabs.model': type('string')
		.pipe((val) => val as (string & {}) | ElevenLabsModel['name'])
		.default('scribe_v1' satisfies ElevenLabsModel['name']),
	'transcription.groq.model': type('string')
		.pipe((val) => val as (string & {}) | GroqModel['name'])
		.default('whisper-large-v3-turbo' satisfies GroqModel['name']),
	'transcription.deepgram.model': type('string')
		.pipe((val) => val as (string & {}) | DeepgramModel['name'])
		.default('nova-3' satisfies DeepgramModel['name']),
	'transcription.mistral.model': type('string')
		.pipe((val) => val as (string & {}) | MistralModel['name'])
		.default('voxtral-mini-latest' satisfies MistralModel['name']),
	'transcription.speaches.baseUrl': "string = 'http://localhost:8000'",
	'transcription.speaches.modelId': type('string').default(
		'Systran/faster-distil-whisper-small.en',
	),
	'transcription.whispercpp.modelPath': "string = ''",
	'transcription.parakeet.modelPath': "string = ''",
	'transcription.moonshine.modelPath': "string = ''",

	'transformations.selectedTransformationId': 'string | null = null',

	'completion.openrouter.model': "string = 'mistralai/mixtral-8x7b'",
	// Global default for custom endpoints. Can be overridden per-step in transformations.
	// Most users have one local LLM server, so this saves re-entering the URL each time.
	'completion.custom.baseUrl': "string = 'http://localhost:11434/v1'",

	'apiKeys.openai': "string = ''",
	'apiKeys.anthropic': "string = ''",
	'apiKeys.groq': "string = ''",
	'apiKeys.google': "string = ''",
	'apiKeys.deepgram': "string = ''",
	'apiKeys.elevenlabs': "string = ''",
	'apiKeys.mistral': "string = ''",
	'apiKeys.openrouter': "string = ''",
	'apiKeys.custom': "string = ''",

	// API endpoint overrides (empty string = use default endpoint)
	'apiEndpoints.openai': "string = ''",
	'apiEndpoints.groq': "string = ''",

	// Analytics settings
	'analytics.enabled': 'boolean = true',

	// Local shortcuts (in-app shortcuts)
	'shortcuts.local.toggleManualRecording': "string | null = ' '",
	'shortcuts.local.startManualRecording': 'string | null = null',
	'shortcuts.local.stopManualRecording': 'string | null = null',
	'shortcuts.local.cancelManualRecording': "string | null = 'c'",
	'shortcuts.local.toggleVadRecording': "string | null = 'v'",
	'shortcuts.local.startVadRecording': 'string | null = null',
	'shortcuts.local.stopVadRecording': 'string | null = null',
	'shortcuts.local.pushToTalk': "string | null = 'p'",
	'shortcuts.local.openTransformationPicker': "string | null = 't'",
	'shortcuts.local.runTransformationOnClipboard': "string | null = 'r'",

	// Global shortcuts (system-wide shortcuts)
	'shortcuts.global.toggleManualRecording': type('string | null').default(
		`${CommandOrControl}+Shift+;`,
	),
	'shortcuts.global.startManualRecording': 'string | null = null',
	'shortcuts.global.stopManualRecording': 'string | null = null',
	'shortcuts.global.cancelManualRecording': type('string | null').default(
		`${CommandOrControl}+Shift+'`,
	),
	'shortcuts.global.toggleVadRecording': 'string | null = null',
	'shortcuts.global.startVadRecording': 'string | null = null',
	'shortcuts.global.stopVadRecording': 'string | null = null',
	'shortcuts.global.pushToTalk': type('string | null').default(
		`${CommandOrAlt}+Shift+D`,
	),
	'shortcuts.global.openTransformationPicker': type('string | null').default(
		`${CommandOrControl}+Shift+X`,
	),
	'shortcuts.global.runTransformationOnClipboard': type(
		'string | null',
	).default(`${CommandOrControl}+Shift+R`),
});

/**
 * The TypeScript type for validated settings, inferred from the Arktype schema.
 * This is the source of truth for all settings throughout the application.
 *
 * @see Settings - The Arktype schema that defines this type
 */
export type Settings = typeof Settings.infer;

/**
 * Get default settings by parsing an empty object, which will use all the default values
 * defined in the schema.
 *
 * @returns A complete settings object with all default values
 *
 * @example
 * // Get fresh default settings
 * const defaults = getDefaultSettings();
 * console.log(defaults['transcription.outputLanguage']); // 'auto'
 * console.log(defaults['sound.playOn.manual-start']); // true
 *
 * @example
 * // Reset a specific setting to default
 * const defaults = getDefaultSettings();
 * settings.value = {
 *   ...settings.value,
 *   'transcription.temperature': defaults['transcription.temperature']
 * };
 */
export function getDefaultSettings(): Settings {
	const result = Settings({});
	if (result instanceof type.errors) {
		// This should never happen since all fields have defaults
		throw new Error(`Failed to get default settings: ${result.summary}`);
	}
	return result;
}

/**
 * Parses and validates stored settings using a three-tier progressive validation strategy.
 * This function ensures we always return valid settings, preserving as much user data as possible
 * while gracefully handling corrupted, outdated, or partial settings.
 *
 * ## Validation Strategy:
 *
 * 1. **Full validation** - Try to parse the entire stored value as-is
 * 2. **Partial validation** - If full validation fails, validate against a partial schema
 *    and merge valid keys with defaults
 * 3. **Key-by-key validation** - As a last resort, validate each key individually,
 *    keeping only valid key-value pairs
 *
 * @param storedValue - The raw value from storage (usually from localStorage)
 * @returns A valid Settings object, guaranteed to match the current schema
 *
 * @example
 * // Case 1: Valid settings pass through unchanged
 * const stored = { 'sound.playOn.manual-start': false, ...otherValidSettings };
 * const result = parseStoredSettings(stored);
 * console.log(result['sound.playOn.manual-start']); // false
 *
 * @example
 * // Case 2: Partially valid settings merge with defaults
 * const stored = {
 *   'sound.playOn.manual-start': false,  // valid
 *   'obsolete.setting': 'value',          // invalid - will be discarded
 *   // missing required settings will use defaults
 * };
 * const result = parseStoredSettings(stored);
 * console.log(result['sound.playOn.manual-start']); // false (preserved)
 * console.log(result['transcription.outputLanguage']); // 'auto' (default)
 *
 * @example
 * // Case 3: Individual values that fail validation use defaults
 * const stored = {
 *   'transcription.temperature': 'invalid', // wrong type
 *   'sound.playOn.manual-start': false,     // valid
 * };
 * const result = parseStoredSettings(stored);
 * console.log(result['transcription.temperature']); // '0.0' (default)
 * console.log(result['sound.playOn.manual-start']); // false (preserved)
 *
 * @example
 * // Case 4: Non-object input returns complete defaults
 * const result1 = parseStoredSettings(null);
 * const result2 = parseStoredSettings('corrupted');
 * const result3 = parseStoredSettings(undefined);
 * // All return getDefaultSettings()
 */
export function parseStoredSettings(storedValue: unknown): Settings {
	// Migrate old settings keys to new ones
	if (typeof storedValue === 'object' && storedValue !== null) {
		const migrated = { ...storedValue } as Record<string, unknown>;

		// Migrate clipboard settings to new names
		if ('transcription.clipboard.copyOnSuccess' in migrated) {
			migrated['transcription.copyToClipboardOnSuccess'] =
				migrated['transcription.clipboard.copyOnSuccess'];
			delete migrated['transcription.clipboard.copyOnSuccess'];
		}
		if ('transcription.clipboard.pasteOnSuccess' in migrated) {
			migrated['transcription.writeToCursorOnSuccess'] =
				migrated['transcription.clipboard.pasteOnSuccess'];
			delete migrated['transcription.clipboard.pasteOnSuccess'];
		}
		if ('transformation.clipboard.copyOnSuccess' in migrated) {
			migrated['transformation.copyToClipboardOnSuccess'] =
				migrated['transformation.clipboard.copyOnSuccess'];
			delete migrated['transformation.clipboard.copyOnSuccess'];
		}
		if ('transformation.clipboard.pasteOnSuccess' in migrated) {
			migrated['transformation.writeToCursorOnSuccess'] =
				migrated['transformation.clipboard.pasteOnSuccess'];
			delete migrated['transformation.clipboard.pasteOnSuccess'];
		}

		// Migrate old navigation boolean settings to new layoutMode enum
		if ('ui.showSidebar' in migrated || 'ui.showNavItems' in migrated) {
			const showSidebar = migrated['ui.showSidebar'] ?? true;
			// If sidebar was enabled, use sidebar mode; otherwise use nav-items mode
			migrated['ui.layoutMode'] = showSidebar ? 'sidebar' : 'nav-items';
			delete migrated['ui.showSidebar'];
			delete migrated['ui.showNavItems'];
		}

		storedValue = migrated;
	}

	// First, try to parse the entire value
	const fullResult = Settings(storedValue);
	if (!(fullResult instanceof type.errors)) {
		return fullResult;
	}

	// If it's not an object, return defaults
	if (typeof storedValue !== 'object' || storedValue === null) {
		return getDefaultSettings();
	}

	// Get defaults and try to merge valid keys
	const defaults = getDefaultSettings();
	const validatedSettings: Record<string, unknown> = {};

	// Since settings are flat (one layer deep), we can iterate through stored keys
	for (const [key, value] of Object.entries(
		storedValue as Record<string, unknown>,
	)) {
		// Check if this key exists in the schema by checking if it's in defaults
		if (key in defaults) {
			// Keep the stored value - we'll rely on defaults for invalid values later
			validatedSettings[key] = value;
		}
		// Invalid/unknown keys are silently discarded
	}

	// Merge validated keys with defaults
	const finalSettings = {
		...defaults,
		...validatedSettings,
	};

	// Do one final validation to ensure the result is valid
	const result = Settings(finalSettings);
	if (!(result instanceof type.errors)) {
		return result;
	}

	// If merge validation fails, try key-by-key validation
	const keyByKeySettings: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(validatedSettings)) {
		// Create a test object with just this key and defaults
		const testObject = { ...defaults, [key]: value };
		const testResult = Settings(testObject);
		if (!(testResult instanceof type.errors)) {
			// This key-value pair is valid, keep it
			keyByKeySettings[key] = value;
		}
		// Invalid values are silently discarded, will use defaults
	}

	// Final merge with defaults
	const keyByKeyFinal = {
		...defaults,
		...keyByKeySettings,
	};

	const keyByKeyResult = Settings(keyByKeyFinal);
	if (!(keyByKeyResult instanceof type.errors)) {
		return keyByKeyResult;
	}

	// If all else fails, return defaults
	return defaults;
}
