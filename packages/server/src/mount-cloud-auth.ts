/**
 * `mountCloudAuth`: the cloud-only relational-auth layer (Better Auth + Postgres).
 *
 * The hosted cloud composes Better Auth: a per-request `c.var.auth` instance
 * (sessions, OAuth, JWKS) over Postgres, plus the `authApp` surface (sign-in,
 * consent, OAuth metadata, and the Better Auth catch-all). The single-partition
 * instance composes NEITHER (ADR-0075): it authenticates one operator-supplied
 * bearer and has no sessions, so it never calls this and never constructs Better
 * Auth. That is the seam that lets an instance drop Postgres entirely.
 *
 * Call it once, right after `createServerApp` and before the principal-scoped mounts:
 * it installs the auth-context middleware (so `c.var.auth` is set before any
 * cookie-or-bearer wrapper or `authApp` route reads it) and mounts `authApp` at
 * the root.
 */

import type { Context, Hono } from 'hono';
import { type CloudAuthBindings, createAuth } from './auth/create-auth.js';
import { authApp } from './routes/auth.js';
import type { CloudEnv } from './types.js';

export { CloudAuthBindings } from './auth/create-auth.js';

export function mountCloudAuth(
	app: Hono<CloudEnv>,
	opts: {
		/**
		 * Resolve this cloud deployment's relational-auth secrets
		 * ({@link CloudAuthBindings}) from its own env. The secrets are NOT in the
		 * portable `ServerBindings` (the relational-auth substrate is Cloud-only,
		 * ADR-0076), so the cloud supplies them at its own edge: the Worker casts its
		 * deploy-gated `c.env as Cloudflare.Env`, the Bun host closes over its
		 * validated env. Read per request because a Worker has no module-scope env.
		 */
		resolveAuthSecrets: (c: Context<CloudEnv>) => CloudAuthBindings;
		/**
		 * Serve the SvelteKit fallback shell for hosted auth browser surfaces after
		 * auth route policy has run. The app deployment owns the concrete asset
		 * source; the shared server package only calls it.
		 */
		serveAuthUiShell: (c: Context<CloudEnv>) => Response | Promise<Response>;
	},
): void {
	// Better Auth context. Built per request (Workers expose no module-scope env
	// or db connection), reading the db handle, auth origin, and trusted origins
	// the `createServerApp` lifecycle already resolved. Installed before the
	// cookie-or-bearer wrappers and the `authApp` routes mounted below read
	// `c.var.auth` and `c.var.authSecrets`. First-party OAuth client rows are
	// seeded at deploy time (apps/api `oauth:seed:*`), so this path only reads.
	app.use('*', async (c, next) => {
		// Resolve the cloud-only secrets once and stamp them on the context, so both
		// readers (this Better Auth construction and the `authApp` sign-in page) take
		// them from one resolved value rather than the raw `c.env` bag (ADR-0076).
		const authSecrets = opts.resolveAuthSecrets(c);
		c.set('authSecrets', authSecrets);
		c.set('authUiShell', opts.serveAuthUiShell);
		c.set(
			'auth',
			createAuth({
				db: c.var.db,
				env: authSecrets,
				baseURL: c.var.authBaseURL,
				trustedOrigins: c.var.trustedOrigins,
			}),
		);
		await next();
	});
	// Auth surface (HTML pages + OAuth metadata; no /api prefix by design).
	app.route('/', authApp);
}
