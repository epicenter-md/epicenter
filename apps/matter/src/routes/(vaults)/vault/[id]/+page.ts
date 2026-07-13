import { error } from '@sveltejs/kit';
import { openVaults } from '$lib/open-vaults.svelte';
import type { PageLoad } from './$types';

/**
 * Resolve the route's opaque id back to a vault root. The persisted list is the only
 * place `id -> root` lives, so a not-open id (a stale deep-link or a closed vault) is a
 * clean 404 rendered by `+error.svelte`, not a crash. The persisted list hydrates async,
 * so `ensureHydrated` first: resolving before the sidebar list lands would 404 a valid id on a
 * cold launch. Returns the root only (serializable); the LIVE vault is constructed in the
 * component, since a watcher cannot leave `load`, and the sidebar/title label is
 * `basename(root)`, derived at render.
 */
export const load: PageLoad = async ({ params }) => {
	await openVaults.ensureHydrated();
	const vault = openVaults.get(params.id);
	if (!vault) error(404, 'This vault is not open.');
	return { root: vault.root };
};
