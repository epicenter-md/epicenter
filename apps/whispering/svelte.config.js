// Tauri doesn't have a Node.js server to do proper SSR
// so we will use adapter-static to prerender the app (SSG)
// See: https://v2.tauri.app/start/frontend/sveltekit/ for more info
import staticAdapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		alias: {
			'#': '../../packages/ui/src',
		},
		adapter: staticAdapter({
			fallback: 'index.html', // SPA fallback for dynamic routes
		}),
	},

	// Consult https://svelte.dev/docs/kit/integrations
	// for more information about preprocessors
	preprocess: vitePreprocess(),

	vitePlugin: {
		inspector: {
			holdMode: true,
			showToggleButton: 'always',
			// Using 'bottom-left' as base position, but CSS overrides in
			// src/routes/+layout.svelte move it to bottom-center to avoid
			// conflicts with devtools (bottom-left) and toasts (bottom-right)
			toggleButtonPos: 'bottom-left',
			toggleKeyCombo: 'meta-shift',
		},
	},
};

export default config;
