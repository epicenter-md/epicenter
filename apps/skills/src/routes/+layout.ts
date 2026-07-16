import { skillsState } from '$lib/state/skills-state.svelte';
import type { LayoutLoad } from './$types';

export const ssr = false;

/**
 * Gate first paint on the initial bounded canonical-record scan.
 */
export const load: LayoutLoad = async () => {
	await skillsState.whenReady;
};
