/**
 * Honeycrisp's sync: a database id, and where a transient failure gets reported.
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
import type { BrowserAccountStore } from '@epicenter/data/browser';
import { attachStoreSync, type SyncConnection } from '@epicenter/data/sync';
import { honeycrispDefinition } from '@epicenter/honeycrisp';
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
	generation,
	auth,
	onDenied,
}: {
	store: BrowserAccountStore;
	/**
	 * The generation this replica holds, which addresses its authority with the
	 * database id (ADR-0292).
	 *
	 * It arrives from the route rather than being discovered here, and that is
	 * what deleted supersession: a generation is created once and never mutated
	 * in place, so a socket addressed at one cannot be told it belongs to
	 * another.
	 */
	generation: number;
	auth: AuthClient;
	/**
	 * No dial in this app generation can ever succeed (reauth required, a
	 * refused credential). Reported rather than fatal: the store opened from
	 * local state before this was called and works offline without it.
	 */
	onDenied?: () => void;
}): SyncConnection {
	return attachStoreSync({
		store,
		dataId: honeycrispDefinition.id,
		generation,
		transport: {
			openWebSocket: (url) => auth.openWebSocket(url),
		},
		onDenied,
		onTransportError: reportBackgroundError,
	});
}
