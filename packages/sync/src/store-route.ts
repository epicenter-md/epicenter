/**
 * The store transport's one connect URL, shared by every replica and the route
 * that answers them.
 *
 * It lives here rather than in the server because both halves need it and only
 * one of them is a server: a browser replica builds this URL, and a page has no
 * business importing Hono to learn what path to ask for.
 *
 * One path, and the addressing lives in the query. A replica says which
 * application id it is syncing and how far through the log it has read.
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
		params: { dataId: string; cursor: number; document?: string },
	): string {
		const url = new URL(`${stripTrailing(baseURL)}${STORE_SYNC_ROUTE.pattern}`);
		url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
		url.searchParams.set('dataId', params.dataId);
		url.searchParams.set('cursor', String(params.cursor));
		if (params.document !== undefined) {
			url.searchParams.set('document', params.document);
		}
		return url.toString();
	},
} as const;

/**
 * An id a data definition could actually have declared (ADR-0276).
 *
 * The value is `defineData({ id })`, so `data` is the noun on both sides. It is
 * not a database: ADR-0269 deleted the SQL projection the word came from. And
 * it is not a store: opening this definition produces one of those, and an
 * application opens two, local and account. This id names what they are
 * definitions OF.
 *
 * Checked on both sides, from one definition. The server checks it because the
 * value becomes part of a Durable Object name; a client checks nothing, but
 * sharing the grammar means a name the server will refuse is a name no
 * definition could have carried either.
 */
export const DATA_ID =
	/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
