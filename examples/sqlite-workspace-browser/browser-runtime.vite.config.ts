import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Deliberately serves NO cross-origin isolation headers: the smoke proves
// the SAH-pool OPFS worker runs on a plain statically hosted page, exactly
// like the production deployments, Tauri WebViews, and iOS Safari.
export default defineConfig({
	server: { hmr: false },
	optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
	worker: { format: 'es' },
	build: {
		target: 'esnext',
		// `dist`, not a bespoke name: the repo's .gitignore and Biome's ignore
		// list both already cover `dist`, and a name outside them leaves build
		// output tracked by git and linted as source.
		outDir: 'dist',
		emptyOutDir: true,
		rollupOptions: {
			input: resolve(import.meta.dirname, 'browser-runtime.html'),
		},
	},
});
