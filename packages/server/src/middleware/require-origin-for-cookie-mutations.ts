import { createMiddleware } from 'hono/factory';
import { parseBearer } from '../auth/parse-bearer.js';
import type { Env } from '../types.js';
import { RequestGuardError } from './request-guard-errors.js';

/**
 * CSRF guard for state-changing cookie-auth requests on `/api/*`. Cookies ride
 * on cross-site requests automatically, so a malicious page can otherwise
 * forge POST/PUT/DELETE/PATCH calls. Bearer requests are CSRF-immune (the
 * attacker page cannot read the bearer to construct the Authorization header),
 * so they skip the check.
 *
 * Cookie-auth state-changers must carry an `Origin` header in the deployment's
 * trusted-origin allow-list (`c.var.trustedOrigins`, supplied by the
 * deployment). The CORS layer in `app.ts` already restricts `Origin` to the
 * same allow-list for credentialed cross-origin requests; this guard defends
 * the missing-`Origin` case (e.g. an HTML form POST that is a "simple request"
 * per the CORS spec and would not be preflighted).
 */
export const requireOriginForCookieMutations = createMiddleware<Env>(
	async (c, next) => {
		const method = c.req.method;
		if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
			return next();
		}
		if (parseBearer(c.req.header('authorization') ?? null)) return next();
		const origin = c.req.header('origin');
		if (!origin || !c.var.trustedOrigins.includes(origin)) {
			const err = RequestGuardError.ForbiddenOrigin();
			return c.json(err, err.error.status);
		}
		await next();
	},
);
