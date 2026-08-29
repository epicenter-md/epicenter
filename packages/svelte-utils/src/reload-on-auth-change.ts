/**
 * A page lifetime is one auth generation.
 *
 * An app reads `auth.state` once at boot and builds everything downstream of
 * it (which replica to open, whether sync attaches) for that one identity.
 * Nothing swaps in place when auth changes later: this reloads the page, and
 * the next boot constructs the right composition from scratch. The name says
 * "reload" out loud on purpose. A live in-place swap of the store and the
 * sync connection would be a many-file migration with leaked-observer risk,
 * and the product decision is that transient UI state does not survive an
 * account change anyway.
 *
 * Two transitions start a new generation, and one deliberately does not:
 *
 * - The principal identity changes (sign in, sign out, switch account): the
 *   partition everything is keyed by is different, so the page must go.
 * - A credential is acquired without an identity change (`reauth-required` to
 *   `signed-in`, e.g. the account popover's Reconnect): the identity is the
 *   same but this generation already gave up on sync, permanently, when its
 *   dials were denied. Only a fresh generation dials again. This is always a
 *   user action, so the reload lands on a click, never mid-keystroke.
 * - `signed-in` degrading to `reauth-required` does NOT reload, and the reason
 *   is structural rather than a preference about interruption. **A reload
 *   cannot repair this transition, so reloading on it is a boot loop.** The
 *   paused flag is runtime-only: `PersistedAuth` carries a grant and a
 *   principal id and nothing else, and boot is optimistic (ADR-0075), so a
 *   persisted grant always comes back as `signed-in` with `networkAccess:
 *   'unverified'`. You can never boot INTO `reauth-required`. A genuinely
 *   revoked refresh token therefore degrades again within one round trip of
 *   the token endpoint, and a reload here would spin at that period forever.
 *
 *   The UX argument is true as well: this is the one transition that fires
 *   spontaneously, mid-keystroke, and the degraded app works exactly as well
 *   locally. But it is the weaker of the two, and stating it alone has already
 *   invited "why not just reload here too" more than once. Sync discovers the
 *   denial on its own next dial and stops; nothing else changes.
 *
 *   Making this reload would mean persisting the pause (a `PersistedAuth`
 *   schema change that reaches the desktop keyring storage) or awaiting
 *   verification before first render (abandoning optimistic boot). Both cost
 *   more than this file.
 */

import type { AuthClient, AuthState } from '@epicenter/auth';

/**
 * The identity boundary: `null` when signed out, otherwise the principal id.
 */
function principalKey(state: AuthState) {
	return state.status === 'signed-out' ? null : state.principalId;
}

/**
 * Reload the page when the auth generation changes (see the module doc for
 * which transitions count). Returns the unsubscribe. Mount once in the app's
 * root layout.
 *
 * The one-shot `reloading` guard collapses the `signed-out` ->
 * `signed-in:principal` pair an account switch emits into a single reload.
 *
 * Reload safety lives at the source: a host with an unsafe-to-interrupt
 * moment (e.g. an in-flight recording) disables the account controls via
 * `AccountPopover`'s `disabledReason`, so a reload can never fire mid-action.
 *
 * @param options.callbackPath - The app's OAuth callback route. A sign-in
 * completing there fires this state change before the page's own redirect can
 * run; a bare reload would land back on the callback URL and replay the
 * already-consumed authorization code, surfacing a spurious error after a
 * real success, so that one location gets a replacement navigation instead.
 * @param options.callbackDestination - Where the app wants a completed
 * callback to land. The utility does not choose a product route by itself.
 */
export function reloadOnAuthChange(
	auth: AuthClient,
	{
		callbackPath = '/auth/callback',
		callbackDestination = '/',
	}: { callbackPath?: string; callbackDestination?: string } = {},
) {
	let previous = auth.state;
	let reloading = false;
	return auth.onStateChange((state) => {
		const identityChanged = principalKey(state) !== principalKey(previous);
		const credentialAcquired =
			state.status === 'signed-in' && previous.status === 'reauth-required';
		previous = state;
		if (reloading || !(identityChanged || credentialAcquired)) return;
		reloading = true;
		if (window.location.pathname === callbackPath) {
			window.location.replace(callbackDestination);
			return;
		}
		window.location.reload();
	});
}
