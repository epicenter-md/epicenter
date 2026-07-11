import { redirect } from '@sveltejs/kit';
import { openVaults } from '$lib/open-vaults.svelte';
import { routes } from '$lib/routes';
import type { PageLoad } from './$types';

/**
 * `/` is the onboarding empty state, and it is only honest when no vault is open. On
 * relaunch the persisted list restores the sidebar, so landing here would show "Open a
 * vault" while vaults are already available. Focus the first open vault instead. The redirect
 * lands on `/vault/[id]`, keeping vault identity in the URL; only the genuine zero-vault case
 * falls through to `+page.svelte`.
 *
 * The persisted list hydrates async, so `ensureHydrated` first, exactly as
 * `vault/[id]/+page.ts` does: a cold relaunch would otherwise read an empty list and fall
 * through to onboarding even when vaults were saved.
 */
export const load: PageLoad = async () => {
	await openVaults.ensureHydrated();
	const [first] = openVaults.list;
	if (first) redirect(307, routes.vault(first.id));
};
