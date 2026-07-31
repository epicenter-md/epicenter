/**
 * Which build opens which replica.
 *
 * Honeycrisp has three: the hosted web SPA, the standalone desktop bundle, and
 * the build the desktop Epicenter host serves. The first two own their storage
 * and their credential; the third borrows both from the host.
 *
 * The failure this guards is silent. Drop the `epicenter-host` leaf from a seam
 * and resolution falls back to `default`, so the host-served build would open
 * its WebView's own OPFS and keep notes somewhere nobody else can read, while
 * still building and still starting. Nothing downstream would complain. These
 * assertions complain instead.
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

describe('storage ownership', () => {
	test('the host-served build opens the host-owned replica', async () => {
		const source = await leafSource('#platform/application', 'epicenter-host');
		expect(source).toContain('openDesktopEpicenter');
		expect(source).not.toContain('openHoneycrispBrowserEpicenter');
	});

	test('every other build opens its own browser-owned replica', async () => {
		const source = await leafSource('#platform/application', 'default');
		expect(source).toContain('openHoneycrispBrowserEpicenter');
		expect(source).not.toContain('openDesktopEpicenter');
	});

	test('the host owns the deployment choice its build reads', async () => {
		expect(await leafSource('#platform/instance', 'epicenter-host')).toContain(
			'createDesktopInstanceSetting',
		);
		expect(await leafSource('#platform/auth', 'epicenter-host')).toContain(
			'createDesktopBrokerAuth',
		);
	});
});
