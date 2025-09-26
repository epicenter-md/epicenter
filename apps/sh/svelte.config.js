import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		alias: {
			'#': '../../packages/ui/src',
		},
		adapter: adapter({
			fallback: 'index.html', // SPA fallback for dynamic routes
		}),
	},

	// Consult https://svelte.dev/docs/kit/integrations
	// for more information about preprocessors
	preprocess: vitePreprocess(),
};

export default config;
