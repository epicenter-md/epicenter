/**
 * Rooms sub-app: one room per named Y.Doc, resolved through the injected
 * `Rooms` registry (a Cloudflare Durable Object in the cloud, an in-process
 * `bun:sqlite` room on a Bun host). The route is backend-blind.
 *
 * URL shape: `/api/rooms/:roomId`. The deployment mounts auth upstream, and
 * `c.var.principal.id` is the partition key by definition.
 *
 * The Durable Object name is the principal-partitioned identifier produced by
 * {@link doName}; nothing here interpolates strings inline. The DO itself
 * is principal-blind: every connection is identified by the
 * `(principalId, nodeId)` pair stamped onto its WebSocket attachment.
 *
 * The route reads neither `c.var.db` nor `c.var.afterResponseQueue`: it records
 * no telemetry, so it composes no Postgres dependency on any deployment.
 *
 * ## WebSocket credential transport
 *
 * A browser `new WebSocket(url, protocols)` upgrade cannot set `Authorization`;
 * the only channel for a bearer is the `Sec-WebSocket-Protocol` list, as
 * `bearer.<token>` (see `@epicenter/sync` `auth-subprotocol.ts`). Rooms is the
 * only WebSocket surface and it is bearer-only, so {@link requireRoomBearer}
 * extracts the credential itself: an explicit `Authorization` header first (a
 * non-browser client can set one), else a single `bearer.<token>` subprotocol
 * entry. The ambient session cookie a browser is forced to attach is never
 * read: the resolver only ever receives the extracted token, so a cookie can
 * never authenticate this surface. Nothing here rewrites `c.req.raw`, so the
 * request keeps its runtime identity end to end: Bun's `server.upgrade()`
 * requires the exact object the `fetch` handler received, and a reconstructed
 * `Request` cannot be upgraded.
 */

import {
	BEARER_SUBPROTOCOL_PREFIX,
	MAIN_SUBPROTOCOL,
	parseSubprotocols,
	ROOM_ROUTE,
} from '@epicenter/sync';
import { Hono, type MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import { describeRoute } from 'hono-openapi';
import { OAuthError } from '../auth/oauth-errors.js';
import { createOAuthUnauthorizedResourceResponse } from '../auth/oauth-resource.js';
import { parseBearer } from '../auth/parse-bearer.js';
import { isWebSocketUpgrade } from '../is-websocket-upgrade.js';
import { RequestGuardError } from '../middleware/request-guard-errors.js';
import { doName } from '../principal.js';
import type { Env, ResolveBearerPrincipal } from '../types.js';

/**
 * Build the rooms sub-app. Rooms are WebSocket-only: the authenticated upgrade
 * is the single way to reach a room. The former one-shot HTTP surface (GET
 * snapshot, POST sync RPC) was deleted with its last consumer; a plain GET
 * answers `426 Upgrade Required` so a stray non-upgrade request gets a readable
 * refusal instead of doc bytes.
 */
function createRoomsApp(): Hono<Env> {
	return new Hono<Env>().get(
		ROOM_ROUTE.pattern,
		describeRoute({
			description: 'Upgrade to the room WebSocket',
			tags: ['rooms'],
		}),
		(c) => {
			if (!isWebSocketUpgrade(c)) {
				return new Response('Rooms are WebSocket-only', { status: 426 });
			}

			// Validate nodeId presence at the route boundary so the backend
			// can trust it is set. nodeId is the participant identity the
			// relay reports in presence; a missing one would produce a
			// presence-ghost connection.
			const nodeId = c.req.query('nodeId');
			if (!nodeId) {
				const err = RequestGuardError.MissingNodeId();
				return c.json(err, err.error.status);
			}

			// An upgrade that offers subprotocols must offer the main one. The
			// backends echo only `epicenter` on the 101; upgrading a client that
			// did not offer it would either fail its handshake (a compliant
			// browser rejects a 101 selecting an unoffered protocol) or, worse,
			// leave the runtime to auto-echo the client's first offer, which for
			// a malformed bearer-only client is the token itself. Refuse here so
			// no backend ever negotiates against a bearer entry. A client
			// offering no subprotocols at all (a non-browser caller using
			// `Authorization`) is fine: there is nothing to echo.
			const offered = parseSubprotocols(
				c.req.header('sec-websocket-protocol') ?? null,
			);
			if (offered.length > 0 && !offered.includes(MAIN_SUBPROTOCOL)) {
				return new Response(
					`WebSocket upgrade must offer the ${MAIN_SUBPROTOCOL} subprotocol`,
					{ status: 400 },
				);
			}

			const roomId = c.req.param('roomId');
			const principalId = c.var.principal.id;
			const room = c.var.rooms.get(doName(principalId, roomId));

			// Identity goes to the backend as data, not stamped into a
			// reconstructed request URL: principalId from auth (authoritative,
			// never the client's), nodeId the client's own. The backend
			// performs its runtime-specific accept (see ResolvedRoom).
			return room.handleUpgrade({
				request: c.req.raw,
				principalId,
				nodeId,
			});
		},
	);
}

/**
 * Bearer auth for the rooms surface, the only WebSocket surface.
 *
 * Owns WebSocket credential extraction: an explicit `Authorization` header
 * first (a non-browser client can set one), else a single `bearer.<token>`
 * subprotocol entry ({@link extractUpgradeBearer}). The extracted token feeds
 * the same {@link ResolveBearerPrincipal} every bearer surface uses; the
 * ambient browser cookie is never consulted, so it can never authenticate a
 * room.
 *
 * A failed WebSocket upgrade is rejected through the runtime's
 * {@link Rooms.rejectUpgrade}: the socket is accepted (echoing the main
 * subprotocol so a compliant browser completes the handshake) and immediately
 * closed with `4000 + status` (401 -> 4401 permanent, 503 -> 4503 retryable),
 * so the browser receives a close code it can read. A plain HTTP error on an
 * upgrade surfaces only as an opaque failed handshake, which the client cannot
 * tell from a network blip. That socket-close path requires the client to have
 * offered the main subprotocol (a 101 selecting an unoffered or absent
 * protocol fails a compliant browser's handshake before the close code is
 * readable); any other failed request answers with the shared HTTP helper.
 * The serialized error is the close reason; the client branches on
 * `error.name`.
 */
function requireRoomBearer<E extends Env>(
	resolveBearerPrincipal: ResolveBearerPrincipal<E>,
): MiddlewareHandler<E> {
	return createMiddleware<E>(async (c, next) => {
		const bearer = extractUpgradeBearer(c.req.raw.headers);
		const { data: principal, error } = bearer
			? await resolveBearerPrincipal(c, bearer)
			: OAuthError.InvalidToken();
		if (error) {
			const offersMainSubprotocol = parseSubprotocols(
				c.req.header('sec-websocket-protocol') ?? null,
			).includes(MAIN_SUBPROTOCOL);
			if (isWebSocketUpgrade(c) && offersMainSubprotocol) {
				return c.var.rooms.rejectUpgrade({
					request: c.req.raw,
					code: 4000 + error.status,
					reason: JSON.stringify(error),
				});
			}
			return createOAuthUnauthorizedResourceResponse(c, error);
		}
		c.set('principal', principal);
		await next();
	});
}

/**
 * Extract the bearer credential from a room upgrade's headers.
 *
 * `Authorization: Bearer <token>` wins when present (a non-browser client can
 * set it directly); otherwise a single `bearer.<token>` subprotocol entry is
 * the credential. Returns null when there is no usable bearer: none present,
 * an empty `bearer.` token, or more than one bearer entry (a malformed
 * client). The caller answers 401 in that case.
 */
function extractUpgradeBearer(headers: Headers): string | null {
	const fromHeader = parseBearer(headers.get('authorization'));
	if (fromHeader) return fromHeader;

	const bearers = parseSubprotocols(headers.get('sec-websocket-protocol'))
		.filter((protocol) => protocol.startsWith(BEARER_SUBPROTOCOL_PREFIX))
		.map((protocol) => protocol.slice(BEARER_SUBPROTOCOL_PREFIX.length));
	if (bearers.length !== 1) return null;
	return bearers[0] || null;
}

/**
 * Mount the rooms surface on a deployment's server app.
 *
 * Bundles auth and the route mount for the only WebSocket surface in one
 * call. Deployments call this once; they do not assemble the chain manually.
 *
 * Rooms is the one surface that closes its own wrapper over the deployment's
 * {@link ResolveBearerPrincipal} (the cloud's OAuth resolver, an instance's
 * env-token resolver) rather than taking a prebuilt `auth` middleware, because
 * a failed WebSocket upgrade must close with a readable code rather than
 * answer a plain HTTP error, and because the credential rides the
 * `Sec-WebSocket-Protocol` list rather than the `Authorization` header.
 */
export function mountRoomsApp<E extends Env = Env>(
	app: Hono<E>,
	opts: { resolveBearerPrincipal: ResolveBearerPrincipal<E> },
): void {
	app.use(
		ROOM_ROUTE.prefixPattern,
		requireRoomBearer(opts.resolveBearerPrincipal),
	);
	app.route('/', createRoomsApp());
}
