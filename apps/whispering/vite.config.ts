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

const host = process.env.TAURI_DEV_HOST;
// Tauri CLI builds provide TAURI_ENV_PLATFORM. Epicenter's direct asset build
// names the same trusted target explicitly so `bun run build` does not need to
// fake an operating-system value.
const isTauri =
	process.env.TAURI_ENV_PLATFORM !== undefined ||
	process.env.EPICENTER_SURFACE === '1';

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
			exclude: ['onnxruntime-web', 'onnxruntime-web/wasm'],
		},
		resolve: {
			// Build-time platform DI. Each `#platform/*` subpath (package.json
			// "imports") has a browser impl and a Tauri impl; the Tauri build
			// activates the `tauri` condition, the web build uses `default`
			// (browser). A Tauri-only file imported by shared code is unresolvable
			// under the web condition, so it fails at vite build time, not at user
			// runtime. The `...defaultClientConditions` spread is load-bearing:
			// custom conditions REPLACE Vite's defaults.
			...(isTauri && { conditions: ['tauri', ...defaultClientConditions] }),
		},
		// Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
		//
		// 1. prevent vite from obscuring rust errors
		clearScreen: false,
		server: {
			host: host || false,
			hmr: host
				? {
						protocol: 'ws',
						host,
						port: 1421,
					}
				: undefined,
			watch: {
				// 2. tell vite to ignore watching `src-tauri`
				ignored: ['**/src-tauri/**'],
			},
		},
	}),
);
