/**
 * The store transport's one connect URL, shared by every replica and the route
 * that answers them.
 *
 * It lives here rather than in the server because both halves need it and only
 * one of them is a server: a browser replica builds this URL, and a page has no
 * business importing Hono to learn what path to ask for.
 *
 * One path, and the addressing lives in the query. A replica says which
 * application namespace it is syncing and how far through the log it has read.
 * WHOSE data that is comes from the resolved bearer, server-side, and is never
 * in the query at all, so there is no value a client can put here that reaches
 * another partition (ADR-0092).
 */

import {
	BEARER_SUBPROTOCOL_PREFIX,
	MAIN_SUBPROTOCOL,
} from './auth-subprotocol.js';

const stripTrailing = (value: string): string => value.replace(/\/+$/, '');

export const STORE_SYNC_ROUTE = {
	pattern: '/api/store/v1/sync',
	/**
	 * The subprotocols a replica offers: the main one plus `bearer.<token>`,
	 * because a browser upgrade cannot set `Authorization`. The mount echoes only
	 * the main one on the 101, so the token never round-trips.
	 */
	subprotocols(bearer: string): string[] {
		return [MAIN_SUBPROTOCOL, `${BEARER_SUBPROTOCOL_PREFIX}${bearer}`];
	},
	/**
	 * Where this replica connects, asking for everything after `cursor`.
	 *
	 * The cursor is the replica's own durably applied position within the
	 * document it declares, so a reconnect is a catch-up rather than a fresh
	 * start (ADR-0222). `document` is the membership fact (ADR-0231): the
	 * opaque identity of the authority document this replica's state belongs
	 * to, stamped at first entanglement. Equality is the sole condition for
	 * syncing an existing local document; absent is servable only with a
	 * cursor of zero, because a replica with nothing to resume either has no
	 * local document or holds one that grew alone.
	 */
	url(
		baseURL: string,
		params: { namespace: string; cursor: number; document?: string },
	): string {
		const url = new URL(`${stripTrailing(baseURL)}${STORE_SYNC_ROUTE.pattern}`);
		url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
		url.searchParams.set('namespace', params.namespace);
		url.searchParams.set('cursor', String(params.cursor));
		if (params.document !== undefined) {
			url.searchParams.set('document', params.document);
		}
		return url.toString();
	},
} as const;

/**
 * The one out-of-band verb on the store mount: publish a namespace's next
 * document (ADR-0231).
 *
 * A person-initiated, authenticated POST, deliberately outside the sync
 * socket: routine sync makes claims and needs provenance, while a replace
 * makes no coverage claim and needs a lease instead. The body is the encoded
 * replacement state, opaque to the server; the lease travels in the query.
 *
 * `fromDocument` is compare-and-swap, always: the id of the document the
 * replacement was built from, which for a rebuild is the identity the
 * initiating replica has durably stamped. The authority applies the replace
 * only if that is still its current document, and answers a miss with the
 * current id. `atHead` is supplied by reclaim, which promises "same data" and
 * must be refused if the tail moved; reset and restore omit it.
 */
export const STORE_REPLACE_ROUTE = {
	pattern: '/api/store/v1/replace',
	url(
		baseURL: string,
		params: { namespace: string; fromDocument: string; atHead?: number },
	): string {
		const url = new URL(
			`${stripTrailing(baseURL)}${STORE_REPLACE_ROUTE.pattern}`,
		);
		url.searchParams.set('namespace', params.namespace);
		url.searchParams.set('fromDocument', params.fromDocument);
		if (params.atHead !== undefined) {
			url.searchParams.set('atHead', String(params.atHead));
		}
		return url.toString();
	},
} as const;

/**
 * A namespace a Lens could actually have declared.
 *
 * Checked on both sides, from one definition. The server checks it because the
 * value becomes part of a Durable Object name; a client checks nothing, but
 * sharing the grammar means a name the server will refuse is a name no Lens
 * could have carried either.
 */
export const LENS_NAMESPACE =
	/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
