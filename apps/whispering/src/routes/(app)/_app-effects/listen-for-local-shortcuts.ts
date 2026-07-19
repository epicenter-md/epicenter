import { onMount } from 'svelte';
import { dispatchCommandTrigger } from '$lib/commands';
import { services } from '$lib/services';

/**
 * Subscribe the in-app keydown matcher to the command layer for the app's
 * lifetime. The bindings it matches are pushed by `synchronizeShortcuts`.
 */
export function listenForLocalShortcuts(): void {
	onMount(() => {
		const unlisten = services.localShortcutManager.listen(
			dispatchCommandTrigger,
		);
		return () => unlisten();
	});
}
