import { rpc } from '$lib/query';
import {
	type Settings,
	getDefaultSettings,
	settingsSchema,
} from '$lib/settings/settings';
import { enumerateDevices } from '$lib/services/device-stream';
import { createPersistedState } from '@repo/svelte-utils';
import {
	syncGlobalShortcutsWithSettings,
	syncLocalShortcutsWithSettings,
} from '../../routes/+layout/register-commands';
import { extractErrorMessage } from 'wellcrafted/error';
import * as services from '$lib/services';
import { recorderService } from '$lib/query/recorder';
import type { RecordingMode } from '$lib/constants/audio';
import type { RecorderServiceError } from '$lib/services/recorder';
import type { VadRecorderServiceError } from '$lib/services/vad-recorder';
import { nanoid } from 'nanoid/non-secure';
import { Ok, partitionResults, type Result } from 'wellcrafted/result';

/**
 * Encapsulated settings object with controlled access.
 * Provides read-only access to settings values and methods for controlled mutations.
 */
export const settings = (() => {
	// Private settings instance
	const _settings = createPersistedState({
		key: 'whispering-settings',
		schema: settingsSchema,
		onParseError: (error) => {
			// For empty storage, return defaults
			if (error.type === 'storage_empty') {
				return getDefaultSettings();
			}

			// For JSON parse errors, return defaults
			if (error.type === 'json_parse_error') {
				console.error('Failed to parse settings JSON:', error.error);
				return getDefaultSettings();
			}
			
			// For schema validation failures, return defaults
			if (error.type === 'schema_validation_failed') {
				return getDefaultSettings();
			}
			
			// For async validation (shouldn't happen with our schemas)
			if (error.type === 'schema_validation_async_during_sync') {
				console.warn('Unexpected async validation for settings');
				return getDefaultSettings();
			}

			// Fallback - should never reach here
			return getDefaultSettings();
		},
		onUpdateSuccess: () => {
			rpc.notify.success.execute({ title: 'Settings updated!', description: '' });
		},
		onUpdateError: (err) => {
			rpc.notify.error.execute({
				title: 'Error updating settings',
				description: extractErrorMessage(err),
			});
		},
	});

	// Private helper for shared reset logic
	function _resetShortcutDefaults(type: 'local' | 'global') {
		const defaultSettings = getDefaultSettings();

		// Build a partial settings object containing only the shortcuts we want to reset
		const updates = commands.reduce<Partial<Settings>>((acc, command) => {
			const shortcutKey = `shortcuts.${type}.${command.id}` as const;
			// Copy the default value for this specific shortcut from defaultSettings to our updates object
			acc[shortcutKey] = defaultSettings[shortcutKey];
			return acc;
		}, {});

		_settings.value = {
			..._settings.value,
			...updates,
		};
	}

	return {
		/**
		 * Read-only access to current settings values
		 */
		get value(): Settings {
			return _settings.value;
		},

		/**
		 * Update multiple settings at once
		 * @param updates Partial settings object with keys to update
		 */
		update(updates: Partial<Settings>) {
			_settings.value = { ..._settings.value, ...updates };
		},

		/**
		 * Update a single setting key
		 * @param key The setting key to update
		 * @param value The new value for the setting
		 */
		updateKey<K extends keyof Settings>(key: K, value: Settings[K]) {
			_settings.value = { ..._settings.value, [key]: value };
		},

		/**
		 * Reset all settings to their default values
		 */
		reset() {
			_settings.value = getDefaultSettings();
		},

		/**
		 * Reset local shortcuts to their default values
		 */
		resetLocalShortcuts() {
			_resetShortcutDefaults('local');
			syncLocalShortcutsWithSettings();
		},

		/**
		 * Reset global shortcuts to their default values
		 */
		resetGlobalShortcuts() {
			_resetShortcutDefaults('global');
			syncGlobalShortcutsWithSettings();
		},

		/**
		 * Switches the recording mode and automatically stops any active recordings.
		 * This ensures a clean transition between recording modes.
		 */
		async switchRecordingMode(newMode: RecordingMode) {
			const toastId = nanoid();

			// First, stop all active recordings except the new mode
			const { errs } = await stopAllRecordingModesExcept(newMode);

			if (errs.length > 0) {
				// Even if stopping fails, we should still switch modes
				console.error('Failed to stop active recordings:', errs);
				rpc.notify.warning.execute({
					id: toastId,
					title: '⚠️ Recording may still be active',
					description:
						'Previous recording could not be stopped automatically. Please stop it manually.',
				});
			}

			// Update the settings if not already in new mode
			if (_settings.value['recording.mode'] !== newMode) {
				_settings.value = {
					..._settings.value,
					'recording.mode': newMode,
				};

				// Show success notification
				rpc.notify.success.execute({
					id: toastId,
					title: '✅ Recording mode switched',
					description: `Switched to ${newMode} recording mode`,
				});
			}

			return Ok(newMode);
		},
	};
})();

/**
 * Ensures only one recording mode is active at a time by stopping all other modes.
 * This prevents conflicts between different recording methods and ensures clean transitions.
 *
 * @returns Object containing array of errors that occurred while stopping recordings
 */
async function stopAllRecordingModesExcept(modeToKeep: RecordingMode) {
	const { data: recorderState } = await recorderService().getRecorderState();

	// Each recording mode with its check and stop logic
	const recordingModes = [
		{
			mode: 'manual' as const,
			isActive: () => recorderState === 'RECORDING',
			stop: () => rpc.commands.stopManualRecording.execute(),
		},
		{
			mode: 'vad' as const,
			isActive: () => services.vad.getVadState() !== 'IDLE',
			stop: () => rpc.commands.stopVadRecording.execute(),
		},
	] satisfies {
		mode: RecordingMode;
		isActive: () => boolean;
		stop: () => Promise<unknown>;
	}[];

	// Filter to modes that need to be stopped
	const modesToStop = recordingModes.filter(
		(recordingMode) =>
			recordingMode.mode !== modeToKeep && recordingMode.isActive(),
	);

	// Create promises that wrap each stop call in try-catch
	const stopPromises = modesToStop.map(
		async (recordingMode) => await recordingMode.stop(),
	);

	// Execute all stops in parallel
	const results: Result<
		Blob | undefined,
		RecorderServiceError | VadRecorderServiceError
	>[] = await Promise.all(stopPromises);

	// Partition results into successes and errors
	const { errs } = partitionResults(results);

	return { errs };
}
