/**
 * The one WebSocket dial every browser replica makes.
 *
 * ADR-0222 left a host exactly one thing to write: how to make a socket. This
 * is that one thing, written once, because it turned out to be the same
 * everywhere: build the store route's URL, hand the socket's four events to
 * the driver, and classify a rejection as a permanent denial or a close.
 * Reconnecting, backoff, cursor placement, the unacknowledged-submission
 * watchdog, and concluding supersession from a document announcement all stay
 * in `createSyncConnection`, where they always were.
 *
 * It lives beside the driver rather than in the app that first wrote it,
 * because the classification is correctness rather than taste: getting
 * "permanent" wrong spins a backoff against a refusal forever, or gives up on
 * a network blip. What an application actually varies is its database id.
 *
 * The credential model arrives as a two-member port, not as an `AuthClient`.
 * That keeps this file MIT alongside the rest of the store, and an
 * `AuthClient` satisfies it structurally with no adapter, the same way
 * `rebuildDatabase` takes a `StoreTransport` rather than the client itself.
 */

import { isOpenWebSocketDenial } from '@epicenter/sync/auth-subprotocol';
import { STORE_SYNC_ROUTE } from '@epicenter/sync/store-route';
import type { AccountStore } from '../store/store.js';
import { createSyncConnection, type SyncConnection } from './connection.js';

/**
 * How this host reaches its authority over a socket.
 *
 * Structurally satisfied by `AuthClient`, whose `openWebSocket` carries the
 * bearer as a subprotocol because a browser upgrade cannot set
 * `Authorization`, and which resolves only with a credentialed socket.
 */
export type StoreSocketTransport = {
	/** The deployment this replica's authority lives in. */
	readonly baseURL: string;
	/**
	 * Open a credentialed socket, or reject.
	 *
	 * Waits for in-flight machine work such as a token refresh, never for a
	 * human, so a rejection means signed out rather than slow. A rejection
	 * recognised by `isOpenWebSocketDenial` with `permanence: 'permanent'`
	 * stops the driver for good; anything else is a transient close.
	 */
	openWebSocket(url: string | URL): Promise<WebSocket>;
};

export type AttachStoreSyncOptions = {
	/** The open account replica this connection carries. */
	store: AccountStore;
	/** The database id being synced, which addresses the authority. */
	databaseId: string;
	transport: StoreSocketTransport;
	/**
	 * This replica's document was replaced (ADR-0231). The driver has already
	 * stopped; the application discards the local store whole and reloads, and
	 * the fresh boot's ordinary join is the whole of adoption.
	 */
	onSuperseded: () => void;
	/**
	 * No dial in this app generation can ever succeed (reauth required, a
	 * refused credential). Fired from the same classification that stops the
	 * driver, so a boot gate can reject an unbound replica as unavailable
	 * rather than waiting on a bootstrap that will never come.
	 */
	onDenied?: () => void;
	/**
	 * A dial failed for a reason time might repair: verification unreachable,
	 * plain network trouble. Reported rather than raised, because the driver's
	 * own backoff owns the retry and nobody is holding a promise for it.
	 */
	onTransportError: (cause: unknown) => void;
};

/**
 * Attach sync to an open account replica, for this app generation's lifetime,
 * and start it.
 *
 * Only an account generation calls this (ADR-0233): a device document never
 * syncs, so a signed-out boot has nothing to attach.
 *
 * Whether sync can work is decided by the first dial rather than by inspecting
 * auth here. For a bound replica a permanent denial is not a failure and is not
 * reported as one; the store works offline without this. For an unbound one the
 * application rejects its boot, because a signed-in replica that cannot
 * bootstrap is unavailable, never the device document. A credential arriving
 * later never resumes this connection: acquiring one changes auth state, and
 * reloading on that change starts the next generation, which dials fresh.
 */
export function attachStoreSync({
	store,
	databaseId,
	transport,
	onSuperseded,
	onDenied,
	onTransportError,
}: AttachStoreSyncOptions): SyncConnection {
	const connection = createSyncConnection({
		store,
		onSuperseded,
		dial: ({ cursor, document, opened, received, closed, denied }) => {
			let socket: WebSocket | undefined;
			let abandoned = false;
			void transport
				.openWebSocket(
					STORE_SYNC_ROUTE.url(transport.baseURL, {
						databaseId,
						cursor,
						...(document === undefined ? {} : { document }),
					}),
				)
				.then(
					(opening) => {
						if (abandoned) {
							opening.close();
							return;
						}
						socket = opening;
						opening.binaryType = 'arraybuffer';
						opening.addEventListener('open', () =>
							opened({ send: (bytes) => opening.send(bytes) }),
						);
						opening.addEventListener('message', (event) => {
							if (typeof event.data === 'string') return;
							received(new Uint8Array(event.data as ArrayBuffer));
						});
						opening.addEventListener('close', () => closed());
						opening.addEventListener('error', () => opening.close());
					},
					(cause) => {
						if (abandoned) return;
						// A permanent denial means no dial in this generation can ever
						// succeed, so the driver stops instead of retrying a refusal on
						// backoff. Expected whenever this generation's credential needs
						// reauth, so it is a lifecycle fact, not a background error.
						if (
							isOpenWebSocketDenial(cause) &&
							cause.permanence === 'permanent'
						) {
							denied();
							onDenied?.();
							return;
						}
						onTransportError(cause);
						closed();
					},
				);
			return () => {
				abandoned = true;
				socket?.close();
			};
		},
	});
	connection.start();
	return connection;
}
