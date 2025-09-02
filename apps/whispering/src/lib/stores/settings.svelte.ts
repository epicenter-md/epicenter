import { commands } from '$lib/commands';
import { rpc } from '$lib/query';
import {
	type Settings,
	getDefaultSettings,
	parseStoredSettings,
	settingsSchema,
} from '$lib/settings/settings';
import { createPersistedState } from '@repo/svelte-utils';
import {
	syncGlobalShortcutsWithSettings,
	syncLocalShortcutsWithSettings,
} from '../../routes/+layout/register-commands';
import { extractErrorMessage } from 'wellcrafted/error';

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

			// For schema validation failures, use our progressive validation
			if (error.type === 'schema_validation_failed') {
				return parseStoredSettings(error.value);
			}

			// For async validation (shouldn't happen with our schemas)
			if (error.type === 'schema_validation_async_during_sync') {
				console.warn('Unexpected async validation for settings');
				return parseStoredSettings(error.value);
			}

			// Fallback - should never reach here
			return getDefaultSettings();
		},
		onUpdateSuccess: () => {
			rpc.notify.success.execute({
				title: 'Settings updated!',
				description: '',
			});
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
	};
})();
