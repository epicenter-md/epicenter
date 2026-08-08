/**
 * Which build opens which store.
 *
 * Honeycrisp has three: the hosted web SPA, the standalone desktop bundle, and
 * the build the desktop Epicenter host serves. The first two own their storage
 * and their credential.
 *
 * **The third borrowed the host's replica and no longer does.** Moving to the
 * new store cost that, and the loss is pinned below rather than left to be
 * discovered: the host-served build now opens its own OPFS, so its notes are
 * not in the `epicenter.sqlite3` other trusted surfaces read. What restores it
 * is the shape ADR-0222 already describes, the window as a REPLICA of the
 * host's store over the same transport the cloud uses, which needs an authority
 * endpoint the host does not serve yet. Standing up a second storage
 * arrangement in the meantime would be a path to delete rather than a step
 * toward that one.
 *
 * The rest of the failure this guards is still silent. Drop the
 * `epicenter-host` leaf from a seam and resolution falls back to `default`,
 * while still building and still starting, and nothing downstream would
 * complain. These assertions complain instead.
 *
 * This is the cheap structural half: it reads declarations, so it can say
 * exactly which seam lost its host leaf, in milliseconds. What it cannot do is
 * prove the build honored them. That is
 * `apps/epicenter/scripts/build-applications.test.ts`, which runs the real build
 * and reads the emitted bytes.
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
	test('every build opens its own browser-owned store, for now', async () => {
		// Both leaves, asserted together, because they currently agree and the
		// point of writing it this way is that the day one of them stops
		// agreeing is the day the host grew an authority and this test should be
		// rewritten rather than quietly satisfied.
		for (const condition of ['epicenter-host', 'default']) {
			const source = await leafSource('#platform/application', condition);
			expect({ condition, opens: source.includes('openBrowserStore') }).toEqual({
				condition,
				opens: true,
			});
		}
	});

	test('nothing reaches for the superseded stack', async () => {
		// The regression that would be invisible: a leaf that still opened an
		// `Epicenter` would compile, start, and keep notes in a replica the rest
		// of this application no longer reads.
		for (const condition of ['epicenter-host', 'default']) {
			const source = await leafSource('#platform/application', condition);
			expect({
				condition,
				stale:
					source.includes('openDesktopEpicenter') ||
					source.includes('openBrowserEpicenter'),
			}).toEqual({ condition, stale: false });
		}
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
