/**
 * Which build owns Local Mail's files and its secrets.
 *
 * Local Mail is the one application that opens named SQLite files and keeps
 * secrets, so it is the one application with a storage seam. The web build owns
 * an OPFS pool and tab memory; the build the desktop Epicenter host serves owns
 * Bun files and the OS keychain.
 *
 * The failure this guards is silent. Drop the `epicenter-host` leaf and
 * resolution falls back to `default`, so the host-served build would reach for
 * OPFS and tab memory instead of the Bun-owned files and the keychain, and
 * still build and still start. Nothing downstream would complain. These
 * assertions complain instead.
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
	test('every seam names a host leaf and a default leaf that exist', () => {
		for (const [specifier, conditions] of Object.entries(imports)) {
			expect({
				specifier,
				host: typeof conditions['epicenter-host'],
				fallback: typeof conditions.default,
			}).toEqual({ specifier, host: 'string', fallback: 'string' });
			for (const leaf of Object.values(conditions)) {
				expect({ leaf, exists: existsSync(join(appRoot, leaf)) }).toEqual({
					leaf,
					exists: true,
				});
			}
		}
	});

	test('each leaf reaches one runtime, not both', async () => {
		// A leaf that imported both subpaths would pull the OPFS worker into the
		// desktop bundle and the host transport into the web one, which is the
		// bundle cost the two packages exist to keep apart.
		for (const condition of ['default', 'epicenter-host']) {
			const source = await leafSource('#platform/app-storage', condition);
			expect({
				condition,
				browser: source.includes('@epicenter/app-storage/browser'),
				desktop: source.includes('@epicenter/app-storage/desktop'),
			}).toEqual({
				condition,
				browser: condition === 'default',
				desktop: condition === 'epicenter-host',
			});
		}
	});
});

describe('the runtime is the import path', () => {
	test('each build binds its files and its secrets to its own owner', async () => {
		// The package name never carries the runtime, so what a build gets is
		// decided by which subpath its leaf imports.
		expect(await leafSource('#platform/app-storage', 'default')).toContain(
			"from '@epicenter/app-storage/browser'",
		);
		expect(
			await leafSource('#platform/app-storage', 'epicenter-host'),
		).toContain("from '@epicenter/app-storage/desktop'");
	});

	test('each leaf reaches one runtime, not both', async () => {
		// A leaf that imported both subpaths would pull the OPFS worker into the
		// desktop bundle and the host transport into the web one, which is the
		// bundle cost the two packages exist to keep apart.
		for (const condition of ['default', 'epicenter-host']) {
			const source = await leafSource('#platform/app-storage', condition);
			expect({
				condition,
				browser: source.includes('@epicenter/app-storage/browser'),
				desktop: source.includes('@epicenter/app-storage/desktop'),
			}).toEqual({
				condition,
				browser: condition === 'default',
				desktop: condition === 'epicenter-host',
			});
		}
	});
});
