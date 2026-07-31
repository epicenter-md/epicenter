import { APPS } from '@epicenter/constants/apps';
import { workspaceAppViteConfig } from '@epicenter/vite-config';
import { defaultClientConditions, defineConfig, mergeConfig } from 'vite';

const isEpicenterSurface = process.env.EPICENTER_SURFACE === '1';

// The SAH-pool OPFS VFS needs no cross-origin isolation, so this config
// sets no COOP/COEP headers; production static hosting and the Tauri
// WebView serve the same header-free pages as dev.
export default defineConfig(
	mergeConfig(
		// Honeycrisp is the app where "runs in a Tauri WebView" and "the desktop
		// Epicenter host owns my data" come apart: its standalone bundle is the
		// first and not the second, so exactly one of the two conditions is ever
		// active here. Whispering declares both, because for it both are true of
		// the same build (ADR-0190).
		workspaceAppViteConfig(APPS.HONEYCRISP, { tauri: !isEpicenterSurface }),
		{
			optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
			worker: { format: 'es' },
			build: { target: 'esnext' },
			resolve: {
				// Build-time platform DI over the `#platform/*` subpaths in
				// package.json "imports". The spread is load-bearing: custom
				// conditions REPLACE Vite's defaults. A host-only file imported by
				// shared code is unresolvable in the other builds, so a seam
				// mistake fails at build time rather than at user runtime.
				...(isEpicenterSurface && {
					conditions: ['epicenter-host', ...defaultClientConditions],
				}),
			},
		},
	),
);
