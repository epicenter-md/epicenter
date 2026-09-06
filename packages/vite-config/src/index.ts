import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { searchForWorkspaceRoot, type UserConfig } from 'vite';

/**
 * Base Vite config for SvelteKit workspace apps whose package contract and
 * browser composition live at the app root, outside `src/`.
 *
 * The `fs.allow` entry is load-bearing, but not because of Vite's own
 * default. @sveltejs/kit's plugin sets fs.allow to the app `src/`, the app and
 * workspace-root `node_modules`, and its own output, and nothing else. That
 * omits the monorepo root, so the app-root composition files (the package
 * contract and browser entry that live outside `src/`) and sibling-package
 * source are unreadable in dev. Adding the workspace root restores both; Vite
 * concatenates it with SvelteKit's entries rather than replacing them. It is
 * also what lets a worker declared inside a workspace package load at all: its
 * `new URL('./x.worker.ts', import.meta.url)` resolves to a `/@fs/` URL under
 * the monorepo root, which SvelteKit's list answers 403 to.
 *
 * **The last three are what `@epicenter/app`'s browser leaf costs**, and they
 * are here rather than in each app because every workspace app composes that
 * leaf and none of them chose this. Its SQLite owner is a dedicated worker over
 * `@sqlite.org/sqlite-wasm`, because OPFS synchronous access handles exist only
 * in a worker context, so:
 *
 * - `optimizeDeps.exclude` keeps the package unbundled. It resolves
 *   `sqlite3.wasm` relative to its own module URL, and pre-bundling rewrites
 *   that URL into `.vite/deps/`, where no `.wasm` was copied. The fetch then
 *   falls through to the SPA fallback and the module aborts on a `text/html`
 *   response.
 * - `worker.format` makes the worker chunk ES output, which it has to be to
 *   carry that package at all.
 * - `build.target` admits the syntax that chunk uses, top-level `await`
 *   included.
 *
 * An app that needs more exclusions adds them; `mergeConfig` concatenates the
 * arrays rather than replacing them.
 */
export function workspaceAppViteConfig(app: { port: number }): UserConfig {
	return {
		// Bun can split `vite` into peer-variant installs (`vite@7.3.5+<hashA>`
		// vs `+<hashB>`), which makes identical `Plugin` types compare unequal
		// across app configs. Keep the cast here, the one place every workspace
		// app's plugins come from, instead of leaking the workaround into each app.
		plugins: [sveltekit(), tailwindcss()] as UserConfig['plugins'],
		// One CRDT instance per app, or two documents that cannot see each
		// other's updates and say nothing about it. This named `yjs` until the
		// store moved to `@y/y`, after which it deduped a package no workspace
		// member depends on; a typecheck cannot see either mistake.
		resolve: { dedupe: ['@y/y'] },
		server: {
			port: app.port,
			strictPort: true,
			fs: { allow: [searchForWorkspaceRoot(process.cwd())] },
		},
		optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
		worker: { format: 'es' },
		build: { target: 'esnext' },
	};
}
