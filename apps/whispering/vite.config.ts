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
		rollupOptions: {
			output: {
				manualChunks: (id: string) => {
					// AI SDKs - split each into separate chunks
					if (id.includes('node_modules/openai')) return 'vendor-openai';
					if (id.includes('node_modules/@anthropic-ai')) return 'vendor-anthropic';
					if (id.includes('node_modules/@google/generative-ai')) return 'vendor-google-ai';
					if (id.includes('node_modules/@mistralai')) return 'vendor-mistral';
					if (id.includes('node_modules/groq-sdk')) return 'vendor-groq';
					if (id.includes('node_modules/elevenlabs')) return 'vendor-elevenlabs';

					// Voice Activity Detection (includes ONNX runtime)
					if (id.includes('node_modules/@ricky0123/vad')) return 'vendor-vad';
					if (id.includes('node_modules/onnxruntime')) return 'vendor-onnx';

					// Tauri plugins - group together
					if (id.includes('node_modules/@tauri-apps')) return 'vendor-tauri';

					// UI and utilities
					if (id.includes('node_modules/bits-ui')) return 'vendor-ui';
					if (id.includes('node_modules/@tanstack')) return 'vendor-tanstack';

					// Database
					if (id.includes('node_modules/dexie')) return 'vendor-dexie';

					// Markdown and content
					if (id.includes('node_modules/marked')) return 'vendor-marked';
					if (id.includes('node_modules/gray-matter')) return 'vendor-gray-matter';
				},
			},
		},
		// Increase warning limit slightly (some chunks will still be ~500KB)
		chunkSizeWarningLimit: 600,
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
