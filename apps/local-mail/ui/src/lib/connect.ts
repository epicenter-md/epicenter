/**
 * Carrying a PKCE exchange across the redirect.
 *
 * The verifier and the state have to survive leaving the page and coming back,
 * and they must not survive anything else. `sessionStorage` is the right
 * lifetime: it is scoped to this tab and cleared when the tab closes, which is
 * exactly how long the two halves of one authorization are meaningful.
 *
 * Neither value is a credential. The verifier proves this page started the
 * exchange; the refresh token that comes back is never written here, it goes
 * straight to `appStorage.secrets` (ADR-0310).
 */

import type { AuthorizationRequest } from '@epicenter/local-mail/oauth';

const KEY = 'local-mail:authorization';

export function rememberAuthorization(request: AuthorizationRequest): void {
	sessionStorage.setItem(KEY, JSON.stringify(request));
}

/**
 * Take the pending authorization, if this tab started one.
 *
 * Removed as it is read: an authorization is redeemable once, and leaving it
 * behind would mean a reload of the landing page trying to redeem a code Google
 * has already spent.
 */
export function takeAuthorization(): AuthorizationRequest | null {
	const stored = sessionStorage.getItem(KEY);
	if (stored === null) return null;
	sessionStorage.removeItem(KEY);
	try {
		return JSON.parse(stored) as AuthorizationRequest;
	} catch {
		return null;
	}
}
