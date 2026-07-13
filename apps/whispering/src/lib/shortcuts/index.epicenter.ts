import { commands } from '$lib/commands';
import { focusedShortcuts } from './focused';
import { createReachRouter } from './reach-router';
import { systemShortcuts } from './system.epicenter';

/** Complete Epicenter shortcut surface: focused and system-global reach. */
export const shortcuts = createReachRouter({
	focused: focusedShortcuts,
	global: systemShortcuts,
	commands,
});
