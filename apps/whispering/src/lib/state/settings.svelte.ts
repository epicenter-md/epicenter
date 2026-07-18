import { SvelteMap } from 'svelte/reactivity';
import {
	onWhisperingRecordsChanged,
	settingsDefaults,
	whispering,
} from '#platform/whispering';
import type { WhisperingSettingValues } from '$lib/workspace';

export type BooleanSettingKey = {
	[K in keyof WhisperingSettingValues]: WhisperingSettingValues[K] extends boolean
		? K
		: never;
}[keyof WhisperingSettingValues];

function clone<TValue>(value: TValue): TValue {
	return structuredClone(value);
}

function createSettings() {
	const map = new SvelteMap<keyof WhisperingSettingValues, unknown>();
	const keys = Object.keys(settingsDefaults) as Array<
		keyof WhisperingSettingValues
	>;
	// Seed defaults synchronously so `get` is never undefined; the boot gate
	// awaits `whenReady` before first paint, so users still only ever see
	// hydrated values.
	for (const key of keys) map.set(key, clone(settingsDefaults[key]));

	async function refreshKey<TKey extends keyof WhisperingSettingValues>(
		key: TKey,
	): Promise<void> {
		const { data: storedValue, error } = await whispering.kv.get(key);
		if (error) {
			// A newer release may own this value. Use local policy without repair.
			map.set(key, clone(settingsDefaults[key]));
			return;
		}
		map.set(key, clone(storedValue ?? settingsDefaults[key]));
	}

	// Subscribe before the first reads: a records-changed event that lands
	// during initial hydration must still trigger a re-read, or the cache
	// starts stale until the next change.
	const unsubscribe = onWhisperingRecordsChanged(
		() => void Promise.all(keys.map(refreshKey)),
	);
	// The initial reads queue behind the runtime's storage acquisition; the
	// root gate awaits this before rendering, exactly like the old top-level
	// await, but a failure now lands on the gate instead of blanking the page.
	const whenReady = Promise.all(keys.map(refreshKey)).then(() => undefined);
	// This module is a singleton; without this, each hot reload leaves the old
	// instance's listener registered beside the new one.
	if (import.meta.hot) import.meta.hot.dispose(unsubscribe);

	return {
		whenReady,
		get<TKey extends keyof WhisperingSettingValues>(
			key: TKey,
		): WhisperingSettingValues[TKey] {
			return clone(map.get(key) as WhisperingSettingValues[TKey]);
		},
		set<TKey extends keyof WhisperingSettingValues>(
			key: TKey,
			value: WhisperingSettingValues[TKey],
		): void {
			map.set(key, clone(value));
			void whispering.kv
				.set(key, clone(value))
				.then(({ error }) => (error ? refreshKey(key) : undefined))
				.catch(() => refreshKey(key));
		},
		getDefault<TKey extends keyof WhisperingSettingValues>(
			key: TKey,
		): WhisperingSettingValues[TKey] {
			return clone(settingsDefaults[key]);
		},
		reset(): void {
			for (const key of keys) {
				map.set(key, clone(settingsDefaults[key]));
				void whispering.kv.unset(key).catch(() => refreshKey(key));
			}
		},
	};
}

export const settings = createSettings();
