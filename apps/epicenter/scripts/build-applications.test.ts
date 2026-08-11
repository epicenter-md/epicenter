/**
 * Where each compiled application's Epicenter build actually keeps its data.
 *
 * This is the only check that runs the real build, and it asserts against
 * emitted bytes rather than declarations. The `#platform/*` seams are declared
 * in one file (package.json "imports"), activated in another (vite.config.ts),
 * and based in a third (svelte.config.js); reading any of them proves nothing
 * about what the other two did, and nothing downstream complains when they
 * disagree.
 *
 * **The expected answer flipped, per application.** It used to be that every
 * served build reached the host-owned replica and shipped no browser storage
 * engine. ADR-0226 refused that: a host serves bundles and brokers credentials
 * and owns no application data. So for an application that has moved, reaching
 * the host is now the regression; for one still on the superseded stack it is
 * still correct, and {@link STILL_ON_THE_HOST_REPLICA} is the list of those,
 * which is expected to shrink to empty.
 *
 * The marker this looks for has to be one this codebase really emits when a
 * build does reach the host, or "absent" would prove nothing. Whispering is
 * currently that positive case; when it moves, something else has to keep the
 * negative honest.
 *
 * See also:
 * - `apps/honeycrisp/src/lib/platform-selection.test.ts` for the cheap
 *   structural guard that fails with a precise message before this one fails
 *   with a diff
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

/**
 * The route a served build used to reach the host-owned replica through.
 *
 * A literal rather than an import, because the module that exported it is
 * deleted along with the route, the owner behind it, and the last application
 * that dialled it. The string stays because the assertion is about EMITTED
 * BYTES: a bundle that starts talking to `/api/data` again has reintroduced a
 * host-owned data plane, and this is the test that says so.
 */
const HOST_REPLICA_ROUTE = '/api/data';

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
			`${application.title} stores where ADR-0226 says, and is served below its id`,
			async () => {
				// Through Epicenter's own script, so a declared application with no
				// build script fails here rather than at a user's next launch.
				await run(`build:${application.id}`, epicenterDir);

				const distRoot = join(epicenterDir, 'dist', application.id);
				const emitted = filesUnder(distRoot);

				// This used to assert, for every application, that the emitted bytes
				// reached the host-owned replica and carried no browser storage.
				// ADR-0226 refused that, and the exemption list this test carried
				// (`whispering`, the last build still on the host) is now empty:
				// every application owns its own store.
				expect({
					id: application.id,
					reachesHost: await anyFileContains(emitted, HOST_REPLICA_ROUTE),
				}).toEqual({ id: application.id, reachesHost: false });

				// The positive half: "does not reach the host" and "has a store at
				// all" are different claims, and asserting only the first would pass
				// on a build with no data layer whatsoever.
				expect(emitted.some((path) => BROWSER_STORAGE_ASSET.test(path))).toBe(
					true,
				);

				// Served below `/apps/<id>/`, so its own document says so.
				const page = await Bun.file(join(distRoot, 'index.html')).text();
				expect(page).toContain(`/apps/${application.id}/`);
			},
			BUILD_TIMEOUT_MS,
		);
	}

	test(
		'the standalone browser build is now identical in this respect',
		async () => {
			// This was "the control: Honeycrisp built for a browser does the
			// opposite", and it is not a control any more. It asserted that the two
			// builds DIFFERED in where their data lived, and ADR-0226 removed the
			// difference: a host serves bundles and owns no application data, so
			// every build owns its own store.
			//
			// Kept, and kept adjacent, because the pair is still worth asserting
			// TOGETHER. The day these two stop agreeing is the day someone
			// reintroduced a host-owned data plane, and that should be a decision
			// with a failing test attached rather than a quiet divergence.
			const honeycrispDir = join(repoRoot, 'apps', 'honeycrisp');
			await run('build', honeycrispDir);
			const emitted = filesUnder(join(honeycrispDir, 'build'));

			expect(await anyFileContains(emitted, HOST_REPLICA_ROUTE)).toBe(false);
			expect(emitted.some((path) => BROWSER_STORAGE_ASSET.test(path))).toBe(
				true,
			);
		},
		BUILD_TIMEOUT_MS,
	);
});
