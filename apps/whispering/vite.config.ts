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
import {
	defaultClientConditions,
	defaultServerConditions,
	defineConfig,
	mergeConfig,
} from 'vite';
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
			exclude: ['onnxruntime-web', 'onnxruntime-web/wasm'],
		},
		resolve: {
			// Build-time host composition. Semantic subpath imports in package.json
			// select complete browser or Epicenter operations; the Epicenter build
			// activates the `epicenter` condition, the web build uses `default`
			// (browser). An Epicenter-only file imported by shared code is unresolvable
			// under the web condition, so it fails at vite build time, not at user
			// runtime. The `...defaultClientConditions` spread is load-bearing:
			// custom conditions REPLACE Vite's defaults.
			...(isEpicenterSurface && {
				conditions: ['epicenter', ...defaultClientConditions],
			}),
		},
		...(isEpicenterSurface && {
			ssr: {
				resolve: {
					conditions: ['epicenter', ...defaultServerConditions],
				},
			},
		}),
	}),
);
