import { openVaults } from '$lib/open-vaults.svelte';
import type { LayoutLoad } from './$types';

/**
 * Hydrate the open-vault list before the `(vaults)` group paints. The list loads async (a
 * Tauri store read); SvelteKit blocks a route's render until its loads resolve, so awaiting
 * hydration here gates the sidebar's first paint against the real list, with no
 * empty-then-populated flash and no skeleton.
 *
 * This gate is about the PAINT, not data correctness. Layout and page loads run concurrently,
 * so this does NOT sequence the child page loads: each child `load` that resolves an id
 * against the list must await `ensureHydrated` ITSELF (see the `+page.ts` loads), or it would
 * read an empty list and 404 a valid id. Hydration is memoized, so all of them share one read.
 */
export const load: LayoutLoad = async () => {
	await openVaults.ensureHydrated();
};
