// @ts-check

import svelte from '@astrojs/svelte';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
	output: 'static', // Keep static for now, can change to 'server' if needed
	vite: {
		plugins: [tailwindcss()],
	},
	integrations: [svelte()],
});
