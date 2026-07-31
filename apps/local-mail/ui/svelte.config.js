// One host, one build. Epicenter serves this SPA as the `mail` compiled
// application, so the build always writes into Epicenter's packaged asset tree
// and always bases at its surface route (ADR-0190, ADR-0191). There is no
// second output: the standalone host that consumed a local `dist/` was deleted.
import staticAdapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

const outDir = '../../epicenter/dist/mail';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		// `fallback` makes every deep link resolve to the same shell (client-only
		// routing).
		adapter: staticAdapter({
			pages: outDir,
			assets: outDir,
			fallback: 'index.html',
		}),
		paths: { base: '/apps/mail' },
	},
	preprocess: vitePreprocess(),
};

export default config;
