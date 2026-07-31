// Both hosts consume static SPA assets. The standalone build stays at `dist/`,
// where `local-mail app` reads it and serves it at the loopback origin root.
// Epicenter's build writes into its packaged asset tree and serves the SPA
// below its stable `/apps/mail/` surface route (ADR-0190, ADR-0191).
import staticAdapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

const isEpicenterSurface = process.env.EPICENTER_SURFACE === '1';
const outDir = isEpicenterSurface ? '../../epicenter/dist/mail' : 'dist';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		// `fallback` makes every deep link resolve to the same shell (client-only
		// routing), under either host.
		adapter: staticAdapter({
			pages: outDir,
			assets: outDir,
			fallback: 'index.html',
		}),
		...(isEpicenterSurface && { paths: { base: '/apps/mail' } }),
	},
	preprocess: vitePreprocess(),
};

export default config;
