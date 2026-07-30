import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'wxt';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

export default defineConfig({
	srcDir: 'src',
	modules: ['@wxt-dev/module-svelte'],
	manifest: {
		name: 'Tab Manager',
		description: 'Manage browser tabs with Epicenter',
		// Pins the extension ID to mkbnicfhpacdofmoocppnjjmdfmkkgda across all machines.
		// Required for stable OAuth redirect URL with chrome.identity.
		key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvc/CNEshfeHanSOPQlaQNi/k6Vu81LsrDyxqJEHWPzXa/a4Nk6EeQmSvWAl7YAhW0KGSJoMSGgT0QXh7A0ILCgXtIby4TfVdzlvRkLvhI6eU8iRLUgghvR4Uq9lFLt67uXMFoOQ3hRPxwVNSJqPL9BJv3iWArnaTx54Nl23uot7Xpnt+cDy8qzd8DVW751qKmVbcRgf8oKH67UdcfB1aPyQ64xs+R+P3qXAUdjwEAHDIaAJtEHFyqxIJLutpm9/ahXCyYydayK3atLWKo21M1AbkgClloDGT2CaBawaCG+YksAWrfkaO2WT/lTo0UI8HHcirXuEJuXR4DmyV7vBufwIDAQAB',
		permissions: ['tabs', 'storage', 'identity'],
		// host_permissions needed for favicons and tab info
		host_permissions: ['<all_urls>'],
		// The side panel's replica runs SQLite compiled to WebAssembly, and MV3
		// refuses to compile a module without this source expression. Everything
		// else stays at the MV3 default: scripts from the extension only.
		content_security_policy: {
			extension_pages:
				"script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
		},
	},
	hooks: {
		/**
		 * Let document entrypoints keep a real `import.meta.url`.
		 *
		 * WXT globally defines `import.meta.url` as `self.location.href` so a
		 * background service worker does not crash reaching for `document.location`
		 * (wxt-dev/wxt#392). That substitution is textual, and it runs before Vite
		 * can recognize two patterns the side panel's replica depends on:
		 * `new Worker(new URL('./browser-dedicated-worker.ts', import.meta.url))`
		 * and `new URL('sqlite3.wasm', import.meta.url)`. With the define in place
		 * neither the worker chunk nor the wasm asset is emitted, and the build
		 * succeeds while shipping a side panel whose worker URL 404s.
		 *
		 * The define is only needed where there is no `document`, so drop the plugin
		 * for any entrypoint group that has no background entrypoint. WXT builds
		 * each group with its own config, so the background keeps the workaround.
		 */
		'vite:build:extendConfig'(entrypoints, viteConfig) {
			const hasBackground = entrypoints.some(
				(entrypoint) => entrypoint.type === 'background',
			);
			if (hasBackground) return;
			viteConfig.plugins = (viteConfig.plugins ?? []).filter(
				(plugin) =>
					!(
						plugin &&
						typeof plugin === 'object' &&
						'name' in plugin &&
						plugin.name === 'wxt:define'
					),
			);
		},
	},
	vite: () => ({
		plugins: [tailwindcss()],
		// The side panel owns an Epicenter replica (ADR-0165/ADR-0177), which means
		// a module DedicatedWorker, OPFS SQLite, and Yjs 14 documents crossing the
		// page/worker port. `@sqlite.org/sqlite-wasm` ships its own worker and wasm
		// asset, so pre-bundling it would break those URLs; the worker is emitted as
		// ESM because the worker `@epicenter/data` constructs is `type: 'module'`;
		// and `esnext` keeps the syntax the OPFS adapter emits.
		optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
		worker: { format: 'es' },
		build: { target: 'esnext' },
		resolve: {
			// Document identity breaks if the page and the worker bundle two copies
			// of the CRDT, so `@y/y` is deduped. Tab Manager declares it as a direct
			// dependency (pinned to the version `@epicenter/data` uses) purely so
			// this entry and Rollup have something to resolve from the app root.
			dedupe: ['@y/y'],
			alias: {
				// WXT's unimport transform reaches sibling workspace packages, whose
				// real paths are not under `node_modules`, so `@epicenter/auth` source
				// gets `import { storage } from 'wxt/utils/storage'` injected for a
				// destructured parameter it merely named `storage`. The binding is
				// dead (the parameter shadows it), but Rollup still has to resolve the
				// specifier, and it cannot from a package that has no business
				// depending on WXT. Point it at this app's own copy, which is the
				// module WXT meant all along.
				'wxt/utils/storage': require.resolve('wxt/utils/storage'),
				$lib: resolve(__dirname, 'src/lib'),
			},
		},
	}),
});
