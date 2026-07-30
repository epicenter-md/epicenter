/**
 * CORS middleware.
 *
 * Skips WebSocket upgrades because the 101 response headers are
 * immutable. Trusted origins are the deployment-supplied `c.var.trustedOrigins`
 * (set in `createServerApp`), shared with Better Auth and the cookie-CSRF guard
 * so all three agree on one allow-list.
 */

import { cors } from 'hono/cors';
import { createMiddleware } from 'hono/factory';
import { isWebSocketUpgrade } from '../is-websocket-upgrade.js';
import type { Env } from '../types.js';

export const corsMiddleware = createMiddleware<Env>(async (c, next) => {
	if (isWebSocketUpgrade(c)) return next();
	const { trustedOrigins } = c.var;
	return cors({
		origin: (origin) =>
			origin && trustedOrigins.includes(origin) ? origin : undefined,
		credentials: true,
		// `If-None-Match` carries the document pull's conditional version, and it
		// is not a CORS-safelisted request header: without it here, every
		// cross-origin conditional pull dies at preflight.
		allowHeaders: ['Content-Type', 'Authorization', 'Upgrade', 'If-None-Match'],
		allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
		// `ETag` carries the accepted document version back. It is not a
		// CORS-safelisted RESPONSE header, so a cross-origin browser client reads
		// `null` from it unless it is exposed, and cannot settle the revision.
		exposeHeaders: ['ETag'],
	})(c, next);
});
