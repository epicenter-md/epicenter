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

const isEpicenterHost = process.env.EPICENTER_HOST === '1';

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
		// CommonJS entry to ESM for browser dev mode. `mergeConfig` concatenates
		// this with whatever the base config excludes.
		optimizeDeps: { exclude: ['onnxruntime-web', 'onnxruntime-web/wasm'] },
		resolve: {
			// Build-time platform DI over the `#platform/*` subpaths (package.json
			// "imports"). One condition, because one question is asked: which
			// leaves does the Bun host own (its replica, credential, deployment
			// choice, blob bytes, and asset base). The `.tauri.ts` leaves are
			// plain aliases in that map rather than condition arms, so nothing
			// ever resolved on a `tauri` condition (ADR-0347). The web build uses
			// `default` for every seam, so a host-only file imported by shared
			// code is unresolvable there and fails at vite build time rather than
			// at user runtime. The `...defaultClientConditions` spread is
			// load-bearing: custom conditions REPLACE Vite's defaults.
			...(isEpicenterHost && {
				conditions: ['epicenter-host', ...defaultClientConditions],
			}),
		},
	}),
);
