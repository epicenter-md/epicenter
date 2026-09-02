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
 * A Svelte app wraps the result: `reactive(createHostedBrowserRedirectAuth(…))`.
 */

import { createOAuthAppAuth } from './create-oauth-app-auth.js';
import type { AuthClient } from './auth-contract.js';
import { createBrowserOAuthLauncher } from './oauth-launchers/index.js';
import { createWebStoragePersistedAuthStorage } from './persisted-auth-storage.js';

/** Options for {@link createHostedBrowserRedirectAuth}: only what varies per app. */
export type CreateHostedBrowserRedirectAuthOptions = {
	/** Namespace for the persisted-auth storage key (`<namespace>.auth.persisted`). */
	namespace: string;
	/** This app's hosted OAuth client id (used by both the client and the launcher). */
	clientId: string;
	/** The hosted API origin (e.g. `APP_URLS.API`): owns the issuer and the resource. */
	api: string;
	/** SvelteKit base path prepended to the callback, for a subpath deploy. Default `''`. */
	basePath?: string;
	/**
	 * Where the persisted grant lives. Defaults to `localStorage`. Pass
	 * `sessionStorage` (or an in-memory `Storage`) for an app whose web build
	 * decrypts high-value secrets in JS and wants a smaller XSS-persistence
	 * window (for example, Whispering's vault per ADR-0079). The grant then
	 * dies with the tab instead of surviving across sessions.
	 */
	persistedStorage?: Storage;
};

/**
 * Package the hosted browser-redirect OAuth convention every hosted web app
 * repeats: a `<namespace>.auth.persisted` grant (localStorage by default,
 * override via `persistedStorage`; persistent on purpose: `sessionStorage`
 * would not survive live XSS anyway and signs the user out on every tab
 * close; the real controls are the short access-token TTL, rotating refresh,
 * revocation, and CSP, per ADR-0079), a redirect launcher built from the
 * hosted constants (`${api}/auth` issuer, the `/auth/callback` redirect,
 * `api` as the resource, `sessionStorage` for the PKCE state). Each app passes
 * only what varies: its namespace, OAuth client id, the hosted API origin,
 * and an optional SvelteKit base path. The result is an `AuthClient` carrying
 * a bearer, ready for signed-in database sync.
 *
 * **The authority is `api`, and no runtime surface selects it** (ADR-0326).
 * This build was made against one deployment and names it; there is no
 * instance setting to read and no self-host token branch, because pointing an
 * installed app at another server is what ADR-0325 refuses.
 *
 * Redirect-only and hosted-only by construction: it owns no Tauri deep-link or
 * extension launcher. A Tauri app keeps its own deep-link launcher and uses
 * this for its web build alone (ADR-0078).
 */
export function createHostedBrowserRedirectAuth({
	namespace,
	clientId,
	api,
	basePath = '',
	persistedStorage = window.localStorage,
}: CreateHostedBrowserRedirectAuthOptions): AuthClient {
	return createOAuthAppAuth({
		baseURL: api,
		clientId,
		persistedAuthStorage: createWebStoragePersistedAuthStorage({
			key: `${namespace}.auth.persisted`,
			storage: persistedStorage,
		}),
		launcher: createBrowserOAuthLauncher({
			issuer: `${api}/auth`,
			clientId,
			redirectUri: `${window.location.origin}${basePath}/auth/callback`,
			resource: api,
			storage: window.sessionStorage,
		}),
	});
}
