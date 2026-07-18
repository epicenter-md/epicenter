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
		outDir: 'dist-browser-runtime',
		emptyOutDir: true,
		rollupOptions: {
			input: resolve(import.meta.dirname, 'browser-runtime.html'),
		},
	},
});
