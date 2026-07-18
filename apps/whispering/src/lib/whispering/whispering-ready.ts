import { whisperingBoot } from '#platform/whispering';
import { initRecipes } from '$lib/state/recipes.svelte';
import { initRecordings } from '$lib/state/recordings.svelte';
import { initSettings } from '$lib/state/settings.svelte';

/**
 * The one fallible app bootstrap: open the workspaces, then construct the
 * reactive state singletons in a deterministic order. The root layout's
 * WorkspaceGate awaits this before rendering anything, so a storage
 * failure (held, or any other open error) becomes a visible gate screen
 * instead of a blank page, and every singleton consumer runs only after
 * its binding is assigned.
 *
 * Settings hydration is awaited (first paint reads settings everywhere);
 * recordings and recipes hydrate in the background exactly as before,
 * exposing their own `whenReady` for surfaces that gate on them.
 */
export const whisperingReady: Promise<void> = (async () => {
	await whisperingBoot;
	initRecordings();
	initRecipes();
	await initSettings();
})();
// The gate is the one observer of boot failure; without this, a failed boot
// also fires an unhandled-rejection event before the gate can render it.
void whisperingReady.catch(() => undefined);
