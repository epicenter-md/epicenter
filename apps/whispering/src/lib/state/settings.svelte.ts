import type { DocumentKeyValueError } from '@epicenter/workspace/sqlite';
import { SvelteMap } from 'svelte/reactivity';
import type { Result } from 'wellcrafted/result';
import { settingsDefaults, whispering } from '#platform/whispering';
import type { WhisperingSettingValues } from '$lib/workspace';

export type BooleanSettingKey = {
	[K in keyof WhisperingSettingValues]: WhisperingSettingValues[K] extends boolean
		? K
		: never;
}[keyof WhisperingSettingValues];

const settingsDocument = await whispering.documents.settings.open();
const settingsContent = settingsDocument.content;

type ReadSetting = <TKey extends keyof WhisperingSettingValues>(
	key: TKey,
) => Result<WhisperingSettingValues[TKey] | undefined, DocumentKeyValueError>;
type WriteSetting = <TKey extends keyof WhisperingSettingValues>(
	key: TKey,
	value: WhisperingSettingValues[TKey],
) => void;
type DeleteSetting = (key: keyof WhisperingSettingValues) => void;

// Project schema-derived methods onto the already-derived setting values so
// Svelte does not instantiate the full schema union for every operation.
const readSetting = settingsContent.get as unknown as ReadSetting;
const writeSetting = settingsContent.set as unknown as WriteSetting;
const deleteSetting = settingsContent.delete as unknown as DeleteSetting;

function clone<TValue>(value: TValue): TValue {
	return structuredClone(value);
}

function createSettings() {
	const map = new SvelteMap<keyof WhisperingSettingValues, unknown>();

	function refresh(): void {
		for (const key of Object.keys(settingsDefaults) as Array<
			keyof WhisperingSettingValues
		>) {
			const { data: storedValue, error } = readSetting(key);
			if (error) {
				// A newer release may own this value. Use local policy without repair.
				map.set(key, clone(settingsDefaults[key]));
				continue;
			}
			map.set(key, clone(storedValue ?? settingsDefaults[key]));
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
			writeSetting(key, clone(value));
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
				deleteSetting(key);
				map.set(key, clone(settingsDefaults[key]));
			}
		},
	};
}

export const settings = createSettings();
