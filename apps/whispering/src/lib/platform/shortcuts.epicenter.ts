import { commands } from '$lib/commands';
import { focusedShortcuts } from './focused-shortcuts';
import { createReachRouter } from './reach-router';
import { systemShortcuts } from './system-shortcuts.tauri';

/** Complete Epicenter shortcut surface: focused and system-global reach. */
export const shortcuts = createReachRouter({
	focused: focusedShortcuts,
	global: systemShortcuts,
	commands,
});
