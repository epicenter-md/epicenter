// @ts-check

import sitemap from '@astrojs/sitemap';
import svelte from '@astrojs/svelte';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, fontProviders } from 'astro/config';

// https://astro.build/config
export default defineConfig({
	site: 'https://epicenter.so',
	fonts: [
		{
			provider: fontProviders.google(),
			name: 'Fraunces',
			cssVariable: '--font-fraunces',
			weights: ['400 700'],
			styles: ['normal', 'italic'],
			subsets: ['latin'],
		},
	],
	vite: {
		plugins: [tailwindcss()],
		// Top-level resolve.noExternal is inherited by every Vite environment,
		// including the prerender environment Astro builds pages in. Without it,
		// prerendering pages that pull these runes-based deps in through
		// @epicenter/ui fails with ERR_UNKNOWN_FILE_EXTENSION (.svelte).
		resolve: {
			noExternal: ['bits-ui', 'svelte-toolbelt', 'runed'],
		},
	},
	integrations: [svelte(), sitemap()],
});
