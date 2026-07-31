import {
	MAIL_API_PREFIX,
	MAIL_DEV_API_PORT,
} from '@epicenter/local-mail/mount';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vite';

// The SPA is same-origin with the mail surface under both of its servers. In
// production the Epicenter host serves this build and mounts the surface at
// MAIL_API_PREFIX on the same origin. In dev, Vite serves the SPA and proxies
// that same path to `scripts/dev-api.ts` on a fixed loopback port.
//
// No credential crosses this proxy. The dev API server has no gate, because it
// is dev-only and loopback-bound; in production the host's own browser session
// authenticates the request and the SPA attaches nothing (ADR-0191). That is
// why there is no build-time platform seam here: one base, one client, both
// servers.
const SPA_DEV_PORT = 5177;

/**
 * Deny framing on every dev response, matching the production host, so a
 * cross-origin page cannot frame the dev SPA and clickjack a triage write. A
 * `configureServer` middleware, because SvelteKit's dev page responses bypass
 * Vite's `server.headers`.
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

export default defineConfig({
	plugins: [sveltekit(), tailwindcss(), denyFramingInDev()],
	server: {
		port: SPA_DEV_PORT,
		strictPort: true,
		proxy: {
			[MAIL_API_PREFIX]: {
				target: `http://127.0.0.1:${MAIL_DEV_API_PORT}`,
				// Rewrite Host to the target so the dev API server's Host check passes.
				changeOrigin: true,
			},
		},
	},
});
