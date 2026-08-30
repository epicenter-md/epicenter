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
 * One door, one partition rule. Store synchronization is a WebSocket upgrade
 * addressed by the application id and the authenticated principal.
 */
import {
	DATA_ID,
	GENERATIONS_ROUTE,
	MAIN_SUBPROTOCOL,
	parseSubprotocols,
	STORE_SYNC_ROUTE,
} from '@epicenter/sync';
import type { Hono, MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import { describeRoute } from 'hono-openapi';

import { extractUpgradeBearer } from '../auth/extract-upgrade-bearer.js';
import { OAuthError } from '../auth/oauth-errors.js';
import { createOAuthUnauthorizedResourceResponse } from '../auth/oauth-resource.js';
import { isWebSocketUpgrade } from '../is-websocket-upgrade.js';
import { setPrincipalOrReject } from '../middleware/require-auth.js';
import { storeAuthorityName, storeCollectionName } from '../principal.js';
import type { ServerBindings } from '../server-bindings.js';
import type { Env, ResolveBearerPrincipal } from '../types.js';

/** What a runtime hands back for one addressed authority. */
export type StoreAuthorityStub = {
	fetch(request: Request): Promise<Response>;
};

/** How this runtime finds the authority for one generation. */
export type ResolveStoreAuthority = (
	env: ServerBindings,
	name: string,
) => StoreAuthorityStub;

/**
 * The ledger for one (principal, dataId): which generations exist.
 *
 * A generation exists if and only if its row is here (ADR-0293), so this is
 * the gate every read passes and the last write every import makes. It is
 * reached by method call rather than by `fetch`, because it carries numbers
 * rather than bytes and there is no request to forward.
 */
export type GenerationsLedgerStub = {
	allocate(): number | Promise<number>;
	admit(generation: number): void | Promise<void>;
	holds(generation: number): boolean | Promise<boolean>;
	list(): number[] | Promise<number[]>;
};

/** How this runtime finds the ledger for one (principal, dataId). */
export type ResolveGenerationsLedger = (
	env: ServerBindings,
	name: string,
) => GenerationsLedgerStub;

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

/** One id check for both routes: a name no data definition could carry is refused. */
function parseDataId(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	if (!DATA_ID.test(value) || value.length > 128) return undefined;
	return value;
}

/**
 * The generation being synced, or undefined for anything that is not one.
 *
 * The same grammar the client admits at its own boundary (ADR-0292), checked
 * again here because the value becomes part of a Durable Object name. A
 * generation is a positive safe integer; `NaN` out of a URL segment is a bad
 * request, never generation zero.
 */
function parseGeneration(value: string | null): number | undefined {
	if (value === null) return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : undefined;
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
		resolveLedger: ResolveGenerationsLedger;
	},
): void {
	app.use(
		STORE_SYNC_ROUTE.pattern,
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
			const dataId = parseDataId(c.req.query('dataId'));
			if (dataId === undefined) {
				return new Response('dataId must be a data definition id', {
					status: 400,
				});
			}
			const generation = parseGeneration(c.req.query('generation') ?? null);
			if (generation === undefined) {
				return new Response('generation must be a positive integer', {
					status: 400,
				});
			}
			const name = storeAuthorityName(c.var.principal.id, dataId, generation);
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

	// The generations collection (ADR-0292, ADR-0293). Ordinary authenticated
	// requests rather than upgrades, so they go through the same bearer
	// middleware every other `/api` surface uses.
	storeApp.use(
		GENERATIONS_ROUTE.collectionPattern,
		requireStoreBearer(opts.resolveBearerPrincipal),
	);
	storeApp.use(
		GENERATIONS_ROUTE.itemPattern,
		requireStoreBearer(opts.resolveBearerPrincipal),
	);

	storeApp.get(
		GENERATIONS_ROUTE.collectionPattern,
		describeRoute({
			description: 'Every generation of this database that exists',
			tags: ['store-sync'],
		}),
		async (c) => {
			const dataId = parseDataId(c.req.param('dataId'));
			if (dataId === undefined) {
				return c.text('dataId must be a data definition id', 400);
			}
			const ledger = opts.resolveLedger(
				c.env,
				storeCollectionName(c.var.principal.id, dataId),
			);
			return c.json({ generations: await ledger.list() });
		},
	);

	storeApp.post(
		GENERATIONS_ROUTE.collectionPattern,
		describeRoute({
			description: 'Import one whole database state as a new generation',
			tags: ['store-sync'],
		}),
		async (c) => {
			const dataId = parseDataId(c.req.param('dataId'));
			if (dataId === undefined) {
				return c.text('dataId must be a data definition id', 400);
			}
			const ledger = opts.resolveLedger(
				c.env,
				storeCollectionName(c.var.principal.id, dataId),
			);
			// Allocate, store, admit, in that order (ADR-0293). The number is
			// durable before anything is written under it, so it is never reused;
			// the ledger row is last, so a crash leaves an object nothing
			// addresses rather than a generation somebody can open half-written.
			const generation = await ledger.allocate();
			const stored = await opts
				.resolveAuthority(
					c.env,
					storeAuthorityName(c.var.principal.id, dataId, generation),
				)
				.fetch(
					new Request(new URL(c.req.url), {
						method: 'POST',
						body: c.req.raw.body,
						headers: { 'content-type': 'application/octet-stream' },
					}),
				);
			if (!stored.ok) return stored;
			const { position } = (await stored.json()) as { position: number };
			await ledger.admit(generation);
			return c.json({ generation, position });
		},
	);

	storeApp.get(
		GENERATIONS_ROUTE.itemPattern,
		describeRoute({
			description: "One generation's whole state, served verbatim",
			tags: ['store-sync'],
		}),
		async (c) => {
			const dataId = parseDataId(c.req.param('dataId'));
			if (dataId === undefined) {
				return c.text('dataId must be a data definition id', 400);
			}
			const generation = parseGeneration(c.req.param('generation') ?? null);
			if (generation === undefined) {
				return c.text('generation must be a positive integer', 400);
			}
			// The ledger is the gate, not the authority's storage. An object
			// holding bytes whose import never finished is addressable and must
			// not be served: a generation exists if and only if it is listed.
			const ledger = opts.resolveLedger(
				c.env,
				storeCollectionName(c.var.principal.id, dataId),
			);
			if (!(await ledger.holds(generation))) {
				return c.text('no such generation', 404);
			}
			return opts
				.resolveAuthority(
					c.env,
					storeAuthorityName(c.var.principal.id, dataId, generation),
				)
				.fetch(new Request(new URL(c.req.url), { method: 'GET' }));
		},
	);
}
