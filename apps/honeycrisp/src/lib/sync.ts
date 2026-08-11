/**
 * Honeycrisp's sync: a URL, and one classification.
 *
 * ADR-0222 left a host exactly one thing to write: how to make a socket.
 * Reconnecting on close, reconnecting when the client reports `needsResync`,
 * putting the cursor in the URL, watching for a submission nobody answers,
 * and concluding `superseded` from the document announcement (ADR-0231) are all the
 * library's, because every one of them is correctness rather than transport.
 * What this file adds is transport only: translating an `openWebSocket`
 * rejection into the driver's vocabulary (a permanent denial is `denied`,
 * anything else is `closed`), and the discard-and-reload the application
 * runs when the driver reports supersession.
 *
 * Sharing is being signed in. The route stamps the principal from the resolved
 * bearer and addresses the Durable Object by it, so two devices on one account
 * dial their own partition and converge; there is nothing to pair, invite or
 * approve, and no identifier this file could get wrong.
 */

import type { AuthClient } from '@epicenter/auth';
import type { Store } from '@epicenter/data';
import {
	createSyncConnection,
	type StoreTransport,
	type SyncConnection,
} from '@epicenter/data/sync';
import { honeycrispLens } from '@epicenter/honeycrisp';
import { isOpenWebSocketDenial } from '@epicenter/sync/auth-subprotocol';
import { STORE_SYNC_ROUTE } from '@epicenter/sync/store-route';
import { reportBackgroundError } from './report.js';

/**
 * How Honeycrisp reaches its store's authenticated door out of band from the
 * socket: the rebuild's replace POST (ADR-0231).
 */
export function honeycrispStoreTransport(auth: AuthClient): StoreTransport {
	return {
		fetch: (input, init) => auth.fetch(input, init),
		baseURL: auth.deployment.baseURL,
		namespace: honeycrispLens.namespace,
	};
}

/**
 * Attach sync to an open workspace store, for the lifetime of this app
 * generation. Only a workspace generation calls this (ADR-0233): a private
 * document never syncs, so a signed-out boot has nothing to attach.
 *
 * Whether sync can work is still decided by the first dial, not by inspecting
 * auth again here: `openWebSocket` rejecting with a permanent denial (reauth
 * required, a revoked credential, a window that holds none) reports `denied`,
 * and the driver stops for good. For a bound workspace that is not a failure
 * and is not reported as one; the store works offline without this. For an
 * unbound one the application rejects its boot, because a signed-in workspace
 * that cannot bootstrap is unavailable, never the private document. A
 * credential arriving later never resumes this connection: acquiring one
 * changes auth state, and `reloadOnAuthChange` in the root layout starts the
 * next generation, which dials fresh.
 */
export function attachHoneycrispSync({
	store,
	auth,
	onSuperseded,
	onDenied,
}: {
	store: Store;
	auth: AuthClient;
	/**
	 * This replica's document was replaced (ADR-0231). The driver has
	 * already stopped; the application discards the local store whole and
	 * reloads, and the fresh boot's ordinary join is the whole of adoption.
	 */
	onSuperseded: () => void;
	/**
	 * No dial in this app generation can ever succeed (reauth required, a
	 * refused credential). Fired from the same classification that stops the
	 * driver, so the boot gate can reject an unbound workspace as unavailable
	 * rather than waiting on a bootstrap that will never come.
	 */
	onDenied?: () => void;
}): SyncConnection {
	const connection = createSyncConnection({
		store,
		onSuperseded,
		dial: ({ cursor, document, opened, received, closed, denied }) => {
			let socket: WebSocket | undefined;
			let abandoned = false;
			// `openWebSocket` carries the bearer as a subprotocol, because a browser
			// upgrade cannot set `Authorization`, and resolves only with a
			// credentialed socket. It waits for in-flight machine work such as a
			// token refresh, never for a human, so a rejection here means signed
			// out rather than slow.
			void auth
				.openWebSocket(
					STORE_SYNC_ROUTE.url(auth.deployment.baseURL, {
						namespace: honeycrispLens.namespace,
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
						// Everything else is transient (verification unreachable, plain
						// network trouble): reported as a close, so the driver's own
						// backoff owns the retry rather than this file growing a second
						// one.
						reportBackgroundError(cause);
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
