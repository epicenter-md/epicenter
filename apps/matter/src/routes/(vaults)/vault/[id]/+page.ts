import { error } from '@sveltejs/kit';
import { openVaults } from '$lib/open-vaults.svelte';
import type { PageLoad } from './$types';

/**
 * Resolve the route's opaque id back to a folder. The persisted list is the only
 * place `id -> path` lives, so a not-open id (a stale deep-link or a closed tab) is a
 * clean 404 rendered by `+error.svelte`, not a crash. Returns serializable data only;
 * the LIVE vault is constructed in the component, since a watcher cannot leave `load`.
 */
export const load: PageLoad = ({ params }) => {
	const vault = openVaults.get(params.id);
	if (!vault) error(404, 'This vault is not open.');
	return { path: vault.path, folderName: vault.folderName };
};
