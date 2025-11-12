import path from 'node:path';
import staticAdapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter: staticAdapter({
			fallback: 'index.html',
		}),
		alias: {
			$lib: path.resolve('./src/lib'),
		},
	},

	preprocess: vitePreprocess(),

	vitePlugin: {
		inspector: {
			holdMode: true,
			showToggleButton: 'always',
			toggleButtonPos: 'bottom-left',
			toggleKeyCombo: 'meta-shift',
		},
	},
};

export default config;
