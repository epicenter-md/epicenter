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

import { BEARER_SUBPROTOCOL_PREFIX, MAIN_SUBPROTOCOL } from './auth-subprotocol.js';

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
	 * The cursor is the replica's own durably applied position, so a reconnect is
	 * a catch-up rather than a fresh start (ADR-0222).
	 */
	url(baseURL: string, params: { namespace: string; cursor: number }): string {
		const url = new URL(`${stripTrailing(baseURL)}${STORE_SYNC_ROUTE.pattern}`);
		url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
		url.searchParams.set('namespace', params.namespace);
		url.searchParams.set('cursor', String(params.cursor));
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
