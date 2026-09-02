import { createSubscriber } from 'svelte/reactivity';
import type { Brand } from 'wellcrafted/brand';
import { createDesktopBrokerAuth as createCoreDesktopBrokerAuth } from '../desktop-broker-auth.js';
import {
	type AuthClient,
	type CreateSameOriginCookieAuthConfig,
	createSameOriginCookieAuth as createCoreSameOriginCookieAuth,
	createOAuthAppAuth,
	createWebStoragePersistedAuthStorage,
} from '../index.js';
import { createBrowserOAuthLauncher } from '../oauth-launchers/index.js';

// The one composition shape (ADR-0088): the app reads `auth.state` once at
// boot, and a change of auth generation reloads the page so the next boot
// composes from scratch.
export { reloadOnAuthChange } from './reload-on-auth-change.js';

/**
 * An auth client whose `state` and `connection.status` track in Svelte.
 *
 * The brand exists because the same reads are correct two opposite ways and
 * the unbranded type cannot tell you which you are holding. A route reads
 * `auth.state` once at boot and must NOT track (ADR-0088: a page lifetime is
 * one auth generation, and `reloadOnAuthChange` replaces the document rather
 * than swapping state under it). A component that renders the reconnect
 * affordance must track, because `signed-in` degrading to `reauth-required` is
 * the one transition the gate deliberately refuses to reload.
 *
 * So a component that tracks asks for `ReactiveAuthClient`, and a boot reader
 * keeps asking for `AuthClient`: the brand is a subtype, so nothing that reads
 * once has to change, and handing a raw core client to a surface that tracks
 * is a type error rather than a silently frozen popover.
 */
export type ReactiveAuthClient = AuthClient & Brand<'ReactiveAuthClient'>;

/**
 * Bridge an auth client's two external facts into Svelte's graph.
 *
 * `createSubscriber` rather than a `$state.raw` shadow, and the difference is
 * not style. It is lazy: the subscription starts only while something is
 * actively reading inside a tracking context, and stops when the last reader
 * is destroyed. That is what lets one wrapped client serve both contracts at
 * once, because a boot-time read outside any effect subscribes to nothing and
 * simply falls through to the live getter. A shadow would subscribe eagerly,
 * once per component instance, for that component's whole life.
 *
 * Both facts are wrapped uniformly even though not every client can change
 * either one. The hosted OAuth and same-origin cookie clients report a
 * constant `connected` with an `onChange` that never fires, and the desktop
 * broker's identity is immutable for its process generation, so their
 * subscribers simply never invalidate. Uniformity is the point: the brand
 * promises that reads track IF the underlying client ever changes, which is a
 * promise every client can keep.
 */
function reactiveAuthClient(auth: AuthClient): ReactiveAuthClient {
	const subscribeState = createSubscriber((update) =>
		auth.onStateChange(update),
	);
	const connection = auth.connection;
	const subscribeConnection = createSubscriber((update) =>
		connection.onChange(update),
	);
	return {
		...auth,
		get state() {
			subscribeState();
			return auth.state;
		},
		connection: {
			...connection,
			get status() {
				subscribeConnection();
				return connection.status;
			},
		},
	} as ReactiveAuthClient;
}

/**
 * Svelte 5 wrapper around `createSameOriginCookieAuth` (cookie client for a
 * browser app the API serves from its own origin, e.g. the dashboard). It
 * cannot drive database sync: `openWebSocket` denies permanently, because a
 * cookie cannot carry the bearer subprotocol.
 */
export function createSameOriginCookieAuth(
	config: CreateSameOriginCookieAuthConfig,
): ReactiveAuthClient {
	return reactiveAuthClient(createCoreSameOriginCookieAuth(config));
}

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
 * and an optional SvelteKit base path. The result is a reactive `AuthClient`
 * carrying a bearer, ready for signed-in database sync.
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
}: CreateHostedBrowserRedirectAuthOptions): ReactiveAuthClient {
	return reactiveAuthClient(
		createOAuthAppAuth({
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
		}),
	);
}

/**
 * The desktop host's window-local client, wrapped like every other.
 *
 * It exists because the Epicenter-host platform leaf was importing
 * `@epicenter/auth/desktop` directly and handing the raw core client to
 * `AccountPopover`, which tracks. That was correct only by accident: the
 * broker client's identity is immutable for its process generation, so its
 * `onStateChange` is a no-op and there was nothing to miss. Give the desktop
 * broker a live state channel later and the popover would have frozen with no
 * error anywhere.
 *
 * Re-exported here rather than fixed at the leaf so the rule has no exception
 * to remember: every client an app hands to a component comes from this
 * module.
 */
export function createDesktopBrokerAuth(
	...args: Parameters<typeof createCoreDesktopBrokerAuth>
): ReactiveAuthClient {
	return reactiveAuthClient(createCoreDesktopBrokerAuth(...args));
}
