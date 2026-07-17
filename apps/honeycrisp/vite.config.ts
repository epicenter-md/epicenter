import { APPS } from '@epicenter/constants/apps';
import { workspaceAppViteConfig } from '@epicenter/vite-config';
import { defineConfig, mergeConfig } from 'vite';

const crossOriginHeaders = {
	'Cross-Origin-Opener-Policy': 'same-origin',
	'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig(
	mergeConfig(workspaceAppViteConfig(APPS.HONEYCRISP, { tauri: true }), {
		server: { headers: crossOriginHeaders },
		preview: { headers: crossOriginHeaders },
		optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
		worker: { format: 'es' },
		build: { target: 'esnext' },
	}),
);
