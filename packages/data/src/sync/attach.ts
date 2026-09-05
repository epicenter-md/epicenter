/**
 * The one WebSocket dial every browser replica makes.
 *
 * ADR-0222 left a host exactly one thing to write: how to make a socket. This
 * is that one thing, written once, because it turned out to be the same
 * everywhere: build the store route's URL, hand the socket's events to the
 * driver, and say whether a rejection was a credential refusal or a transport
 * failure. Reconnecting, backoff, cursor placement, and the
 * unacknowledged-submission watchdog all stay in `createSyncConnection`, where
 * they always were.
 *
 * It lives beside the driver rather than in the app that first wrote it,
 * because the classification decides what a person is shown: a refusal is a
 * status line naming what auth needs, and anything else is a background error
 * for the log. What an application actually varies is the data id it opens.
 *
 * The credential model arrives as a one-member port, not as an `AuthClient`.
 * The store says what a socket has to be able to do and nothing about how a
 * credential is obtained, and an `AuthClient` satisfies the port structurally
 * with no adapter.
 */

import {
	isOpenWebSocketDenial,
	MAIN_SUBPROTOCOL,
} from '@epicenter/sync/auth-subprotocol';
import { STORE_SYNC_ROUTE } from '@epicenter/sync/store-route';
import {
	type ReplicaDocument,
	registerSyncConnection,
} from '../store/store.js';
import { createSyncConnection, type SyncConnection } from './connection.js';

/**
 * How this host reaches its authority over a socket.
 *
 * Structurally satisfied by `AuthClient`, whose `openWebSocket` carries the
 * bearer as a subprotocol because a browser upgrade cannot set
 * `Authorization`, and which resolves only with a credentialed socket.
 */
export type StoreSocketTransport = {
	/**
	 * Open a credentialed socket, or reject.
	 *
	 * Waits for in-flight machine work such as a token refresh, never for a
	 * human, so a rejection means signed out rather than slow. A rejection
	 * recognised by `isOpenWebSocketDenial` is reported as that refusal's code
	 * and dialled again on the ordinary backoff; anything else is a transport
	 * error and a close.
	 *
	 * `protocols` is what the CALLER needs the upgrade to offer. The credential
	 * model appends its own bearer subprotocol to it rather than replacing it,
	 * which is why this parameter has to exist: the rooms route refuses an
	 * upgrade that offers protocols without the main one, so a transport that
	 * could only offer a bearer would be refused with a 400 on every dial.
	 */
	openWebSocket(url: string | URL, protocols?: string[]): Promise<WebSocket>;
};

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
	transport: StoreSocketTransport;
	/**
	 * A dial failed for a reason time might repair: verification unreachable,
	 * plain network trouble. Reported rather than raised, because the driver's
	 * own backoff owns the retry and nobody is holding a promise for it.
	 */
	onTransportError: (cause: unknown) => void;
};

/**
 * Attach sync to an open account replica, for as long as the store is open,
 * and start it.
 *
 * Every store is an account replica, because an authority mints every
 * generation (ADR-0336), so every open attaches this.
 *
 * Whether sync can work is decided by each dial rather than by inspecting auth
 * here, and a refusal is not a failure: the store opened from local state
 * before this was called and works offline without it (ADR-0292). A credential
 * arriving later needs no signal, because the driver is still dialling and the
 * next dial simply succeeds.
 */
export function attachStoreSync({
	store,
	transport,
	onTransportError,
}: AttachStoreSyncOptions): SyncConnection {
	const connection = createSyncConnection({
		store,
		dial: ({ cursor, opened, received, closed }) => {
			let socket: WebSocket | undefined;
			let abandoned = false;
			void transport
				.openWebSocket(
					STORE_SYNC_ROUTE.url(store.baseURL, {
						dataId: store.dataId,
						generation: store.generation,
						cursor,
					}),
					// The store transport's own subprotocol, offered on every dial.
					// The credential model adds `bearer.<token>` beside it, and the
					// route echoes only this one back on the 101. Offering the bearer
					// alone is not a weaker dial, it is a refused one: the mount
					// answers 400 to an upgrade that offers protocols without this
					// name, so this line is the difference between sync and no sync.
					[MAIN_SUBPROTOCOL],
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
						// A refusal is a lifecycle fact, not a background error: the
						// credential model said no, which is expected the whole time a
						// person is signed out or needs to reauth. It travels as data
						// on the one close callback and is readable from
						// `store.sync.status().refusal` for as long as this connection
						// is attached, which is what the status line renders (ADR-0340).
						if (isOpenWebSocketDenial(cause)) {
							closed(cause.code);
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
