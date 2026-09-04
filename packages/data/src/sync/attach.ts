/**
 * The one WebSocket dial every browser replica makes.
 *
 * ADR-0222 left a host exactly one thing to write: how to make a socket. This
 * is that one thing, written once, because it turned out to be the same
 * everywhere: build the store route's address, hand the socket's four events to
 * the driver, and classify a rejection as a permanent denial or a close.
 * Reconnecting, backoff, cursor placement, and the unacknowledged-submission
 * watchdog all stay in `createSyncConnection`, where they always were.
 *
 * It lives beside the driver rather than in the app that first wrote it,
 * because the classification is correctness rather than taste: getting
 * "permanent" wrong spins a backoff against a refusal forever, or gives up on
 * a network blip. What an application actually varies is the data id it opens.
 *
 * The credential model arrives as a `SocketTransport`, the contract
 * `@epicenter/sync` declares beside the address it is dialled with. An
 * `AuthClient` implements it, so nothing here knows what a credential is: the
 * route builds the address, and auth appends the bearer to it.
 */

import { STORE_SYNC_ROUTE } from '@epicenter/sync/store-route';
import {
	isOpenWebSocketDenial,
	type SocketTransport,
} from '@epicenter/sync/transport';
import {
	type ReplicaDocument,
	registerSyncConnection,
} from '../store/store.js';
import { createSyncConnection, type SyncConnection } from './connection.js';

/**
 * `WebSocket.OPEN`, as the number the standard fixes it to, because this file
 * only ever holds a socket a transport made and never touches the global
 * constructor.
 */
const SOCKET_OPEN = 1;

export type AttachStoreSyncOptions = {
	/**
	 * The open account replica this connection carries, which is also the
	 * address it dials.
	 *
	 * The data id and the generation used to arrive beside it, read off the
	 * same open the caller passed here. A connection is opened against the
	 * store it drives, so there was never a second address to describe
	 * (ADR-0340). The generation is the whole of membership (ADR-0292): it is
	 * created once and never mutated in place, so a socket addressed from the
	 * store can only be carrying this history's bytes, and there is nothing to
	 * announce, nothing to compare, and no supersession to conclude.
	 */
	store: ReplicaDocument;
	/**
	 * How this replica opens its socket. `AuthClient` implements it: it takes
	 * the address the route built and appends the bearer subprotocol, because a
	 * browser upgrade cannot set `Authorization`.
	 */
	transport: SocketTransport;
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
 * Only an account generation calls this (ADR-0233): a local document never
 * syncs, so a signed-out boot has nothing to attach.
 *
 * Whether sync can work is decided by the first dial rather than by inspecting
 * auth here, and a permanent denial is not a failure: the store opened from
 * local state before this was called and works offline without it (ADR-0292).
 * A credential arriving later never resumes this connection; acquiring one
 * changes auth state, and reloading on that change dials fresh.
 */
export function attachStoreSync({
	store,
	transport,
	onTransportError,
}: AttachStoreSyncOptions): SyncConnection {
	const connection = createSyncConnection({
		store,
		dial: ({ cursor, opened, received, closed, denied }) => {
			let socket: WebSocket | undefined;
			let abandoned = false;
			void transport
				.openWebSocket(
					STORE_SYNC_ROUTE.address(store.baseURL, {
						dataId: store.dataId,
						generation: store.generation,
						cursor,
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
						opening.addEventListener('message', (event) => {
							if (typeof event.data === 'string') return;
							received(new Uint8Array(event.data as ArrayBuffer));
						});
						opening.addEventListener('close', () => closed());
						opening.addEventListener('error', () => opening.close());
						// A transport may hand back a socket that is already open, and an
						// open socket never fires `open`: waiting for one would leave the
						// driver with a live socket it never sends on, and nothing would
						// time out, because the connection is perfectly healthy. A
						// browser's `new WebSocket` is always CONNECTING here, so this
						// reads `false` for every dial a page makes.
						if (opening.readyState === SOCKET_OPEN) {
							opened({ send: (bytes) => opening.send(bytes) });
							return;
						}
						opening.addEventListener('open', () =>
							opened({ send: (bytes) => opening.send(bytes) }),
						);
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
							// No callback beside it. A denial is readable from
							// `store.sync.status().denied` for as long as this
							// connection is attached, and the one surface that renders
							// it polls that (ADR-0340); a second channel saying the same
							// thing had no caller in this repository.
							denied();
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
	// The store answers `sync.status()` from here for as long as this connection
	// is the one driving it (ADR-0340). A consumer polls that rather than
	// holding this object, which is why disposal takes the registration back.
	const forget = registerSyncConnection(store.sync, () => connection.status());
	// Contained, because between the registration and the first dial there is
	// nothing for a caller to hold: a throw out of `start` would leave the store
	// answering `status()` for a driver nobody can stop.
	try {
		connection.start();
	} catch (cause) {
		forget();
		connection[Symbol.dispose]();
		throw cause;
	}
	return {
		...connection,
		[Symbol.dispose]() {
			forget();
			connection[Symbol.dispose]();
		},
	};
}
