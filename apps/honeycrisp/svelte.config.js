// Every host consumes static SPA assets. The browser and standalone desktop
// builds stay at `build/`; Epicenter's build writes into its packaged asset
// tree and serves the SPA below its stable loopback route.
import staticAdapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

const isEpicenterSurface = process.env.EPICENTER_SURFACE === '1';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter: staticAdapter({
			...(isEpicenterSurface && {
				pages: '../epicenter/dist/honeycrisp',
				assets: '../epicenter/dist/honeycrisp',
			}),
			fallback: 'index.html',
		}),
		...(isEpicenterSurface && { paths: { base: '/apps/honeycrisp' } }),
		alias: {
			$routes: './src/routes',
		},
	},
	preprocess: vitePreprocess(),
};

export default config;
