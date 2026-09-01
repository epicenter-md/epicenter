// Local Mail is served by Epicenter, below `/apps/mail/`. The standalone web
// build keeps `dist/` at the app root for a static host.
import staticAdapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

const isEpicenterHost = process.env.EPICENTER_HOST === '1';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter: staticAdapter({
			pages: isEpicenterHost ? '../../epicenter/dist/mail' : 'dist',
			assets: isEpicenterHost ? '../../epicenter/dist/mail' : 'dist',
			fallback: 'index.html',
		}),
		...(isEpicenterHost && { paths: { base: '/apps/mail' } }),
	},
	preprocess: vitePreprocess(),
};

export default config;
