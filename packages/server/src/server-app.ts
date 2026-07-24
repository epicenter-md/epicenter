/**
 * Server app factory. Wires the portable per-request lifecycle (origin + trust
 * resolution, CORS, CSRF, the rooms registry) and returns a `Hono` instance the
 * deployment mounts every other sub-app on.
 *
 * It takes exactly two things, the two axes a deployment varies on:
 *
 *   - `resolveRooms`: how THIS runtime binds the room registry, the one genuinely
 *     runtime-specific portable concern (a hibernating single-writer actor with no
 *     open standard, ADR-0066 Road 2): a Cloudflare Durable Object, or an in-process
 *     `bun:sqlite` registry. The cloud's Postgres connection and `waitUntil` drain
 *     are NOT runtime concerns of this factory; they are cloud concerns the cloud
 *     installs itself ({@link mountCloudDb}), because only Better Auth and billing
 *     use them. The instance composes neither.
 *   - an {@link Identity}: who THIS deployment is on the web (its canonical origin
 *     and the origins it trusts). These vary per deployment, NOT per runtime:
 *     `apps/api` passes the same identity whether it runs on Workers or Bun.
 *
 * Generic over the context `E`: the cloud composes `createServerApp<CloudEnv>` so
 * it can add db + Better Auth state, the instance composes `createServerApp()`
 * (portable {@link Env}) and the type cannot name a cloud variable.
 */

import { Hono } from 'hono';
import { corsMiddleware } from './middleware/cors.js';
import { requireOriginForCookieMutations } from './middleware/require-origin-for-cookie-mutations.js';
import type { Rooms } from './room/contracts.js';
import type { ServerBindings } from './server-bindings.js';
import type { Env } from './types.js';

/**
 * Who this deployment IS on the web. Orthogonal to the runtime: these vary per
 * deployment, not per runtime, so they are supplied explicitly and the auth
 * origin is never inferred from the request.
 */
export type Identity = {
	/**
	 * This deployment's canonical public origin, resolved from the per-request
	 * `env`. Becomes the Better Auth `baseURL`, OAuth issuer, and token audience,
	 * so it must be stable per deployment and never inferred from `c.req.url`.
	 * `apps/api` returns `env.API_PUBLIC_ORIGIN ?? PRODUCTION_API_URL` (dev
	 * override, else the baked constant); `apps/self-host` returns the operator-set
	 * `env.API_PUBLIC_ORIGIN`.
	 */
	resolveOrigin: (env: ServerBindings) => string;
	/**
	 * The origins this deployment trusts for CORS, cookie-mutation CSRF, and
	 * Better Auth's redirect allow-list. The library hardcodes none: `apps/api`
	 * supplies the Epicenter app origins, a self-host supplies its own. Receives
	 * the resolved `baseURL` so a deployment can include its own origin without
	 * restating it, and the per-request `env` so a deployment whose trust set is
	 * operator-configured can read its own binding. A deployment that resolves
	 * its trust set at boot (any Bun host) should close over the result and
	 * ignore both parameters.
	 */
	resolveTrustedOrigins: (baseURL: string, env: ServerBindings) => string[];
};

/**
 * Construct the parent `Hono` app every deployment mounts sub-apps onto.
 *
 * Installs the ordered portable request-scoped middlewares:
 *
 *   1. Origin + trust resolution (a pure read of the env binding).
 *   2. CORS (skips WS upgrades).
 *   3. CSRF gate on `/api/*` (bearer requests skip it inside the middleware).
 *   4. The rooms registry (`c.var.rooms`).
 *
 * The deployment is responsible for exposing a health endpoint on `/`. The cloud's
 * relational-auth context (`c.var.auth`, `c.var.db`) is NOT installed here: the
 * cloud adds it via {@link mountCloudAuth} + {@link mountCloudDb}, so the
 * single-partition instance composes no Better Auth and no Postgres (ADR-0076).
 * WebSocket auth-transport normalization is likewise not global: it lives in
 * {@link mountRoomsApp}, the only WebSocket surface.
 */
type CreateServerAppOptions = {
	/**
	 * Bind this runtime's room registry: a Cloudflare Durable Object
	 * (`createDurableObjectRooms(env.ROOM)`) or an in-process `bun:sqlite` registry
	 * (`createBunRooms(...).rooms`). The one genuinely runtime-specific portable
	 * concern; bound per request onto `c.var.rooms`.
	 */
	resolveRooms: (env: ServerBindings) => Rooms;
	/** Who this deployment is on the web. {@link Identity}. */
	identity: Identity;
};

export function createServerApp<E extends Env = Env>({
	resolveRooms,
	identity: { resolveOrigin, resolveTrustedOrigins },
}: CreateServerAppOptions): Hono<E> {
	const app = new Hono<E>();

	// 1. Deployment auth origin and trust set. Resolved first (a pure read of
	// the env binding, no DB) so downstream middleware, including CORS and the
	// cookie-CSRF guard, can scope the trusted-origin allow-list to this
	// deployment. The origin is supplied explicitly and never inferred from the
	// request, so the auth audience is stable per deployment.
	app.use('*', async (c, next) => {
		const baseURL = resolveOrigin(c.env);
		c.set('authBaseURL', baseURL);
		c.set('trustedOrigins', resolveTrustedOrigins(baseURL, c.env));
		await next();
	});

	// 2. CORS
	app.use('*', corsMiddleware);

	// 3. CSRF gate on every `/api/*` route. Bearer requests are CSRF-immune
	// and skip this check inside the middleware.
	app.use('/api/*', requireOriginForCookieMutations);

	// 4. Rooms registry: bound for any sub-app that reads `c.var.rooms`. The
	// Cloudflare backend wraps `env.ROOM`, a Bun host returns its in-process
	// registry; either way the route stays backend-blind.
	app.use('/api/*', async (c, next) => {
		c.set('rooms', resolveRooms(c.env));
		await next();
	});

	return app;
}
