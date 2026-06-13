import type { AuthState, SyncAuthClient } from '@epicenter/auth';
import type { OwnerId } from '@epicenter/identity';

type SignedInState = Extract<AuthState, { status: 'signed-in' }>;
type Keyring = SignedInState['keyring'];

/**
 * Auth-gated identity payload that `createSession` hands to the build
 * callback whenever an identity-bearing auth state is present.
 *
 * Flat shape: the auth client is not exposed. Every field is something an
 * app opener actually consumes:
 *
 * - `createWorkspace({ id, keyring: signedIn.keyring, tables, kv })`
 * - `attachLocalStorage(workspace.ydoc, { server, ownerId, keyring })`
 * - `openCollaboration(workspace.ydoc, { openWebSocket, onReconnectSignal })`
 * - `roomWsUrl({ baseURL, ownerId, guid, deviceId })`
 *
 * `server` and `baseURL` are both projected because `roomWsUrl` wants the
 * full origin (for the ws:// vs wss:// scheme) while local-storage partition
 * names want the host alone.
 *
 * `ownerId` is stable for the lifetime of a single `SignedIn`: a
 * different-owner sign-in produces a new payload via the session's dispose /
 * rebuild cycle. `keyring` is a callback because the same-owner keyring can
 * rotate (reauth-required to identity-bearing) without a rebuild.
 *
 * Deployment shape (personal vs shared) is not on this payload; it is a property
 * of the server (see `OwnerId` in `@epicenter/identity`).
 */
export type SignedIn = {
	/**
	 * API origin host (e.g. `api.epicenter.so`). Threads into
	 * `attachLocalStorage` and `wipeLocalStorage` so two shared-wiki
	 * deployments on the same machine partition local storage separately.
	 */
	server: string;
	/**
	 * Full API origin URL (e.g. `https://api.epicenter.so`). Threads into
	 * `roomWsUrl` so the scheme upgrades to `wss://` cleanly.
	 */
	baseURL: string;
	ownerId: OwnerId;
	keyring: () => Keyring;
	/**
	 * Bearer-attached WebSocket opener. Pass to
	 * `openCollaboration({ openWebSocket })`.
	 */
	openWebSocket: SyncAuthClient['openWebSocket'];
	/**
	 * Auth state-change publication. `openCollaboration` subscribes via
	 * `onReconnectSignal` to reconnect after token refreshes; that is the
	 * only current consumer, so the field is named for its purpose at the
	 * sub site rather than for the publisher's verb.
	 */
	onReconnectSignal: SyncAuthClient['onStateChange'];
	/**
	 * Auth-owned fetch: attaches the bearer and surfaces auth failures into the
	 * client's `state`. Use for owner-scoped API calls (e.g. the rooms `DELETE`
	 * that destroys a child doc's server room) instead of attaching credentials
	 * by hand.
	 */
	fetch: SyncAuthClient['fetch'];
};

/**
 * Auth-gated payload built once per identity-bearing auth state and disposed
 * on sign-out. `reauth-required` keeps the existing payload mounted: OAuth
 * sessions publish a signed-out gap before a different owner mounts, so two
 * consecutive identity-bearing states are always the same owner.
 *
 * The build callback receives a `SignedIn` value with everything an app
 * opener needs: server + baseURL for transport, ownerId for partitioning,
 * keyring (callback) for encryption, and the two auth functions
 * (`openWebSocket`, `onReconnectSignal`) for cloud sync. The keyring reader
 * pulls from the live `state.keyring` so refreshed keyrings from
 * `/api/session` are picked up by the next `createWorkspace` or
 * `attachLocalStorage` construction without rebuilding the payload. Each
 * construction snapshots the keyring exactly once; nothing re-reads it
 * mid-attach.
 *
 * Requires a `SyncAuthClient` (it threads `auth.openWebSocket` into the payload
 * for cloud sync) whose `state` is Svelte-reactive (use `@epicenter/svelte/auth`,
 * not `@epicenter/auth` directly). A same-origin cookie client is a plain
 * `AuthClient` and cannot be passed here.
 */
export function createSession<T extends Disposable>({
	auth,
	build,
}: {
	auth: SyncAuthClient;
	build: (signedIn: SignedIn) => T;
}) {
	let payload = $state<T | null>(null);
	// `server` and `baseURL` are constant across auth states (the client signs
	// into one API per construction). Compute once; reuse across rebuilds.
	const baseURL = auth.baseURL;
	const server = new URL(baseURL).host;

	function reconcile(state: AuthState) {
		if (state.status === 'signed-out') {
			payload?.[Symbol.dispose]();
			payload = null;
			return;
		}
		if (payload) return;

		buildPayload(state);
	}

	function buildPayload(state: Exclude<AuthState, { status: 'signed-out' }>) {
		payload = build({
			server,
			baseURL,
			ownerId: state.ownerId,
			keyring: () => {
				if (auth.state.status === 'signed-out') {
					throw new Error('[session] keyring() called while signed-out.');
				}
				return auth.state.keyring;
			},
			openWebSocket: auth.openWebSocket,
			onReconnectSignal: auth.onStateChange,
			fetch: auth.fetch,
		});
	}

	const unsubscribe = auth.onStateChange(reconcile);
	reconcile(auth.state);

	return {
		get current(): T | null {
			return payload;
		},
		require(): T {
			if (!payload) {
				throw new Error('[session] require() called while signed-out.');
			}
			return payload;
		},
		[Symbol.dispose]() {
			unsubscribe();
			payload?.[Symbol.dispose]();
			payload = null;
		},
	};
}
