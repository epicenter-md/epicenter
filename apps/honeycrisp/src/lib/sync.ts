/**
 * Honeycrisp's sync: a URL, and one classification.
 *
 * ADR-0222 left a host exactly one thing to write: how to make a socket.
 * Reconnecting on close, reconnecting when the client reports `needsResync`,
 * putting the cursor in the URL and watching for a submission nobody answers
 * are all the library's, because every one of them is correctness rather than
 * transport. The one judgment this file adds is translating an
 * `openWebSocket` rejection into the driver's vocabulary: a permanent denial
 * is `denied` (stop for good), anything else is `closed` (retry on backoff).
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
	type SyncConnection,
} from '@epicenter/data/sync';
import { honeycrispLens } from '@epicenter/honeycrisp';
import { isOpenWebSocketDenial } from '@epicenter/sync/auth-subprotocol';
import { STORE_SYNC_ROUTE } from '@epicenter/sync/store-route';
import { reportBackgroundError } from './report.js';

/**
 * Attach sync to an open store, for the lifetime of this app generation.
 *
 * Whether sync can work is decided by the first dial, not by inspecting auth
 * up front: `openWebSocket` rejecting with a permanent denial (signed out,
 * reauth required, a desktop window that holds no credential) reports
 * `denied`, and the driver stops for good. That is not a failure and is not
 * reported as one; the store is local-first and works completely without
 * this. A credential arriving later never resumes this connection: acquiring
 * one changes auth state, and `reloadOnAuthChange` in the root layout starts
 * the next generation, which dials fresh.
 */
export function attachHoneycrispSync({
	store,
	auth,
}: {
	store: Store;
	auth: AuthClient;
}): SyncConnection {
	const connection = createSyncConnection({
		store,
		dial: ({ cursor, opened, received, closed, denied }) => {
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
						// backoff. Expected whenever this replica is signed out, so it
						// is a lifecycle fact, not a background error.
						if (
							isOpenWebSocketDenial(cause) &&
							cause.permanence === 'permanent'
						) {
							denied();
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
