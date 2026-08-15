/**
 * Honeycrisp's sync: a workspace id, and where a transient failure gets reported.
 *
 * Everything else moved to `attachStoreSync` in `@epicenter/data/sync`, which
 * is where it belonged: building the store route's URL, wiring the socket's
 * four events to the driver, and deciding whether a rejection is a permanent
 * denial or a close are correctness rather than transport taste, and getting
 * the last one wrong either abandons a recoverable replica or spins a backoff
 * against a refusal forever. Two applications wrote the same hundred lines to
 * differ in one identifier.
 *
 * Sharing is being signed in. The route stamps the principal from the resolved
 * bearer and addresses the Durable Object by it, so two devices on one account
 * dial their own partition and converge; there is nothing to pair, invite or
 * approve, and no identifier this file could get wrong.
 */

import type { AuthClient } from '@epicenter/auth';
import type { AccountStore } from '@epicenter/data';
import { attachStoreSync, type SyncConnection } from '@epicenter/data/sync';
import { honeycrispWorkspace } from '@epicenter/honeycrisp';
import { reportBackgroundError } from './report.js';

/**
 * Attach sync to an open account replica, for the lifetime of this app
 * generation. Only an account generation calls this (ADR-0233): a device
 * document never syncs, so a signed-out boot has nothing to attach.
 *
 * The `auth` client is passed where a `StoreSocketTransport` is expected, and
 * satisfies it structurally: `openWebSocket` carries the bearer as a
 * subprotocol, because a browser upgrade cannot set `Authorization`.
 */
export function attachHoneycrispSync({
	store,
	auth,
	onSuperseded,
	onDenied,
}: {
	store: AccountStore;
	auth: AuthClient;
	/**
	 * This replica's document was replaced (ADR-0231). The driver has already
	 * stopped; the application discards the local store whole and reloads, and
	 * the fresh boot's ordinary join is the whole of adoption.
	 */
	onSuperseded: () => void;
	/**
	 * No dial in this app generation can ever succeed (reauth required, a
	 * refused credential), so the boot gate can reject an unbound workspace as
	 * unavailable rather than waiting on a bootstrap that will never come.
	 */
	onDenied?: () => void;
}): SyncConnection {
	return attachStoreSync({
		store,
		workspaceId: honeycrispWorkspace.id,
		transport: {
			baseURL: auth.deployment.baseURL,
			openWebSocket: (url) => auth.openWebSocket(url),
		},
		onSuperseded,
		onDenied,
		onTransportError: reportBackgroundError,
	});
}
