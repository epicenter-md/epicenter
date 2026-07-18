import { recordings } from '$lib/state/recordings.svelte';
import { whisperingReady } from '$lib/whispering/whispering-ready';
import type { PageLoad } from './$types';

/**
 * Gate the recordings paint on the initial bounded canonical-record scan.
 * Load functions run outside the layout's WorkspaceGate, so this must
 * await the app boot itself before touching the singleton.
 */
export const load: PageLoad = async () => {
	await whisperingReady;
	await recordings.whenReady;
};
