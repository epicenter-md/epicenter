/**
 * One-time migration from the old monolithic `whispering-settings` localStorage
 * blob to the new per-key stores (workspace KV + device config localStorage).
 *
 * Runs automatically on boot. Safe to run multiple times (idempotent).
 * Per-key failure doesn't abort the whole migration.
 *
 * @see specs/20260313T163000-settings-data-migration.md
 */

import { Ok, tryAsync, trySync } from 'wellcrafted/result';
import { workspace } from '$lib/client';
import { deviceConfig } from '$lib/state/device-config.svelte';

// ── Migration state ──────────────────────────────────────────────────────────

const MIGRATION_STATE_KEY = 'whispering:settings-migration';
type MigrationState = 'completed' | 'not-needed';

function getMigrationState(): MigrationState | null {
	return window.localStorage.getItem(
		MIGRATION_STATE_KEY,
	) as MigrationState | null;
}

function setMigrationState(state: MigrationState): void {
	window.localStorage.setItem(MIGRATION_STATE_KEY, state);
}

// Type-widened accessors for dynamic key writes. The mapping tables guarantee
// runtime correctness; these bypass the generic constraints that require
// literal key types we can't produce from a data-driven loop.
const setKv = workspace.kv.set as (key: string, value: unknown) => void;
const getKv = workspace.kv.get as (key: string) => unknown;
const getKvDefault = (key: string) =>
	(workspace.definitions.kv as Record<string, { defaultValue: unknown }>)[key]
		?.defaultValue;

/**
 * Migrate old settings from the monolithic `whispering-settings` localStorage
 * blob to per-key workspace KV and device config stores.
 *
 * **Must be called after workspace and device-config are initialized.**
 * Awaits `workspace.whenReady` internally to ensure IndexedDB persistence
 * has loaded before checking first-write-wins conditions.
 *
 * Silent, automatic, idempotent. One bad key doesn't abort the migration.
 */
export async function migrateOldSettings(): Promise<void> {
	const state = getMigrationState();
	if (state !== null) return;

	// Read old blobs before any async work
	const oldSettingsRaw = window.localStorage.getItem('whispering-settings');
	const oldDeviceConfigRaw = window.localStorage.getItem(
		'whispering-device-config',
	);

	// No old data at all — fresh install
	if (!oldSettingsRaw && !oldDeviceConfigRaw) {
		setMigrationState('not-needed');
		return;
	}

	// Parse old blobs
	const oldSettings = tryParseJson(oldSettingsRaw);
	const oldDeviceConfig = tryParseJson(oldDeviceConfigRaw);

	// Both parse failures — nothing to migrate
	if (!oldSettings && !oldDeviceConfig) {
		setMigrationState('completed');
		return;
	}

	// Wait for IndexedDB persistence to load so workspace.kv.get() returns
	// real persisted values (not defaults). This ensures the first-write-wins
	// check correctly detects user-set values.
	const { error: readyError } = await tryAsync({
		try: () => workspace.whenReady,
		catch: (err) => {
			console.warn(
				'[settings-migration] workspace.whenReady failed, aborting:',
				err,
			);
			return Ok(undefined);
		},
	});
	if (readyError) return;

	// ── Migrate workspace keys ───────────────────────────────────────────────────
	// Batch into a single Yjs transaction so settings.observeAll
	// fires once with all changes, not 43 individual updates.

	workspace.batch(() => {
		for (const { oldKey, newKey, convert } of WORKSPACE_KEY_MAP) {
			trySync({
				try: () => {
					const raw = oldSettings?.[oldKey];
					if (raw === undefined || raw === null) return;

					// First-write-wins: skip if user already changed this setting
					if (getKv(newKey) !== getKvDefault(newKey)) return;

					const value = convert ? convert(raw) : raw;
					if (value === undefined) return;

					setKv(newKey, value);
				},
				catch: (err) => {
					console.warn(`[settings-migration] workspace key "${oldKey}":`, err);
					return Ok(undefined);
				},
			});
		}
	});

	// ── Migrate device keys ──────────────────────────────────────────────────────
	// Priority: per-key localStorage > whispering-device-config > whispering-settings

	for (const { oldKey, newKey } of DEVICE_KEY_MAP) {
		trySync({
			try: () => {
				// Already has a per-key entry — user-set or prior migration run
				if (window.localStorage.getItem(`whispering.device.${newKey}`) !== null)
					return;

				// Look up from monolithic device-config blob first (uses NEW key names),
				// then fall back to the original settings blob (uses OLD key names)
				const raw = oldDeviceConfig?.[newKey] ?? oldSettings?.[oldKey];
				if (raw === undefined || raw === null) return;

				(deviceConfig.set as (key: string, value: unknown) => void)(
					newKey,
					raw,
				);
			},
			catch: (err) => {
				console.warn(`[settings-migration] device key "${oldKey}":`, err);
				return Ok(undefined);
			},
		});
	}

	// ── Cleanup ────────────────────────────────────────────────────────────

	window.localStorage.removeItem('whispering-settings');
	window.localStorage.removeItem('whispering-device-config');
	setMigrationState('completed');
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function tryParseJson(raw: string | null): Record<string, unknown> | null {
	if (!raw) return null;
	const { data } = trySync({
		try: () => JSON.parse(raw) as unknown,
		catch: () => Ok(null),
	});
	if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
		return data as Record<string, unknown>;
	}
	return null;
}

function toNumber(raw: unknown): number | undefined {
	if (typeof raw === 'number') return raw;
	if (typeof raw === 'string') {
		const n = parseFloat(raw);
		return Number.isNaN(n) ? undefined : n;
	}
	return undefined;
}

function toInteger(raw: unknown): number | undefined {
	if (typeof raw === 'number') return Number.isInteger(raw) ? raw : undefined;
	if (typeof raw === 'string') {
		const n = parseInt(raw, 10);
		return Number.isNaN(n) ? undefined : n;
	}
	return undefined;
}

// ── Key mappings ─────────────────────────────────────────────────────────────

/**
 * Maps old `whispering-settings` blob keys to new workspace KV keys.
 * Two keys require type conversion (string → number).
 */
const WORKSPACE_KEY_MAP: readonly {
	oldKey: string;
	newKey: string;
	convert?: (raw: unknown) => unknown;
}[] = [
	// Sound toggles
	{ oldKey: 'sound.playOn.manual-start', newKey: 'sound.manualStart' },
	{ oldKey: 'sound.playOn.manual-stop', newKey: 'sound.manualStop' },
	{ oldKey: 'sound.playOn.manual-cancel', newKey: 'sound.manualCancel' },
	{ oldKey: 'sound.playOn.vad-start', newKey: 'sound.vadStart' },
	{ oldKey: 'sound.playOn.vad-capture', newKey: 'sound.vadCapture' },
	{ oldKey: 'sound.playOn.vad-stop', newKey: 'sound.vadStop' },
	{
		oldKey: 'sound.playOn.transcriptionComplete',
		newKey: 'sound.transcriptionComplete',
	},
	{
		oldKey: 'sound.playOn.transformationComplete',
		newKey: 'sound.transformationComplete',
	},

	// Output behavior
	{
		oldKey: 'transcription.copyToClipboardOnSuccess',
		newKey: 'output.transcription.clipboard',
	},
	{
		oldKey: 'transcription.writeToCursorOnSuccess',
		newKey: 'output.transcription.cursor',
	},
	{
		oldKey: 'transcription.simulateEnterAfterOutput',
		newKey: 'output.transcription.enter',
	},
	{
		oldKey: 'transformation.copyToClipboardOnSuccess',
		newKey: 'output.transformation.clipboard',
	},
	{
		oldKey: 'transformation.writeToCursorOnSuccess',
		newKey: 'output.transformation.cursor',
	},
	{
		oldKey: 'transformation.simulateEnterAfterOutput',
		newKey: 'output.transformation.enter',
	},

	// UI
	{ oldKey: 'system.alwaysOnTop', newKey: 'ui.alwaysOnTop' },

	// Data retention (maxCount: string → number)
	{
		oldKey: 'database.recordingRetentionStrategy',
		newKey: 'retention.strategy',
	},
	{
		oldKey: 'database.maxRecordingCount',
		newKey: 'retention.maxCount',
		convert: toInteger,
	},

	// Recording
	{ oldKey: 'recording.mode', newKey: 'recording.mode' },

	// Transcription (temperature: string → number)
	{
		oldKey: 'transcription.selectedTranscriptionService',
		newKey: 'transcription.service',
	},
	{
		oldKey: 'transcription.openai.model',
		newKey: 'transcription.openai.model',
	},
	{ oldKey: 'transcription.groq.model', newKey: 'transcription.groq.model' },
	{
		oldKey: 'transcription.elevenlabs.model',
		newKey: 'transcription.elevenlabs.model',
	},
	{
		oldKey: 'transcription.deepgram.model',
		newKey: 'transcription.deepgram.model',
	},
	{
		oldKey: 'transcription.mistral.model',
		newKey: 'transcription.mistral.model',
	},
	{ oldKey: 'transcription.outputLanguage', newKey: 'transcription.language' },
	{ oldKey: 'transcription.prompt', newKey: 'transcription.prompt' },
	{
		oldKey: 'transcription.temperature',
		newKey: 'transcription.temperature',
		convert: toNumber,
	},
	{
		oldKey: 'transcription.compressionEnabled',
		newKey: 'transcription.compressionEnabled',
	},
	{
		oldKey: 'transcription.compressionOptions',
		newKey: 'transcription.compressionOptions',
	},

	// Transformation
	{
		oldKey: 'transformations.selectedTransformationId',
		newKey: 'transformation.selectedId',
	},
	{
		oldKey: 'completion.openrouter.model',
		newKey: 'transformation.openrouterModel',
	},

	// Analytics
	{ oldKey: 'analytics.enabled', newKey: 'analytics.enabled' },

	// Local shortcuts
	{
		oldKey: 'shortcuts.local.toggleManualRecording',
		newKey: 'shortcut.toggleManualRecording',
	},
	{
		oldKey: 'shortcuts.local.startManualRecording',
		newKey: 'shortcut.startManualRecording',
	},
	{
		oldKey: 'shortcuts.local.stopManualRecording',
		newKey: 'shortcut.stopManualRecording',
	},
	{
		oldKey: 'shortcuts.local.cancelManualRecording',
		newKey: 'shortcut.cancelManualRecording',
	},
	{
		oldKey: 'shortcuts.local.toggleVadRecording',
		newKey: 'shortcut.toggleVadRecording',
	},
	{
		oldKey: 'shortcuts.local.startVadRecording',
		newKey: 'shortcut.startVadRecording',
	},
	{
		oldKey: 'shortcuts.local.stopVadRecording',
		newKey: 'shortcut.stopVadRecording',
	},
	{ oldKey: 'shortcuts.local.pushToTalk', newKey: 'shortcut.pushToTalk' },
	{
		oldKey: 'shortcuts.local.openTransformationPicker',
		newKey: 'shortcut.openTransformationPicker',
	},
	{
		oldKey: 'shortcuts.local.runTransformationOnClipboard',
		newKey: 'shortcut.runTransformationOnClipboard',
	},
] as const;

/**
 * Maps old blob keys to new device config keys.
 * Device keys are looked up in two blobs with priority:
 *   1. Per-key localStorage (already exists → skip)
 *   2. `whispering-device-config` monolithic blob (from brief interim period)
 *   3. `whispering-settings` original blob
 */
const DEVICE_KEY_MAP: readonly { oldKey: string; newKey: string }[] = [
	// API keys
	{ oldKey: 'apiKeys.openai', newKey: 'apiKeys.openai' },
	{ oldKey: 'apiKeys.anthropic', newKey: 'apiKeys.anthropic' },
	{ oldKey: 'apiKeys.groq', newKey: 'apiKeys.groq' },
	{ oldKey: 'apiKeys.google', newKey: 'apiKeys.google' },
	{ oldKey: 'apiKeys.deepgram', newKey: 'apiKeys.deepgram' },
	{ oldKey: 'apiKeys.elevenlabs', newKey: 'apiKeys.elevenlabs' },
	{ oldKey: 'apiKeys.mistral', newKey: 'apiKeys.mistral' },
	{ oldKey: 'apiKeys.openrouter', newKey: 'apiKeys.openrouter' },
	{ oldKey: 'apiKeys.custom', newKey: 'apiKeys.custom' },

	// API endpoints
	{ oldKey: 'apiEndpoints.openai', newKey: 'apiEndpoints.openai' },
	{ oldKey: 'apiEndpoints.groq', newKey: 'apiEndpoints.groq' },

	// Recording hardware
	{ oldKey: 'recording.method', newKey: 'recording.method' },
	{ oldKey: 'recording.cpal.deviceId', newKey: 'recording.cpal.deviceId' },
	{
		oldKey: 'recording.navigator.deviceId',
		newKey: 'recording.navigator.deviceId',
	},
	{ oldKey: 'recording.ffmpeg.deviceId', newKey: 'recording.ffmpeg.deviceId' },
	{
		oldKey: 'recording.navigator.bitrateKbps',
		newKey: 'recording.navigator.bitrateKbps',
	},
	{
		oldKey: 'recording.cpal.outputFolder',
		newKey: 'recording.cpal.outputFolder',
	},
	{ oldKey: 'recording.cpal.sampleRate', newKey: 'recording.cpal.sampleRate' },
	{
		oldKey: 'recording.ffmpeg.globalOptions',
		newKey: 'recording.ffmpeg.globalOptions',
	},
	{
		oldKey: 'recording.ffmpeg.inputOptions',
		newKey: 'recording.ffmpeg.inputOptions',
	},
	{
		oldKey: 'recording.ffmpeg.outputOptions',
		newKey: 'recording.ffmpeg.outputOptions',
	},

	// Local model paths
	{
		oldKey: 'transcription.speaches.baseUrl',
		newKey: 'transcription.speaches.baseUrl',
	},
	{
		oldKey: 'transcription.speaches.modelId',
		newKey: 'transcription.speaches.modelId',
	},
	{
		oldKey: 'transcription.whispercpp.modelPath',
		newKey: 'transcription.whispercpp.modelPath',
	},
	{
		oldKey: 'transcription.parakeet.modelPath',
		newKey: 'transcription.parakeet.modelPath',
	},
	{
		oldKey: 'transcription.moonshine.modelPath',
		newKey: 'transcription.moonshine.modelPath',
	},

	// Self-hosted server URLs
	{ oldKey: 'completion.custom.baseUrl', newKey: 'completion.custom.baseUrl' },

	// Global shortcuts (same key names in old and new)
	{
		oldKey: 'shortcuts.global.toggleManualRecording',
		newKey: 'shortcuts.global.toggleManualRecording',
	},
	{
		oldKey: 'shortcuts.global.startManualRecording',
		newKey: 'shortcuts.global.startManualRecording',
	},
	{
		oldKey: 'shortcuts.global.stopManualRecording',
		newKey: 'shortcuts.global.stopManualRecording',
	},
	{
		oldKey: 'shortcuts.global.cancelManualRecording',
		newKey: 'shortcuts.global.cancelManualRecording',
	},
	{
		oldKey: 'shortcuts.global.toggleVadRecording',
		newKey: 'shortcuts.global.toggleVadRecording',
	},
	{
		oldKey: 'shortcuts.global.startVadRecording',
		newKey: 'shortcuts.global.startVadRecording',
	},
	{
		oldKey: 'shortcuts.global.stopVadRecording',
		newKey: 'shortcuts.global.stopVadRecording',
	},
	{
		oldKey: 'shortcuts.global.pushToTalk',
		newKey: 'shortcuts.global.pushToTalk',
	},
	{
		oldKey: 'shortcuts.global.openTransformationPicker',
		newKey: 'shortcuts.global.openTransformationPicker',
	},
	{
		oldKey: 'shortcuts.global.runTransformationOnClipboard',
		newKey: 'shortcuts.global.runTransformationOnClipboard',
	},
] as const;
