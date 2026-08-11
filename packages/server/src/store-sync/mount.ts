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
 *
 * Two doors, one partition rule. The sync upgrade is routine; the replace
 * POST (ADR-0231) is the person-initiated verb that publishes a namespace's
 * next document, deliberately out of band from the socket.
 */
import {
	LENS_NAMESPACE,
	MAIN_SUBPROTOCOL,
	parseSubprotocols,
	STORE_REPLACE_ROUTE,
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
import { storeAuthorityName } from '../principal.js';
import type { ServerBindings } from '../server-bindings.js';
import type { Env, ResolveBearerPrincipal } from '../types.js';

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

/** One namespace check for both routes: a name no Lens could carry is refused. */
function parseNamespace(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	if (!LENS_NAMESPACE.test(value) || value.length > 128) return undefined;
	return value;
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
	// The replace POST is an ordinary fetch, so `extractUpgradeBearer` finds its
	// credential in the `Authorization` header it prefers anyway; one guard
	// serves both doors.
	app.use(
		STORE_REPLACE_ROUTE.pattern,
		requireStoreBearer(opts.resolveBearerPrincipal),
	);
	// Route handlers use the portable `Env`; this deployment-facing generic only
	// adds bindings and variables. Keep the one cast at that boundary rather than
	// hide the routes in a one-use sub-app.
	const storeApp = app as unknown as Hono<Env>;
	storeApp.get(
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
			const namespace = parseNamespace(c.req.query('namespace'));
			if (namespace === undefined) {
				return new Response('namespace must be a Lens namespace', {
					status: 400,
				});
			}
			const name = storeAuthorityName(c.var.principal.id, namespace);
			const offered = parseSubprotocols(
				c.req.header('sec-websocket-protocol') ?? null,
			);
			if (offered.length > 0 && !offered.includes(MAIN_SUBPROTOCOL)) {
				return new Response(
					`WebSocket upgrade must offer the ${MAIN_SUBPROTOCOL} subprotocol`,
					{ status: 400 },
				);
			}
			const response = await opts
				.resolveAuthority(c.env, name)
				.fetch(c.req.raw);
			if (response.status !== 101) return response;
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
	storeApp.post(
		STORE_REPLACE_ROUTE.pattern,
		describeRoute({
			description:
				"Publish this namespace's next document: replace its log with the posted state (ADR-0231)",
			tags: ['store-sync'],
		}),
		async (c) => {
			const namespace = parseNamespace(c.req.query('namespace'));
			if (namespace === undefined) {
				return new Response('namespace must be a Lens namespace', {
					status: 400,
				});
			}
			const name = storeAuthorityName(c.var.principal.id, namespace);
			return opts.resolveAuthority(c.env, name).fetch(c.req.raw);
		},
	);
}
