import { APPS } from '@epicenter/constants/apps';
import { workspaceAppViteConfig } from '@epicenter/vite-config';
import { defineConfig, mergeConfig } from 'vite';

// Local two-client demos can give each browser origin a same-origin `/api`
// facade without weakening the instance's production CORS policy.
const devInstanceProxy = process.env.HONEYCRISP_DEV_INSTANCE_PROXY;

// The SAH-pool OPFS VFS needs no cross-origin isolation, so this config
// sets no COOP/COEP headers; production static hosting and the Tauri
// WebView serve the same header-free pages as dev.
export default defineConfig(
	mergeConfig(workspaceAppViteConfig(APPS.HONEYCRISP, { tauri: true }), {
		optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
		worker: { format: 'es' },
		build: { target: 'esnext' },
		server: devInstanceProxy
			? {
					proxy: {
						'/api': {
							target: devInstanceProxy,
							changeOrigin: true,
						},
					},
				}
			: undefined,
	}),
);
