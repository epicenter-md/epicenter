/**
 * Which build gets which credential.
 *
 * Honeycrisp has three: the hosted web SPA, the standalone desktop bundle, and
 * the build the desktop Epicenter host serves. What separates them is auth,
 * whether there is a folder, and which runtime the capability handle is built
 * over. NOT their data: every build owns its own store and reaches the same
 * authority per account (ADR-0226), so there is no `#platform/application`
 * seam any more and nothing here asserts one.
 *
 * The failure this guards is silent. Drop the `epicenter-host` leaf from a seam
 * and resolution falls back to `default`, so the host-served build would go
 * looking for a credential only a browser can obtain, while still building and
 * still starting. Nothing downstream would complain. These assertions complain
 * instead.
 *
 * This reads declarations only, so it can say exactly which seam lost its host
 * leaf, in milliseconds.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = fileURLToPath(new URL('../..', import.meta.url));

const imports = (
	(await Bun.file(join(appRoot, 'package.json')).json()) as {
		imports: Record<string, Record<string, string>>;
	}
).imports;

async function leafSource(specifier: string, condition: string) {
	const leaf = imports[specifier]?.[condition];
	if (leaf === undefined) {
		throw new Error(`${specifier} declares no ${condition} leaf`);
	}
	return Bun.file(join(appRoot, leaf)).text();
}

describe('platform seams', () => {
	test('every seam names a host leaf and a default leaf', () => {
		for (const [specifier, conditions] of Object.entries(imports)) {
			expect({
				specifier,
				host: typeof conditions['epicenter-host'],
				fallback: typeof conditions.default,
			}).toEqual({ specifier, host: 'string', fallback: 'string' });
		}
	});

	test('every declared leaf is a file that exists', () => {
		for (const conditions of Object.values(imports)) {
			for (const leaf of Object.values(conditions)) {
				expect({ leaf, exists: existsSync(join(appRoot, leaf)) }).toEqual({
					leaf,
					exists: true,
				});
			}
		}
	});
});

describe('the folder is a build fact', () => {
	test('whether there is an Epicenter folder is decided at build time', async () => {
		// Not a runtime probe, and not a failure a person reads. A page has no
		// filesystem, so the browser build has no button rather than one that
		// always refuses (ADR-0337).
		expect(await leafSource('#platform/folder', 'default')).toContain(
			'openWorkingCopy: typeof createWorkingCopy | undefined = undefined',
		);
		expect(await leafSource('#platform/folder', 'epicenter-host')).toContain(
			'createWorkingCopy as openWorkingCopy',
		);
	});
});

describe('the runtime is the import path', () => {
	test('each build binds its files and its secrets to its own owner', async () => {
		// The name never carries the runtime (ADR-0339), so what a build gets is
		// decided by which subpath its leaf imports. Getting this wrong is the
		// silent failure this file exists for: the host-served build would reach
		// for OPFS and tab memory instead of the Bun-owned files and the
		// keychain, and still build and still start.
		expect(await leafSource('#platform/binding', 'default')).toContain(
			"from '@epicenter/app/browser'",
		);
		expect(await leafSource('#platform/binding', 'epicenter-host')).toContain(
			"from '@epicenter/app/desktop'",
		);
	});

	test('the seam holds the binding and nothing composed from it', async () => {
		// The whole point of this seam is that it holds only what varies. A leaf
		// that composed the handle would be the application's one `epicenter`
		// defined twice, and "there is exactly one" would rest on nobody
		// importing a leaf directly (ADR-0339).
		for (const condition of ['default', 'epicenter-host']) {
			const source = await leafSource('#platform/binding', condition);
			expect({
				condition,
				composes: source.includes('createEpicenter'),
			}).toEqual({ condition, composes: false });
		}
	});
});

describe('storage ownership', () => {
	test('data is not a platform seam at all', async () => {
		// The refusal, asserted so that re-adding the seam is a decision someone
		// makes rather than a file someone drops in. A host that owned its
		// windows' data would need a second authority, a second transport
		// topology, and an answer for what happens when it and Cloud disagree,
		// to make a convergence that already happens happen sooner.
		expect(Object.keys(imports)).not.toContain('#platform/application');
	});

	test('no seam selects an authority, and the host build reads the broker', async () => {
		// The deployment names the authority (ADR-0326), so there is nothing to
		// select at runtime and no `#platform/instance` to select it with.
		expect(Object.keys(imports)).not.toContain('#platform/instance');
		expect(await leafSource('#platform/auth', 'epicenter-host')).toContain(
			'createDesktopBrokerAuth',
		);
	});
});
