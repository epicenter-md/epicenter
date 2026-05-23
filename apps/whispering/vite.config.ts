import { APPS } from '@epicenter/constants/apps';
import { paraglideVitePlugin } from '@inlang/paraglide-js';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import devtoolsJson from 'vite-plugin-devtools-json';

const host = process.env.TAURI_DEV_HOST;

// https://vitejs.dev/config/
export default defineConfig(async () => ({
	plugins: [
		paraglideVitePlugin({
			project: './project.inlang',
			outdir: './src/lib/paraglide',
			// Tauri desktop SPA: no SSR, no URL locale, no cookies.
			// Persist user choice in localStorage; fall back to baseLocale (en).
			// Runtime sets initial locale to zh-CN via root +layout.svelte.
			strategy: ['localStorage', 'baseLocale'],
		}),
		sveltekit(),
		tailwindcss(),
		devtoolsJson(),
	],
	resolve: {
		dedupe: ['yjs'],
	},
	// Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
	//
	// 1. prevent vite from obscuring rust errors
	clearScreen: false,
	// 2. tauri expects a fixed port, fail if that port is not available
	server: {
		port: APPS.AUDIO.port,
		strictPort: true,
		host: host || false,
		hmr: host
			? {
					protocol: 'ws',
					host,
					port: 1421,
				}
			: undefined,
		watch: {
			// 3. tell vite to ignore watching `src-tauri`
			ignored: ['**/src-tauri/**'],
		},
	},
}));
