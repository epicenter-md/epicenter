import { defineConfig } from 'vite';

export default defineConfig({
	appType: 'mpa',
	server: {
		port: 5199,
		strictPort: true,
		headers: {
			// Cross-origin isolation: enables performance.measureUserAgentSpecificMemory
			// (worker-inclusive memory) and keeps OPFS options open.
			'Cross-Origin-Opener-Policy': 'same-origin',
			'Cross-Origin-Embedder-Policy': 'require-corp',
		},
	},
	optimizeDeps: {
		exclude: ['@sqlite.org/sqlite-wasm'],
		include: ['yjs', 'y-indexeddb'],
	},
	worker: {
		format: 'es',
	},
});
