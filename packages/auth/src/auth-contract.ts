import type { SocketTransport } from '@epicenter/sync/transport';
import type { Result } from 'wellcrafted/result';
import type { AuthError } from './auth-errors.js';
import type { AuthState } from './auth-state.js';
import type { Principal } from './auth-types.js';

export type { AuthState };

/**
 * Fetch-compatible transport used by auth-owned HTTP calls.
 *
 * Consumers usually pass `auth.fetch` into API clients. Tests inject this
 * shape so the auth runtime can exercise refresh, revoke, and bearer attach
 * without depending on global `fetch`.
 */
export type AuthFetch = (
	input: Request | string | URL,
	init?: RequestInit,
) => Promise<Response>;

/**
 * Whether the selected server is currently usable for network work.
 *
 * `rejected`: the server answered and refused the credential (401/403).
 * `unreachable`: no usable answer (offline, wrong origin, or a box that did
 * not respond like an Epicenter server). Hosted OAuth clients expose the
 * stable Cloud connection as `connected`; authentication remains a separate
 * {@link AuthState} fact.
 */
export type ConnectionStatus =
	| 'connecting'
	| 'connected'
	| 'unreachable'
	| 'rejected';

/**
 * The one server connection an auth client represents. The host may switch
 * this value only by starting a new auth generation; an app never chooses a
 * second server while its current replica is open.
 */
export type Connection = {
	baseURL: string;
	get status(): ConnectionStatus;
	onChange(fn: (status: ConnectionStatus) => void): () => void;
};

export type AuthClient = {
	state: AuthState;
	/**
	 * The one server connection this client represents. Its URL identifies the
	 * server half of the local replica address; `state.principalId` supplies the
	 * principal half. Credential strategy stays inside the auth authority.
	 */
	connection: Connection;
	/**
	 * Subscribe to future state changes.
	 *
	 * Read `state` once before registering when bootstrap state matters. The
	 * listener does not replay the current state, which keeps subscriptions from
	 * accidentally duplicating synchronous boot logic.
	 */
	onStateChange(fn: (state: AuthState) => void): () => void;
	/**
	 * Start the runtime's sign-in flow, and only ever start one.
	 *
	 * Use this from a UI surface that can hand control to the configured
	 * launcher. Resolving means the launcher finished its work, not that a page
	 * navigation happened; callers should observe `state` for the durable signed
	 * in signal.
	 *
	 * It used to mean two things. The browser launcher inspected the current
	 * URL first and exchanged an authorization code when it found one, so
	 * `startSignIn` on the callback route FINISHED a sign-in and `startSignIn`
	 * anywhere else BEGAN one, chosen by a query string. Finishing is
	 * {@link CallbackAuthClient.completeSignIn} now, and this always begins.
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
	 * `@epicenter/principal` `AuthState` and `PersistedAuth`). Account UI calls
	 * this when it renders the user; local workspace code reads `principalId`
	 * off `state`.
	 */
	getProfile(): Promise<Result<Principal, AuthError>>;
	/**
	 * Open a WebSocket using the same credential boundary as `fetch`.
	 *
	 * The address is one value (`WebSocketAddress`) because a browser cannot set
	 * `Authorization` on an upgrade: the route it came from already put the main
	 * subprotocol beside the URL, and this method appends `bearer.<token>` to
	 * that list. The route extracts the bearer at the upgrade and echoes only
	 * the main subprotocol back.
	 *
	 * Every client has this method, and not every client can honor it. It
	 * resolves only with a credentialed socket; otherwise it rejects with an
	 * `OpenWebSocketDenial` (`@epicenter/sync`) rather than opening a socket
	 * without a usable bearer, which the server refuses at the upgrade with an
	 * HTTP 401 a browser cannot read. Its `code` is a `SyncRefusal`:
	 * `'signed-out'`,
	 * `'reauth-required'`, `'auth-unavailable'` when verification was
	 * unreachable, and `'no-credential-model'` for a client that can never open
	 * one, which a same-origin cookie and a desktop window both are.
	 *
	 * That refusal is the single answer to "can this client sync". There is no
	 * sync-capable subtype to demand, because a caller that opens a socket has
	 * to handle the refusal either way: the models that can never sync are one
	 * code on a channel every caller already needs.
	 *
	 * Waits for in-flight machine work (token refresh, `/api/session`
	 * verification), never for a human.
	 */
	openWebSocket: SocketTransport['openWebSocket'];
	[Symbol.dispose](): void;
};

/**
 * An auth client whose transport receives an OAuth callback it can consume.
 *
 * A subtype rather than a member on {@link AuthClient}, and the asymmetry with
 * `openWebSocket` is the reason. Every client has `openWebSocket` because a
 * caller that opens a socket must handle `OpenWebSocketDenied` for a merely
 * signed-out client anyway, so "this model can never open one" is one more code
 * on a channel that already exists. Callback completion has no such
 * channel: a caller holding a callback URL either exchanges it or the call is
 * meaningless, and a `completeSignIn` on the desktop broker, the same-origin
 * cookie client, or the instance-token client could only answer with an error
 * saying the method does not apply. That is a lie in the type repaired at
 * runtime, which is what this subtype exists to refuse.
 *
 * Which clients have it is decided by the LAUNCHER, not by the product:
 * hosted browser redirect auth returns to `/auth/callback?code=…`, while the
 * extension launcher completes inline through the web-auth flow and never
 * returns to a redirect URI at all.
 */
export type CallbackAuthClient = AuthClient & {
	/**
	 * Consume the OAuth callback this runtime is currently sitting on.
	 *
	 * Call it from the redirect route and nowhere else. The client reads the
	 * callback itself, so no URL, code, or state crosses this boundary: a route
	 * that had to parse `code` and `state` would be holding the halves of a PKCE
	 * exchange it has no business seeing.
	 *
	 * Resolving `Ok` means identity is installed and published, so every
	 * reactive reader has already seen it. Nothing above the route navigates on
	 * that, though, including for a callback that finished for the principal
	 * already signed in and published no change: leaving the callback URL is the
	 * route's own unconditional job.
	 */
	completeSignIn(): Promise<Result<undefined, AuthError>>;
};

/**
 * Narrow a client to the one that can finish an OAuth callback.
 *
 * A guard rather than a static type, because one callback route is compiled
 * into every build of an app while `#platform/auth` resolves to a different
 * client in each: the browser leaf redirects, and the desktop leaf brokers
 * sign-in through the host and never sees a browser callback. The route needs
 * an answer that holds in both builds.
 *
 * Truthful at runtime because the member is attached only where it works.
 * `createOAuthAppAuth` adds it when its launcher can complete a callback and
 * omits it otherwise, so this is a fact about the composed client rather than a
 * guess about its shape.
 */
export function isCallbackAuthClient(
	client: AuthClient,
): client is CallbackAuthClient {
	return (
		typeof (client as Partial<CallbackAuthClient>).completeSignIn === 'function'
	);
}
