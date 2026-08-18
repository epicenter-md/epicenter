import {
	type AuthClient,
	type CreateAppAuthClientOptions,
	type CreateSameOriginCookieAuthConfig,
	createAppAuthClient as createCoreAppAuthClient,
	createSameOriginCookieAuth as createCoreSameOriginCookieAuth,
	createWebStoragePersistedAuthStorage,
	type Instance,
	type InstanceSetting,
} from '@epicenter/auth';
import { createBrowserOAuthLauncher } from '@epicenter/auth/oauth-launchers';
import { createSubscriber } from 'svelte/reactivity';

// The one composition shape (ADR-0088): the app reads `auth.state` once at
// boot, and a change of auth generation reloads the page so the next boot
// composes from scratch.
export { reloadOnAuthChange } from './reload-on-auth-change.js';

/**
 * Make an auth client's `state` Svelte-reactive: spread the closure-bound
 * client and override `state` with a getter that calls `subscribe()` so reads
 * inside `$derived` / `$effect` track changes. The same transform applies to
 * every credential model; only the underlying client differs.
 */
function reactiveAuthClient(auth: AuthClient): AuthClient {
	const subscribeState = createSubscriber((update) =>
		auth.onStateChange(update),
	);
	const reactive: AuthClient = {
		...auth,
		get state() {
			subscribeState();
			return auth.state;
		},
	};
	// A self-hosted deployment carries a live connection status (connecting /
	// connected / unreachable / rejected) that changes without touching `state`,
	// so give it its own subscriber. Hosted deployments are plain data and keep
	// the spread value.
	if (auth.deployment.kind === 'self-hosted') {
		const source = auth.deployment.connection;
		const subscribeConnection = createSubscriber((update) =>
			source.onChange(update),
		);
		reactive.deployment = {
			...auth.deployment,
			connection: {
				get status() {
					subscribeConnection();
					return source.status;
				},
				onChange: source.onChange,
			},
		};
	}
	return reactive;
}

/**
 * Svelte 5 wrapper around `createAppAuthClient`: the one client-side choke point
 * that turns a persisted `Instance` into a hosted-OAuth or self-host-token
 * client (the branch is internal). Both branches carry a bearer, so the
 * returned reactive client can open the sync socket a signed-in app
 * generation dials with.
 */
export function createAppAuthClient(
	instance: Instance,
	options: CreateAppAuthClientOptions,
): AuthClient {
	return reactiveAuthClient(createCoreAppAuthClient(instance, options));
}

/**
 * Svelte 5 wrapper around `createSameOriginCookieAuth` (cookie client for a
 * browser app the API serves from its own origin, e.g. the dashboard). It
 * cannot drive database sync: `openWebSocket` denies permanently, because a
 * cookie cannot carry the bearer subprotocol.
 */
export function createSameOriginCookieAuth(
	config: CreateSameOriginCookieAuthConfig,
): AuthClient {
	return reactiveAuthClient(createCoreSameOriginCookieAuth(config));
}

/** Options for {@link createHostedBrowserRedirectAuth}: only what varies per app. */
export type CreateHostedBrowserRedirectAuthOptions = {
	/** The app's persisted instance setting: hosted default or a self-host token. */
	instanceSetting: InstanceSetting;
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
 * `api` as the resource, `sessionStorage` for the PKCE state), and the
 * persisted `Instance` fed to {@link createAppAuthClient}. Each app passes
 * only what varies: its namespace, OAuth client id, the hosted API origin,
 * and an optional SvelteKit base path. The result is a reactive `AuthClient`
 * carrying a bearer, ready for signed-in database sync.
 *
 * Redirect-only and hosted-only by construction: it owns no Tauri deep-link or
 * extension launcher and no self-host token branch. The self-host path still works
 * because `createAppAuthClient` reads it off the passed `instanceSetting` (a token
 * instance ignores the launcher); this factory only builds the browser launcher
 * the hosted branch needs. A Tauri app keeps its own deep-link launcher and uses
 * this for its web build alone (ADR-0078).
 */
export function createHostedBrowserRedirectAuth({
	instanceSetting,
	namespace,
	clientId,
	api,
	basePath = '',
	persistedStorage = window.localStorage,
}: CreateHostedBrowserRedirectAuthOptions): AuthClient {
	return createAppAuthClient(instanceSetting.read(), {
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
