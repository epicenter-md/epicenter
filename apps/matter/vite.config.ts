import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// Matter is desktop-only (Tauri). There is no browser build to branch on, so the
// app imports `@tauri-apps/*` directly; develop with `bun run tauri dev`.
export default defineConfig({
	plugins: [sveltekit(), tailwindcss()],
	clearScreen: false,
	server: {
		// Tauri's devUrl points here; the port must be fixed.
		port: 5180,
		strictPort: true,
		watch: { ignored: ['**/src-tauri/**'] },
	},
});
