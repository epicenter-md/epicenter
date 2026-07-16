import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const isolationHeaders = {
	'Cross-Origin-Opener-Policy': 'same-origin',
	'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
	server: { headers: isolationHeaders, hmr: false },
	preview: { headers: isolationHeaders },
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
