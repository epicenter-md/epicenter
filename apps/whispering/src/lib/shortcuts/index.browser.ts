import { commands } from '$lib/commands';
import { focusedShortcuts } from './focused';
import { createReachRouter } from './reach-router';

/** Complete browser shortcut surface: every binding is focused-reach. */
export const shortcuts = createReachRouter({
	focused: focusedShortcuts,
	commands,
});
