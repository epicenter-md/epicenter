import { SvelteMap } from 'svelte/reactivity';
import { whispering } from '#platform/whispering';

type Kv = typeof whispering.kv;

/** Every setting's value type, keyed by setting key. */
type SettingsValues = ReturnType<Kv['getAll']>;

/**
 * Setting keys whose stored value is a boolean.
 *
 * The `<SettingSwitch>` component constrains its `key` prop to these, so the
 * generic flows through `settings.get`/`settings.set` and a non-boolean key
 * (a number like `retention.maxCount`, an enum like `recording.mode`) is a
 * compile error instead of a silently-broken toggle.
 */
export type BooleanSettingKey = {
	[K in keyof SettingsValues]: SettingsValues[K] extends boolean ? K : never;
}[keyof SettingsValues];

function createSettings() {
	const map = new SvelteMap<string, unknown>();

	// Initialize SvelteMap with current values for ALL KV keys.
	// kv.get() always returns a valid value (stored value or defaultValue).
	for (const key of whispering.settings.keys) {
		map.set(key, whispering.kv.get(key));
	}

	// Single observer for ALL KV changes (local or remote).
	// Observer updates SvelteMap → components re-render per-key.
	whispering.kv.observeAll((changes) => {
		for (const [key, change] of changes) {
			if (change.type === 'set') {
				map.set(key, change.value);
			} else if (change.type === 'delete') {
				// On delete, restore default value so map always has a value
				map.set(key, whispering.kv.get(key));
			}
		}
	});

	return {
		/**
		 * Get a synced workspace setting. Returns the current value from the
		 * reactive SvelteMap. Components reading this will re-render when the
		 * value changes (from local writes OR remote sync).
		 */
		get: ((key) => map.get(key)) as Kv['get'],

		/**
		 * Set a synced workspace setting. Writes to Yjs KV, which fires the
		 * observer, which updates the SvelteMap. Unidirectional: never set
		 * the SvelteMap directly.
		 */
		set: whispering.kv.set,

		/**
		 * The schema default for a setting key (the `defineKv` factory value).
		 * The single source for resets and default-display, so a setting's
		 * default lives only in the workspace definition, never in a parallel map.
		 */
		getDefault: whispering.settings.getDefault,

		/**
		 * Reset all workspace settings to their default values in a single
		 * Yjs transaction.
		 */
		reset: whispering.settings.reset,
	};
}

export const settings = createSettings();
