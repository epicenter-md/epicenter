/**
 * Web runtime: every Tauri capability is absent. The named `tauri` export
 * matches the shared platform check from `./tauri.tauri.ts` but is always
 * `null`. The Tauri impl is never resolved on web (the `tauri` condition is
 * inactive), so `@tauri-apps/*` stays out of the browser bundle.
 *
 * The `Tauri` type is re-exported (type-only, erased at build) so consumers
 * that `import type { Tauri } from '#platform/tauri'` resolve it under both
 * the web (`default`) and Tauri conditions.
 *
 * `tauriOnly` is intentionally absent: it is for `*.tauri.ts` files, which
 * import it directly from `./tauri.tauri`. Shared or web code reaching for it
 * fails the build instead of shipping a runtime assertion.
 */
import type { Tauri } from './tauri.types';

export type { Tauri };

// Invariant: if this web seam loaded, we are not in a Tauri runtime. A
// violation means the build resolved the `default` (web) condition instead of
// `tauri`, so `@tauri-apps/*` is missing from the bundle even though the
// runtime supports it, and the app silently masquerades as the web app. The
// cause is that Epicenter served browser-built assets instead of the output of
// `build:epicenter`. Read the raw
// `__TAURI_INTERNALS__` marker rather than `isTauri()` from `@tauri-apps/api`,
// which would pull Tauri into the web bundle; `typeof window` keeps it inert
// during SSR.
if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
	throw new Error(
		'Whispering loaded its browser build inside Epicenter: the `tauri` Vite condition was not applied, so native capabilities are missing from the bundle. Rebuild the Epicenter assets and relaunch with `bun dev:epicenter` from the repository root.',
	);
}

export const tauri: Tauri | null = null;
