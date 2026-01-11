import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import devtoolsJson from 'vite-plugin-devtools-json';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

const host = process.env.TAURI_DEV_HOST;

// https://vitejs.dev/config/
export default defineConfig(async () => ({
	plugins: [
		sveltekit(),
		tailwindcss(),
		devtoolsJson(),
		nodePolyfills({
			// Enable polyfills for Buffer (needed by gray-matter)
			globals: {
				Buffer: true,
			},
		}),
	],
	build: {
		// Chunk splitting configuration to reduce bundle sizes
		// Target: all chunks < 500KB for optimal loading
		rollupOptions: {
			output: {
				manualChunks: (id: string) => {
					// Skip non-node_modules (app code stays in main bundle)
					if (!id.includes('node_modules')) return undefined;

					// ============================================
					// AI SDKs - split each into separate chunks
					// These are large and loaded on-demand
					// ============================================
					if (id.includes('node_modules/openai')) return 'vendor-openai';
					if (id.includes('node_modules/@anthropic-ai')) return 'vendor-anthropic';
					if (id.includes('node_modules/@google/generative-ai')) return 'vendor-google-ai';
					if (id.includes('node_modules/@mistralai')) return 'vendor-mistral';
					if (id.includes('node_modules/groq-sdk')) return 'vendor-groq';
					if (id.includes('node_modules/elevenlabs')) return 'vendor-elevenlabs';

					// ============================================
					// Voice Activity Detection - largest dependency
					// ONNX runtime is ~500KB alone
					// ============================================
					if (id.includes('node_modules/onnxruntime-web')) return 'vendor-onnx-web';
					if (id.includes('node_modules/onnxruntime-common')) return 'vendor-onnx-common';
					if (id.includes('node_modules/@ricky0123/vad')) return 'vendor-vad';

					// ============================================
					// Tauri - split by plugin type
					// ============================================
					if (id.includes('node_modules/@tauri-apps/api')) return 'vendor-tauri-api';
					if (id.includes('node_modules/@tauri-apps/plugin')) return 'vendor-tauri-plugins';

					// ============================================
					// UI Libraries
					// ============================================
					if (id.includes('node_modules/bits-ui')) return 'vendor-bits-ui';
					if (id.includes('node_modules/@tanstack/svelte-query')) return 'vendor-tanstack-query';
					if (id.includes('node_modules/@tanstack/svelte-table') || id.includes('node_modules/@tanstack/table-core')) return 'vendor-tanstack-table';
					if (id.includes('node_modules/svelte-sonner')) return 'vendor-sonner';
					if (id.includes('node_modules/mode-watcher')) return 'vendor-mode-watcher';

					// ============================================
					// Data & Validation
					// ============================================
					if (id.includes('node_modules/dexie')) return 'vendor-dexie';
					if (id.includes('node_modules/arktype') || id.includes('node_modules/arkregex')) return 'vendor-arktype';

					// ============================================
					// Content Processing
					// ============================================
					if (id.includes('node_modules/marked')) return 'vendor-marked';
					if (id.includes('node_modules/gray-matter')) return 'vendor-gray-matter';
					if (id.includes('node_modules/dompurify')) return 'vendor-dompurify';

					// ============================================
					// Utilities
					// ============================================
					if (id.includes('node_modules/date-fns')) return 'vendor-date-fns';
					if (id.includes('node_modules/nanoid')) return 'vendor-nanoid';

					// ============================================
					// Polyfills & Runtime
					// ============================================
					if (id.includes('node_modules/buffer') || id.includes('node_modules/process')) return 'vendor-polyfills';

					// All other node_modules go to a shared vendor chunk
					return 'vendor-misc';
				},
			},
		},
		// Strict limit - should not be exceeded with proper splitting
		chunkSizeWarningLimit: 500,
	},
	// Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
	//
	// 1. prevent vite from obscuring rust errors
	clearScreen: false,
	// 2. tauri expects a fixed port, fail if that port is not available
	server: {
		port: 1420,
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
