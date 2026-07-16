import { recordings } from '$lib/state/recordings.svelte';
import type { PageLoad } from './$types';

/**
 * Gate the recordings paint on the initial bounded canonical-record scan.
 */
export const load: PageLoad = async () => {
	await recordings.whenReady;
};
