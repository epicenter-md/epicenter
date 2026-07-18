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

async function createSettings() {
	const map = new SvelteMap<keyof WhisperingSettingValues, unknown>();
	const keys = Object.keys(settingsDefaults) as Array<
		keyof WhisperingSettingValues
	>;

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
	await Promise.all(keys.map(refreshKey));
	// This module is a singleton; without this, each hot reload leaves the old
	// instance's listener registered beside the new one.
	if (import.meta.hot) import.meta.hot.dispose(unsubscribe);

	return {
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

export const settings = await createSettings();
