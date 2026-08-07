import { invoke } from '@tauri-apps/api/core';
import { settings } from '$lib/stores/settings.svelte';

export function syncDockIconWithSettings() {
	$effect(() => {
		const hideDockIcon = settings.value['system.hideDockIcon'];
		invoke('set_dock_icon_visible', { visible: !hideDockIcon }).catch(
			(error) => {
				console.error('Failed to update Dock icon visibility:', error);
			},
		);
	});
}
