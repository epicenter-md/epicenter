/**
 * Build the SPA as one self-contained document. The token gate 401s any
 * request without the browser session. Keeping Query in one document also
 * gives the Bun host one explicit script hash for its CSP. Other trusted SPAs
 * may emit assets under their own directories in the shared application dist.
 */

import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
	// Absolute, so the build works regardless of the invoking cwd (a relative
	// root resolves against process.cwd(), not this file).
	root: fileURLToPath(new URL('./src/ui', import.meta.url)),
	plugins: [
		tailwindcss(),
		// The plugin resolves svelte.config.js against the Vite root (src/ui),
		// so point it back at the package-root config explicitly.
		svelte({
			configFile: fileURLToPath(new URL('./svelte.config.js', import.meta.url)),
		}),
		// Last, so it inlines the CSS asset Tailwind emitted into dist/index.html.
		viteSingleFile(),
	],
	build: {
		outDir: fileURLToPath(new URL('./dist/query', import.meta.url)),
		emptyOutDir: true,
	},
});
