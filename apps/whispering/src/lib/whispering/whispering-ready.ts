import { whisperingBoot } from '#platform/whispering';
import { settings } from '$lib/state/settings.svelte';

/**
 * The one fallible app bootstrap the root layout's WorkspaceGate awaits
 * before rendering anything: storage acquisition for both workspaces, then
 * settings hydration (first paint reads settings everywhere). A failure
 * (held storage, or any other open error) becomes a visible gate screen
 * instead of a blank page. Recordings and recipes hydrate in the
 * background, exposing their own `whenReady` for surfaces that gate on
 * them.
 */
export const whisperingReady: Promise<void> = (async () => {
	await whisperingBoot;
	await settings.whenReady;
})();
// The gate is the one observer of boot failure; without this, a failed boot
// also fires an unhandled-rejection event before the gate can render it.
void whisperingReady.catch(() => undefined);
