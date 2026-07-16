import { SvelteMap } from 'svelte/reactivity';
import { settingsDefaults, whispering } from '#platform/whispering';
import type { WhisperingSettingValues } from '$lib/workspace';

export type BooleanSettingKey = {
	[K in keyof WhisperingSettingValues]: WhisperingSettingValues[K] extends boolean
		? K
		: never;
}[keyof WhisperingSettingValues];

const settingsDocument = await whispering.documents.settings.open();
const settingsContent = settingsDocument.content as {
	get(key: string): unknown;
	set(key: string, value: unknown): void;
	delete(key: string): void;
	observe(listener: () => void): () => void;
};

function clone<TValue>(value: TValue): TValue {
	return structuredClone(value);
}

function createSettings() {
	const map = new SvelteMap<keyof WhisperingSettingValues, unknown>();

	function refresh(): void {
		for (const key of Object.keys(settingsDefaults) as Array<
			keyof WhisperingSettingValues
		>) {
			map.set(key, clone(settingsContent.get(key) ?? settingsDefaults[key]));
		}
	}

	refresh();
	settingsContent.observe(refresh);

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
			settingsContent.set(key, clone(value));
			map.set(key, clone(value));
		},
		getDefault<TKey extends keyof WhisperingSettingValues>(
			key: TKey,
		): WhisperingSettingValues[TKey] {
			return clone(settingsDefaults[key]);
		},
		reset(): void {
			for (const key of Object.keys(settingsDefaults) as Array<
				keyof WhisperingSettingValues
			>) {
				settingsContent.delete(key);
				map.set(key, clone(settingsDefaults[key]));
			}
		},
	};
}

export const settings = createSettings();
