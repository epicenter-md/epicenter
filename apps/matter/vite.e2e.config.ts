import { fileURLToPath } from 'node:url';
import { mergeConfig } from 'vite';
import base from './vite.config';

// The e2e build of the dev server: identical to the real one, except the native dialog module is
// swapped for a stub so the SPA boots in a plain browser (the dialog is imported at module-eval
// time, before any runtime mock could install). Tauri `invoke`/`Channel` calls are mocked at
// runtime by `src/lib/e2e/install-mocks.ts`, wired in `+layout.ts` behind `import.meta.env.VITE_E2E`.
// Run with: `VITE_E2E=1 vite dev --config vite.e2e.config.ts` (Playwright's webServer does this).
export default mergeConfig(base, {
	// Force the e2e flag on at build time. Vite does not expose a shell `VITE_E2E=1` to
	// `import.meta.env` by default, so define it here; the real `vite.config.ts` leaves it
	// undefined, so the mock-install branch in `+layout.ts` is dead code in production.
	define: {
		'import.meta.env.VITE_E2E': 'true',
	},
	resolve: {
		alias: {
			'@tauri-apps/plugin-dialog': fileURLToPath(
				new URL('./src/lib/e2e/dialog-mock.ts', import.meta.url),
			),
		},
	},
});
