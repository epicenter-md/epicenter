/**
 * Every compiled application's Epicenter build opened the host-owned replica.
 *
 * This is the only check that runs the real build. The `#platform/*` seams are
 * declared in one file (package.json "imports"), activated in another
 * (vite.config.ts), and based in a third (svelte.config.js); reading any of them
 * proves nothing about what the other two did. Nothing downstream complains
 * either: drop the condition and every build still succeeds, every test still
 * passes, and the served application quietly opens its WebView's own storage,
 * writing notes and recordings where the host, Home, and sync cannot see them.
 *
 * So the assertion is against emitted bytes. A build that reached the host names
 * the desktop data route, and it ships no browser storage engine, because those
 * two leaves are mutually exclusive by construction. The browser control below
 * is what keeps the negative honest: it proves the absent markers are markers
 * this codebase really emits when the other leaf wins, rather than strings that
 * never appear anywhere.
 *
 * See also:
 * - `apps/honeycrisp/src/lib/platform-selection.test.ts` for the cheap
 *   structural guard (every seam still declares a host leaf) that fails with a
 *   precise message before this one fails with a diff
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DESKTOP_EPICENTER_ROUTE } from '@epicenter/data/legacy/desktop';
import { COMPILED_APPLICATIONS } from '../src/applications.ts';

const epicenterDir = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = join(epicenterDir, '..', '..');

/**
 * A browser-owned replica ships SQLite itself: the worker that runs it and the
 * WebAssembly build it loads, both named for the engine. A host-served build
 * cannot contain either, because it has no replica of its own to run.
 *
 * Deliberately narrower than "any `.wasm`". Whispering's Epicenter build ships
 * `vad/ort-wasm-simd-threaded.wasm` for voice activity detection, which is a
 * first-party capability of the surface and says nothing about who owns its
 * data.
 */
const BROWSER_STORAGE_ASSET = /sqlite3/i;

const BUILD_TIMEOUT_MS = 180_000;

async function run(script: string, cwd: string): Promise<void> {
	const built = Bun.spawn(['bun', 'run', script], {
		cwd,
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [status, stderr] = await Promise.all([
		built.exited,
		new Response(built.stderr).text(),
	]);
	if (status !== 0) {
		throw new Error(`\`bun run ${script}\` in ${cwd} failed:\n${stderr}`);
	}
}

function filesUnder(root: string): string[] {
	const found: string[] = [];
	const walk = (directory: string) => {
		for (const entry of readdirSync(directory)) {
			const path = join(directory, entry);
			if (statSync(path).isDirectory()) walk(path);
			else found.push(path);
		}
	};
	walk(root);
	return found;
}

async function anyFileContains(
	paths: readonly string[],
	needle: string,
): Promise<boolean> {
	for (const path of paths) {
		if (!path.endsWith('.js')) continue;
		if ((await Bun.file(path).text()).includes(needle)) return true;
	}
	return false;
}

describe('compiled application builds', () => {
	for (const application of COMPILED_APPLICATIONS) {
		test(
			`${application.title} reaches the host-owned replica, not its own`,
			async () => {
				// Through Epicenter's own script, so a declared application with no
				// build script fails here rather than at a user's next launch.
				await run(`build:${application.id}`, epicenterDir);

				const distRoot = join(epicenterDir, 'dist', application.id);
				const emitted = filesUnder(distRoot);

				expect(await anyFileContains(emitted, DESKTOP_EPICENTER_ROUTE)).toBe(
					true,
				);

				expect(
					emitted
						.filter((path) => BROWSER_STORAGE_ASSET.test(path))
						.map((path) => relative(distRoot, path)),
				).toEqual([]);

				// Served below `/apps/<id>/`, so its own document says so.
				const page = await Bun.file(join(distRoot, 'index.html')).text();
				expect(page).toContain(`/apps/${application.id}/`);
			},
			BUILD_TIMEOUT_MS,
		);
	}

	test(
		'the control: Honeycrisp built for a browser does the opposite',
		async () => {
			const honeycrispDir = join(repoRoot, 'apps', 'honeycrisp');
			await run('build', honeycrispDir);
			const emitted = filesUnder(join(honeycrispDir, 'build'));

			expect(await anyFileContains(emitted, DESKTOP_EPICENTER_ROUTE)).toBe(
				false,
			);
			expect(emitted.some((path) => BROWSER_STORAGE_ASSET.test(path))).toBe(
				true,
			);
		},
		BUILD_TIMEOUT_MS,
	);
});
