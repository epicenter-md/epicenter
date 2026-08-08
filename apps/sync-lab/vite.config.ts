import { defineConfig } from 'vite';

export default defineConfig({
	// The WASM build loads its own binary at runtime, so it must not be
	// pre-bundled into a form that hides that fetch from the browser.
	optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
	build: { target: 'esnext', outDir: 'dist', emptyOutDir: true },
	server: {
		// `wrangler dev` serves the Durable Object; vite serves the page and
		// proxies the socket to it, so one origin covers both in development.
		proxy: { '/sync': { target: 'ws://127.0.0.1:8787', ws: true } },
	},
});
