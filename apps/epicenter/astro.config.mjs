// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import svelte from '@astrojs/svelte';

// https://astro.build/config
export default defineConfig({
	output: 'static', // Keep static for now, can change to 'server' if needed
	vite: {
		plugins: [tailwindcss()],
	},
	integrations: [svelte()],
});
