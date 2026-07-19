import { createSubscriber } from 'svelte/reactivity';
import type { WhisperingSettings } from '$lib/whispering/app';
import type { WhisperingSettingValues } from '$lib/workspace';

export type BooleanSettingKey = {
	[K in keyof WhisperingSettingValues]: WhisperingSettingValues[K] extends boolean
		? K
		: never;
}[keyof WhisperingSettingValues];

/**
 * Reactive view over the app's hydrated settings: same interface,
 * but reads performed inside a template, `$derived`, or `$effect` re-run
 * when any setting changes. The subscription is ref-counted to effect usage
 * via `createSubscriber`, so an unmounted tree holds no listener.
 */
export function createSettingsView(
	settings: WhisperingSettings,
): WhisperingSettings {
	const subscribe = createSubscriber((update) => settings.subscribe(update));
	return {
		get(key) {
			subscribe();
			return settings.get(key);
		},
		set: settings.set,
		getDefault: settings.getDefault,
		reset: settings.reset,
		get loadError() {
			subscribe();
			return settings.loadError;
		},
		subscribe: settings.subscribe,
	};
}
