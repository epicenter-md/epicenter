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
	 * Start the runtime's sign-in flow.
	 *
	 * Use this from a UI surface that can hand control to the configured
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
	 * `@epicenter/principal` `AuthState` and `PersistedAuth`). Account UI calls
	 * this when it renders the user; local workspace code reads `principalId`
	 * off `state`.
	 */
	getProfile(): Promise<Result<Principal, AuthError>>;
	/**
	 * Open a WebSocket using the same credential boundary as `fetch`.
	 *
	 * Browsers cannot set `Authorization` on WebSocket upgrades, so a bearer is
	 * carried as an Epicenter bearer subprotocol; the rooms route extracts it at
	 * the upgrade and the server echoes only the main subprotocol back.
	 *
	 * Every client has this method, and not every client can honor it. It
	 * resolves only with a credentialed socket; otherwise it rejects with an
	 * `OpenWebSocketDenial` (`@epicenter/sync`) rather than opening a socket
	 * doomed to a server 4401. `'transient'` means verification was unreachable
	 * and a retry may succeed. `'permanent'` means only an auth state change can
	 * help, and it covers both the client that is merely signed out and the
	 * credential model that can never open one: a same-origin cookie cannot
	 * carry the subprotocol the rooms route requires, and a desktop window holds
	 * no credential at all.
	 *
	 * That denial is the single answer to "can this client sync". There is no
	 * sync-capable subtype to demand, because a caller that opens a socket has
	 * to handle the denial either way: the models that can never sync are the
	 * permanent arm of a channel every caller already needs.
	 *
	 * Waits for in-flight machine work (token refresh, `/api/session`
	 * verification), never for a human.
	 */
	openWebSocket(url: string | URL, protocols?: string[]): Promise<WebSocket>;
	[Symbol.dispose](): void;
};
