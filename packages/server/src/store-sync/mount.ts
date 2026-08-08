/**
 * The authenticated upgrade onto one partition's store authority.
 *
 * The same bearer boundary every other Epicenter surface uses: a WebSocket
 * upgrade cannot set `Authorization`, so the credential arrives as a single
 * `bearer.<token>` subprotocol and the 101 echoes only the main one, so the
 * token never round-trips (ADR-0095).
 *
 * The principal is stamped from the resolved bearer and the Durable Object is
 * addressed by it, so this surface cannot be pointed at another partition
 * however the query is written. That is the whole of the authorization: on
 * Cloud a signed-in bearer owns its own data, and there is no second question
 * to ask. Being signed in on two devices IS the sharing model.
 */
import {
	LENS_NAMESPACE,
	MAIN_SUBPROTOCOL,
	parseSubprotocols,
	STORE_SYNC_ROUTE,
} from '@epicenter/sync';
import { Hono, type MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import { describeRoute } from 'hono-openapi';

import { extractUpgradeBearer } from '../auth/extract-upgrade-bearer.js';
import { OAuthError } from '../auth/oauth-errors.js';
import { createOAuthUnauthorizedResourceResponse } from '../auth/oauth-resource.js';
import { isWebSocketUpgrade } from '../is-websocket-upgrade.js';
import { setPrincipalOrReject } from '../middleware/require-auth.js';
import type { ServerBindings } from '../server-bindings.js';
import type { Env, ResolveBearerPrincipal } from '../types.js';
import { storeAuthorityName } from './route.js';

/** What a runtime hands back for one addressed authority. */
export type StoreAuthorityStub = {
	fetch(request: Request): Promise<Response>;
};

/** How this runtime finds the authority for one (principal, namespace). */
export type ResolveStoreAuthority = (
	env: ServerBindings,
	name: string,
) => StoreAuthorityStub;

function requireStoreBearer<E extends Env>(
	resolveBearerPrincipal: ResolveBearerPrincipal<E>,
): MiddlewareHandler<E> {
	return createMiddleware<E>(async (c, next) => {
		const bearer = extractUpgradeBearer(c.req.raw.headers);
		const resolution = bearer
			? await resolveBearerPrincipal(c, bearer)
			: OAuthError.InvalidToken();
		return setPrincipalOrReject(c, next, resolution, (error) =>
			createOAuthUnauthorizedResourceResponse(c, error),
		);
	});
}

function createStoreSyncApp(resolve: ResolveStoreAuthority): Hono<Env> {
	return new Hono<Env>().get(
		STORE_SYNC_ROUTE.pattern,
		describeRoute({
			description: "Upgrade onto this partition's store authority",
			tags: ['store-sync'],
		}),
		async (c) => {
			if (!isWebSocketUpgrade(c)) {
				return new Response('The store transport is WebSocket-only', {
					status: 426,
				});
			}
			// An upgrade offering subprotocols must offer the main one: the 101
			// echoes only `epicenter`, and a compliant browser fails a handshake
			// whose 101 selects a protocol it did not offer. A client offering none
			// (a non-browser caller using `Authorization`) is fine.
			const offered = parseSubprotocols(
				c.req.header('sec-websocket-protocol') ?? null,
			);
			if (offered.length > 0 && !offered.includes(MAIN_SUBPROTOCOL)) {
				return new Response(
					`WebSocket upgrade must offer the ${MAIN_SUBPROTOCOL} subprotocol`,
					{ status: 400 },
				);
			}

			const namespace = c.req.query('namespace') ?? '';
			if (!LENS_NAMESPACE.test(namespace) || namespace.length > 128) {
				return new Response('namespace must be a Lens namespace', {
					status: 400,
				});
			}

			// Server-side principal: never the query's.
			const name = storeAuthorityName(c.var.principal.id, namespace);
			const response = await resolve(c.env, name).fetch(c.req.raw);
			if (response.status !== 101) return response;
			// Echo only the main subprotocol, so a `bearer.<token>` the client
			// offered is never reflected back to it.
			return new Response(response.body, {
				status: 101,
				webSocket: (response as unknown as { webSocket: WebSocket }).webSocket,
				headers:
					offered.length > 0
						? { 'sec-websocket-protocol': MAIN_SUBPROTOCOL }
						: undefined,
			});
		},
	);
}

/**
 * Mount the store transport on a deployment's server app.
 *
 * `resolveAuthority` binds this runtime's backend from the per-request env. The
 * Cloud Worker addresses a Durable Object by name; nothing else implements one
 * yet, and a Bun instance will resolve a per-name in-process authority when it
 * does.
 */
export function mountStoreSyncApp<E extends Env = Env>(
	app: Hono<E>,
	opts: {
		resolveBearerPrincipal: ResolveBearerPrincipal<E>;
		resolveAuthority: ResolveStoreAuthority;
	},
): void {
	app.use(
		STORE_SYNC_ROUTE.pattern,
		requireStoreBearer(opts.resolveBearerPrincipal),
	);
	app.route('/', createStoreSyncApp(opts.resolveAuthority) as unknown as Hono<E>);
}
