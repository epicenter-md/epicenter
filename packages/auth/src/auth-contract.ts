import type { AuthState } from '@epicenter/identity';
import type { Result } from 'wellcrafted/result';
import type { AuthError } from './auth-errors.js';
import type { Principal } from './auth-types.js';

export type { AuthState };

/**
 * Fetch-compatible transport used by auth-owned HTTP calls.
 *
 * Consumers usually pass `auth.fetch` into API clients. Tests and machine auth
 * inject this shape so the auth runtime can exercise refresh, revoke, and
 * bearer attach without depending on global `fetch`.
 */
export type AuthFetch = (
	input: Request | string | URL,
	init?: RequestInit,
) => Promise<Response>;

/**
 * Outcome of verifying a client's credential against its star. Exposed only by
 * clients that perform a remote bearer verification at boot (the self-host token
 * client, {@link createInstanceTokenAuth}). It rides its own channel because the
 * boot identity {@link AuthState} is optimistic (signed-in the moment a token is
 * held, ADR-0075) and most outcomes leave it untouched: an unreachable star keeps
 * the client signed-in for local-first work, and only a rejected token drops it to
 * `signed-out`. So this is the separate signal a UI reads to explain connectivity:
 * still connecting, an unreachable star, or a rejected token.
 */
export type AuthConnectionState =
	| { status: 'pending' }
	| { status: 'connected' }
	| {
			status: 'failed';
			/**
			 * `rejected`: the star answered and refused the token (401/403).
			 * `unreachable`: no usable answer (offline, wrong origin, or a box that
			 * did not respond like an Epicenter star).
			 */
			reason: 'rejected' | 'unreachable';
	  };

/**
 * Observable {@link AuthConnectionState}. `onChange` does not replay the current
 * value, mirroring {@link AuthClient.onStateChange}; read `state` once before
 * subscribing when the boot value matters (the Svelte reactive wrapper does).
 */
export type AuthConnection = {
	get state(): AuthConnectionState;
	onChange(fn: (state: AuthConnectionState) => void): () => void;
};

export type AuthClient = {
	state: AuthState;
	/**
	 * Origin of the API this client signs into. Exposed so client-side
	 * partitioning (local storage keys, BroadcastChannel names) can scope by
	 * `(server, principalId)` and stay distinct across two signed-in deployments on
	 * the same machine. Mirrors the `baseURL` passed at construction.
	 */
	baseURL: string;
	/**
	 * Subscribe to future state changes.
	 *
	 * Read `state` once before registering when bootstrap state matters. The
	 * listener does not replay the current state, which keeps subscriptions from
	 * accidentally duplicating synchronous boot logic.
	 */
	onStateChange(fn: (state: AuthState) => void): () => void;
	/**
	 * Start the runtime's sign-in flow.
	 *
	 * Use this from UI or CLI commands that can hand control to the configured
	 * launcher. Completion means the launcher finished its work, not that a page
	 * navigation happened; callers should observe `state` for the durable signed
	 * in signal.
	 */
	startSignIn(): Promise<Result<undefined, AuthError>>;
	/**
	 * Clear local auth and revoke the refresh token when the server is reachable.
	 *
	 * Use this for explicit user logout. The local persisted cell is removed
	 * first, so local workspace access stops depending on whether the best-effort
	 * revoke request succeeds.
	 */
	signOut(): Promise<Result<undefined, AuthError>>;
	/**
	 * Fetch an API resource through the auth-owned credential boundary.
	 *
	 * Use this instead of attaching credentials yourself. Each client supplies
	 * its own credential and surfaces auth failures back into `state`; the
	 * credential and refresh behavior depend on the model (the OAuth client
	 * verifies `/api/session` and attaches a refreshed bearer; the same-origin
	 * cookie client sends the session cookie). See each factory for specifics.
	 */
	fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
	/**
	 * Read the signed-in user's profile (`/api/session`) through the credential
	 * boundary.
	 *
	 * Presentational identity (the email) is fetched on demand by the surface
	 * that displays it, never persisted or carried on `state`: `state` holds only
	 * the principal id, which is offline-useful and license-clean (see
	 * `@epicenter/identity` `AuthState` and `PersistedAuth`). Account UI calls
	 * this when it renders the user; local workspace code reads `principalId`
	 * off `state`.
	 */
	getProfile(): Promise<Result<Principal, AuthError>>;
	/**
	 * Connection-verification channel, present only on clients that verify a
	 * remote bearer at boot (the self-host token client). Absent on hosted OAuth
	 * (identity resolves through the persisted grant, not a boot bearer check) and
	 * on the same-origin cookie client (no remote star), so it is an optional
	 * capability a UI feature-detects, not a universal field.
	 */
	connection?: AuthConnection;
	[Symbol.dispose](): void;
};

/**
 * An {@link AuthClient} that can also open authenticated WebSockets for cloud
 * sync. Only credential models that carry a bearer can do this: the OAuth/PKCE
 * client ({@link createOAuthAppAuth}) implements it, while the same-origin
 * cookie client ({@link createSameOriginCookieAuth}) is a plain `AuthClient`
 * with no `openWebSocket`, because a same-origin cookie cannot carry the bearer
 * subprotocol the rooms route requires.
 *
 * Workspace sync (`toConnection`, `openCollaboration`) requires a
 * `SyncAuthClient`, so passing a cookie client where sync is needed is a
 * compile error rather than a runtime throw.
 */
export type SyncAuthClient = AuthClient & {
	/**
	 * Open a WebSocket using the same bearer boundary as `fetch`.
	 *
	 * Browsers cannot set `Authorization` on WebSocket upgrades, so the token is
	 * carried as an Epicenter bearer subprotocol; the rooms route extracts it at
	 * the upgrade and the server echoes only the main subprotocol back.
	 *
	 * Resolves only with a credentialed socket. When no usable bearer can be
	 * attached it rejects with an `OpenWebSocketDenial` (`@epicenter/sync`)
	 * instead of opening a socket doomed to a server 4401: `'permanent'`
	 * (signed out, reauth required) means only an auth state change can help;
	 * `'transient'` means verification was unreachable and a retry may
	 * succeed. Waits for in-flight machine work (token refresh, `/api/session`
	 * verification), never for a human.
	 */
	openWebSocket(url: string | URL, protocols?: string[]): Promise<WebSocket>;
};
