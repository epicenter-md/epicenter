/**
 * Ownership regression test: the background service worker owns no database.
 *
 * Lives under `lib/` rather than beside the entrypoint it inspects, because WXT
 * discovers every file in `src/entrypoints/` as an entrypoint: a
 * `background.test.ts` there is a second entrypoint named "background", and the
 * build refuses the collision.
 *
 * The open side panel document owns this origin's Epicenter replica, because it
 * owns the DedicatedWorker that holds the one exclusive Web Lock over the one
 * OPFS SQLite file (ADR-0165 as amended by ADR-0177). MV3 gives a background
 * service worker no production lifetime guarantee, so a replica owned there
 * would have its lock torn away at a moment nothing observes, and WXT's
 * `keepServiceWorkerAlive` is a development-only comfort.
 *
 * That invariant is invisible in a type: nothing stops someone from importing
 * the application into `background.ts` and having it compile. So it is asserted
 * over the module graph instead. The walk follows this app's own modules only;
 * reaching any forbidden specifier anywhere in that closure fails.
 */

/// <reference types="bun" />

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const APP_ROOT = resolve(import.meta.dir, '..', '..');
const LIB_ROOT = resolve(APP_ROOT, 'src', 'lib');
const ENTRYPOINTS = resolve(APP_ROOT, 'src', 'entrypoints');

/**
 * Specifiers that mean "this module can reach durable storage". The Data
 * package is the runtime; the two `$lib` modules are the only things that open
 * or bind a replica.
 */
const FORBIDDEN = [
	'@epicenter/data/legacy',
	'@epicenter/data/legacy/browser',
	'@epicenter/document-sync',
	'$lib/application',
	'$lib/application-platform',
	'$lib/workspace/browser',
];

const IMPORT_PATTERN =
	/(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g;
const BARE_IMPORT_PATTERN = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;

function readImports(file: string): string[] {
	const source = readFileSync(file, 'utf8');
	const specifiers: string[] = [];
	for (const pattern of [IMPORT_PATTERN, BARE_IMPORT_PATTERN]) {
		pattern.lastIndex = 0;
		let match = pattern.exec(source);
		while (match !== null) {
			if (match[1] !== undefined) specifiers.push(match[1]);
			match = pattern.exec(source);
		}
	}
	return specifiers;
}

/** Resolve an app-local specifier to a file on disk, or null if it is external. */
function resolveLocal(specifier: string, importer: string): string | null {
	const base = specifier.startsWith('$lib/')
		? resolve(LIB_ROOT, specifier.slice('$lib/'.length))
		: specifier.startsWith('.')
			? resolve(dirname(importer), specifier)
			: null;
	if (base === null) return null;
	const withoutJs = base.replace(/\.js$/, '');
	for (const candidate of [
		base,
		`${base}.ts`,
		`${base}.svelte.ts`,
		`${withoutJs}.ts`,
		`${withoutJs}.svelte.ts`,
		resolve(base, 'index.ts'),
	]) {
		try {
			readFileSync(candidate, 'utf8');
			return candidate;
		} catch {
			// Not this candidate; try the next extension.
		}
	}
	return null;
}

test('the background service worker cannot reach a replica', () => {
	const entry = resolve(ENTRYPOINTS, 'background.ts');
	const visited = new Set<string>();
	const queue = [entry];
	const violations: string[] = [];

	while (queue.length > 0) {
		const file = queue.pop();
		if (file === undefined || visited.has(file)) continue;
		visited.add(file);
		for (const specifier of readImports(file)) {
			if (FORBIDDEN.includes(specifier)) {
				violations.push(`${file} imports ${specifier}`);
				continue;
			}
			const local = resolveLocal(specifier, file);
			if (local !== null) queue.push(local);
		}
	}

	expect(violations).toEqual([]);
	// Guard the guard. The assertion above passes vacuously if the import parser
	// silently stops matching, so require that it still reads specifiers out of
	// the entrypoint it was pointed at.
	expect(readImports(entry).length).toBeGreaterThan(0);
});

test('the side panel root is what opens the replica', () => {
	// The counterpart to the test above: ownership has to live somewhere, and
	// this names where. If the acquisition moves, this fails and whoever moved it
	// has to say where ownership went.
	const root = resolve(ENTRYPOINTS, 'sidepanel', 'App.svelte');
	const source = readFileSync(root, 'utf8');
	expect(source).toContain('openTabManagerApplication');
	expect(source).toContain('$lib/application-platform');
});
