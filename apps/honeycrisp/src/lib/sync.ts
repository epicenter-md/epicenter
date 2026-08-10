/**
 * Honeycrisp's sync: a URL, and nothing else.
 *
 * ADR-0222 left a host exactly one thing to write. Reconnecting on close,
 * reconnecting when the client reports `needsResync`, putting the cursor in the
 * URL and watching for a submission nobody answers are all the library's,
 * because every one of them is correctness rather than transport.
 *
 * Sharing is being signed in. The route stamps the principal from the resolved
 * bearer and addresses the Durable Object by it, so two devices on one account
 * dial their own partition and converge; there is nothing to pair, invite or
 * approve, and no identifier this file could get wrong.
 */
import { reportBackgroundError } from './report.js';
import type { Store } from '@epicenter/data';
import { createSyncConnection, type SyncConnection } from '@epicenter/data/sync';
import { honeycrispLens } from '@epicenter/honeycrisp';
import { STORE_SYNC_ROUTE } from '@epicenter/sync/store-route';
import type { PlatformAuth } from './platform/types.js';

/**
 * Attach sync to an open store, for as long as this auth is signed in.
 *
 * Returns undefined when there is nothing to attach to, which is the ordinary
 * signed-out case rather than a failure: the store is local-first and works
 * completely without this.
 */
export function attachHoneycrispSync({
	store,
	auth,
}: {
	store: Store;
	auth: PlatformAuth;
}): SyncConnection {
	const connection = createSyncConnection({
		store,
		dial: ({ cursor, opened, received, closed }) => {
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
						// A denial is reported as a close, so the driver's own backoff
						// owns the retry rather than this file growing a second one.
						reportBackgroundError(cause);
						if (!abandoned) closed();
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
