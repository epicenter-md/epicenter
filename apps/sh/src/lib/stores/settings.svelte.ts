import { createPersistedState } from '@repo/svelte-utils';
import { type } from 'arktype';
import { Password } from '$lib/utils/port';

/**
 * Application settings that are persisted across sessions.
 * These settings provide default values for various features.
 */
const AppSettings = type({
	/**
	 * Default password for new assistant connections.
	 * This value is pre-populated when creating new assistants.
	 */
	defaultPassword: Password,
	/**
	 * Default username for new assistant connections.
	 * This value is pre-populated when creating new assistants.
	 */
	defaultUsername: 'string > 0',
});

export type AppSettings = typeof AppSettings.infer;

/**
 * The reactive store containing application settings.
 * Automatically synced with localStorage under the key 'opencode-settings'.
 */
export const settings = createPersistedState({
	key: 'opencode-settings',
	onParseError: (error) => {
		// Return default settings if anything goes wrong
		console.warn('Failed to load settings:', error);
		return {
			defaultPassword: 'password',
			defaultUsername: 'user',
		};
	},
	onUpdateError: (error) => {
		console.error('Failed to save settings:', error);
	},
	schema: AppSettings,
});
