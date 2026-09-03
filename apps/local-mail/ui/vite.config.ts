import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defaultClientConditions, defineConfig, type Plugin } from 'vite';

// Two builds from one source. Under `EPICENTER_HOST=1` the SPA is served by
// Epicenter below `/apps/mail/` and reaches the host's SQLite files and
// credential store; otherwise it is a standalone static build over IndexedDB,
// OPFS, and a credential that lives as long as the tab (ADR-0310).
const isEpicenterHost = process.env.EPICENTER_HOST === '1';

const SPA_DEV_PORT = 5177;

/**
 * Deny framing on every dev response so a cross-origin page cannot frame the
 * dev SPA and clickjack a triage write. A `configureServer` middleware, because
 * SvelteKit's dev page responses bypass Vite's `server.headers`.
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
	resolve: {
		// Build-time platform DI over `#platform/binding`. The spread is
		// load-bearing: custom conditions REPLACE Vite's defaults, so a seam
		// mistake fails at build time rather than at a person's runtime.
		...(isEpicenterHost && {
			conditions: ['epicenter-host', ...defaultClientConditions],
		}),
	},
	server: { port: SPA_DEV_PORT, strictPort: true },
});
