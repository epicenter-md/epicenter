/// <reference lib="dom" />

/**
 * The hosted browser-redirect convention, packaged once.
 *
 * A convention is composition, not reactivity. This file picks the storage
 * key, the issuer, the redirect, the resource, and where PKCE state lives, and
 * every one of those choices is the same in a Svelte app, a plain page, and a
 * test. It lived in `/svelte` for as long as Svelte apps were the only callers,
 * which fused two independent decisions into one function: an app that wanted
 * the convention had to take the framework wrapper with it, and an app that
 * wanted the wrapper on a differently composed client had nothing to call.
 *
 * A Svelte app wraps the result: `fromAuth(createHostedBrowserRedirectAuth(…))`.
 */

import type { AuthClient } from './auth-contract.js';
import { createOAuthAppAuth } from './create-oauth-app-auth.js';
import { createBrowserOAuthLauncher } from './oauth-launchers/index.js';
import { createWebStoragePersistedAuthStorage } from './persisted-auth-storage.js';

/** Options for {@link createHostedBrowserRedirectAuth}: only what varies per app. */
export type CreateHostedBrowserRedirectAuthOptions = {
	/**
	 * The application this signs in as, which scopes the persisted grant to
	 * `<appId>.auth.persisted`.
	 *
	 * The same id the application passes to `createEpicenter`, because it is the
	 * same application. It used to be a second option called `namespace` holding
	 * the id's last segment, which was one identity spelled two ways: an app
	 * wrote `so.epicenter.vocab` in one file and `vocab` in the file beside it,
	 * and nothing made them agree.
	 */
	appId: string;
	/**
	 * This app's hosted OAuth registration id, used by both the client and the
	 * launcher.
	 *
	 * Spelled out because an `appId` sits beside it: one names the application to
	 * this device's storage, the other names it to the authorization server, and
	 * `clientId` alone does not say which. The OAuth modules underneath keep the
	 * bare `clientId`, which is the spec's word and unambiguous where no second
	 * id is in scope.
	 */
	oauthClientId: string;
	/** The hosted API origin (e.g. `APP_URLS.API`): owns the issuer and the resource. */
	baseURL: string;
};

/**
 * Package the hosted browser-redirect OAuth convention every hosted web app
 * repeats: an `<appId>.auth.persisted` grant in `localStorage` (persistent on
 * purpose: `sessionStorage` would not survive live XSS anyway and signs the
 * user out on every tab close; the real controls are the short access-token
 * TTL, rotating refresh, revocation, and CSP), a redirect
 * launcher built from the hosted constants (`${baseURL}/auth` issuer, the
 * `/auth/callback` redirect, `baseURL` as the resource, `sessionStorage` for
 * the PKCE state). Each app passes only what varies: its application id, its
 * OAuth client id, and the hosted API origin. The result is an `AuthClient`
 * carrying a bearer, ready for signed-in database sync.
 *
 * **The authority is `baseURL`, and no runtime surface selects it** (ADR-0326).
 * This build was made against one deployment and names it; there is no
 * instance setting to read and no self-host token branch, because pointing an
 * installed app at another server is what ADR-0325 refuses.
 *
 * Redirect-only and hosted-only by construction: it owns no Tauri deep-link or
 * extension launcher. A Tauri app keeps its own deep-link launcher and uses
 * this for its web build alone (ADR-0078).
 */
export function createHostedBrowserRedirectAuth({
	appId,
	oauthClientId,
	baseURL,
}: CreateHostedBrowserRedirectAuthOptions): AuthClient {
	return createOAuthAppAuth({
		baseURL,
		clientId: oauthClientId,
		persistedAuthStorage: createWebStoragePersistedAuthStorage({
			key: `${appId}.auth.persisted`,
			storage: window.localStorage,
		}),
		launcher: createBrowserOAuthLauncher({
			issuer: `${baseURL}/auth`,
			clientId: oauthClientId,
			redirectUri: `${window.location.origin}/auth/callback`,
			resource: baseURL,
			storage: window.sessionStorage,
		}),
	});
}
