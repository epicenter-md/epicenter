import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, searchForWorkspaceRoot } from 'vite';

const crossOriginHeaders = {
	'Cross-Origin-Opener-Policy': 'same-origin',
	'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
	plugins: [sveltekit(), tailwindcss()],
	server: {
		headers: crossOriginHeaders,
		fs: {
			allow: [searchForWorkspaceRoot(process.cwd())],
		},
	},
	preview: {
		headers: crossOriginHeaders,
	},
	optimizeDeps: {
		exclude: ['@sqlite.org/sqlite-wasm'],
	},
	worker: {
		format: 'es',
	},
	build: {
		target: 'esnext',
	},
});
