import { APPS } from '@epicenter/constants/apps';
// VAD fetches these files from `/vad/*` at runtime (they are not bundled). The
// recorder package owns the VAD capability and resolves the asset source paths
// from its own pinned dependency tree; we just copy them into the served `/vad/`
// directory at build time (see @epicenter/recorder/vad-assets).
import {
	VAD_ASSET_DEST,
	vadAssetSources,
} from '@epicenter/recorder/vad-assets';
import { workspaceAppViteConfig } from '@epicenter/vite-config';
import { defaultClientConditions, defineConfig, mergeConfig } from 'vite';
import devtoolsJson from 'vite-plugin-devtools-json';
import { viteStaticCopy } from 'vite-plugin-static-copy';

const isEpicenterSurface = process.env.EPICENTER_SURFACE === '1';

export default defineConfig(
	mergeConfig(workspaceAppViteConfig(APPS.WHISPERING), {
		plugins: [
			devtoolsJson(),
			viteStaticCopy({
				// `stripBase` drops the source's directory segments so each file
				// lands directly at /vad/<name> (the plugin otherwise mirrors the
				// full absolute source path under dest).
				targets: vadAssetSources.map((src) => ({
					src,
					dest: VAD_ASSET_DEST,
					rename: { stripBase: true },
				})),
			}),
		],
		// onnxruntime-web (pulled in by @ricky0123/vad-web) ships a WASM glue
		// .mjs that Vite's dep optimizer can't pre-bundle (it 404s on
		// .vite/deps/ort-wasm-simd-threaded.mjs). Keep that package and its wasm
		// subpath native, but still prebundle vad-web so Vite converts its
		// CommonJS entry to ESM for browser dev mode.
		optimizeDeps: {
			// @sqlite.org/sqlite-wasm resolves its .wasm relative to its own
			// module URL inside the records Worker; pre-bundling breaks that.
			exclude: [
				'onnxruntime-web',
				'onnxruntime-web/wasm',
				'@sqlite.org/sqlite-wasm',
			],
		},
		// The records Worker (module type) transitively includes sqlite-wasm;
		// its chunk needs ES output and current syntax, same as honeycrisp.
		worker: { format: 'es' },
		build: { target: 'esnext' },
		resolve: {
			// Build-time platform DI over the `#platform/*` subpaths (package.json
			// "imports"). This build activates both conditions because both are
			// true of it, and they answer different questions: `epicenter-host`
			// selects the leaves whose owner is the Bun host (its replica,
			// credential, deployment choice, blob bytes, and asset base), `tauri`
			// the leaves that call native commands. Whispering has no build where
			// they come apart, but Honeycrisp does, which is why they are named
			// apart rather than collapsed (ADR-0190). The web build uses `default`
			// (browser) for every seam, so a desktop-only file imported by shared
			// code is unresolvable there and fails at vite build time rather than
			// at user runtime. The `...defaultClientConditions` spread is
			// load-bearing: custom conditions REPLACE Vite's defaults.
			...(isEpicenterSurface && {
				conditions: ['epicenter-host', 'tauri', ...defaultClientConditions],
			}),
		},
	}),
);
