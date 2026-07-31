import { readPresence } from '@epicenter/local-mail/presence';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defaultClientConditions, defineConfig, type Plugin } from 'vite';

const isEpicenterSurface = process.env.EPICENTER_SURFACE === '1';

// The SPA is same-origin with the API. In production `local-mail app` serves the
// built SPA and `/api` from one loopback origin, injecting the per-launch bearer
// into the HTML as `window.__LOCAL_MAIL__`. In dev, Vite serves the SPA and
// proxies `/api` to the running host; the proxy injects that host's bearer, read
// from its `0600` presence file, on every proxied request (SvelteKit's dev HTML
// pipeline bypasses Vite's `transformIndexHtml`, so the prod HTML-injection path
// is not reproducible in dev; proxy-side injection is the spec's dev handoff).
// The dev SPA carries no bearer of its own and no credential is typed by a human.
const SPA_DEV_PORT = 5177;

/**
 * Deny framing on every dev response, matching the prod host, so a cross-origin
 * page cannot frame the (proxy-authenticated) dev SPA and clickjack a triage
 * write. A `configureServer` middleware, because SvelteKit's dev page responses
 * bypass Vite's `server.headers`.
 */
function denyFramingInDev(): Plugin {
	return {
		name: 'local-mail-deny-framing',
		apply: 'serve',
		configureServer(server) {
			server.middlewares.use((_req, res, next) => {
				res.setHeader('X-Frame-Options', 'DENY');
				res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
				next();
			});
		},
	};
}

export default defineConfig(({ command }) => {
	// Read the running host's presence once, at config load. Prefer its origin as
	// the proxy target (so an ephemeral host port just works); fall back to
	// LOCAL_MAIL_PORT (default 4177) when the host is not up yet. Start the host
	// first: if presence is absent, /api calls are unauthenticated until Vite is
	// restarted, and a host restart rotates the bearer (restart Vite to pick it up).
	const presence = command === 'serve' ? readPresence() : null;
	const target =
		presence?.origin ??
		`http://127.0.0.1:${Number(process.env.LOCAL_MAIL_PORT) || 4177}`;
	return {
		plugins: [sveltekit(), tailwindcss(), denyFramingInDev()],
		resolve: {
			// Build-time platform DI over the `#platform/mail-host` subpath in
			// package.json "imports": which host mounted the mail surface, and what
			// authenticates it (ADR-0191). The spread is load-bearing, because
			// custom conditions REPLACE Vite's defaults.
			...(isEpicenterSurface && {
				conditions: ['epicenter-host', ...defaultClientConditions],
			}),
		},
		server: {
			port: SPA_DEV_PORT,
			strictPort: true,
			proxy: {
				'/api': {
					target,
					// Rewrite Host to the target so the host's Host check passes, and
					// inject the host's per-launch bearer so the dev SPA authenticates
					// without carrying a credential itself.
					changeOrigin: true,
					configure: (proxy) => {
						proxy.on('proxyReq', (proxyReq) => {
							if (presence?.bearer) {
								proxyReq.setHeader(
									'authorization',
									`Bearer ${presence.bearer}`,
								);
							}
						});
					},
				},
			},
		},
	};
});
