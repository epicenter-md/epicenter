/**
 * Every compiled application's Epicenter build reached the host's data plane
 * rather than one of its own.
 *
 * This is the only check that runs the real build. The `#platform/*` seams are
 * declared in one file (package.json "imports"), activated in another
 * (vite.config.ts), and based in a third (svelte.config.js); reading any of them
 * proves nothing about what the other two did. Nothing downstream complains
 * either: drop the condition and every build still succeeds, every test still
 * passes, and the served application quietly talks to its standalone self,
 * writing notes and recordings where the host, Home, and sync cannot see them.
 *
 * So the assertion is against emitted bytes. Which bytes depends on which data
 * plane the application actually has, and there are two (ADR-0191). Whispering
 * and Honeycrisp own a replica, so a build that reached the host names the
 * desktop data route and ships no browser storage engine. Mail owns no replica
 * at all: its data is a device-local SQLite mirror of Gmail behind the surface
 * the host mounts, so its build names that mount and carries none of the
 * standalone host's injected bearer global.
 *
 * Both cases assert the same thing, so {@link HOST_DATA_PROOFS} states it once
 * per application: one marker the host-served build must emit, one marker that
 * only the other leaf emits and this build therefore must not. A newly declared
 * compiled application with no entry fails here, which is the point: "how does
 * this application get its data" is not a question a release should ship
 * unanswered.
 *
 * The browser control below is what keeps the negatives honest: it proves the
 * absent markers are markers this codebase really emits when the other leaf
 * wins, rather than strings that never appear anywhere.
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
import { DESKTOP_EPICENTER_ROUTE } from '@epicenter/data/desktop';
import { COMPILED_APPLICATIONS } from '../src/applications.ts';
import { MAIL_API_PREFIX } from '../src/routes.ts';

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
 * The standalone Local Mail host hands its SPA a per-launch bearer through an
 * injected `window.__LOCAL_MAIL__` global. The Epicenter build rides the host's
 * session instead and mints nothing, so this global appearing in `dist/mail`
 * means the standalone leaf won and the surface is talking to the wrong host.
 */
const STANDALONE_MAIL_BEARER = '__LOCAL_MAIL__';

/**
 * What each compiled application's host build must, and must not, contain.
 *
 * `reaches` is emitted only by the host leaf; `insteadOf` only by the leaf that
 * would win if the seam broke. A path pattern catches a shipped asset, a source
 * needle catches emitted JavaScript.
 */
const HOST_DATA_PROOFS: Record<
	string,
	{
		reaches: string;
		insteadOf: { assetPath?: RegExp; sourceNeedle?: string };
	}
> = {
	whispering: {
		reaches: DESKTOP_EPICENTER_ROUTE,
		insteadOf: { assetPath: BROWSER_STORAGE_ASSET },
	},
	honeycrisp: {
		reaches: DESKTOP_EPICENTER_ROUTE,
		insteadOf: { assetPath: BROWSER_STORAGE_ASSET },
	},
	mail: {
		reaches: MAIL_API_PREFIX,
		insteadOf: { sourceNeedle: STANDALONE_MAIL_BEARER },
	},
};

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
			`${application.title} reaches the host's data plane, not its own`,
			async () => {
				const proof = HOST_DATA_PROOFS[application.id];
				if (!proof) {
					throw new Error(
						`Compiled application "${application.id}" declares no host-data proof. Add one to HOST_DATA_PROOFS naming what its Epicenter build must reach, and what reaching it rules out.`,
					);
				}

				// Through Epicenter's own script, so a declared application with no
				// build script fails here rather than at a user's next launch.
				await run(`build:${application.id}`, epicenterDir);

				const distRoot = join(epicenterDir, 'dist', application.id);
				const emitted = filesUnder(distRoot);

				expect(await anyFileContains(emitted, proof.reaches)).toBe(true);

				if (proof.insteadOf.assetPath) {
					const pattern = proof.insteadOf.assetPath;
					expect(
						emitted
							.filter((path) => pattern.test(path))
							.map((path) => relative(distRoot, path)),
					).toEqual([]);
				}
				if (proof.insteadOf.sourceNeedle) {
					expect(
						await anyFileContains(emitted, proof.insteadOf.sourceNeedle),
					).toBe(false);
				}

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

	test(
		'the control: Mail built for its standalone host does the opposite',
		async () => {
			const mailUiDir = join(repoRoot, 'apps', 'local-mail', 'ui');
			await run('build', mailUiDir);
			const emitted = filesUnder(join(mailUiDir, 'dist'));

			expect(await anyFileContains(emitted, MAIL_API_PREFIX)).toBe(false);
			expect(await anyFileContains(emitted, STANDALONE_MAIL_BEARER)).toBe(true);
		},
		BUILD_TIMEOUT_MS,
	);
});
