/**
 * The compiled surface catalog validates the Tauri ACL (ADR-0118).
 *
 * Rust cannot import the TypeScript catalog, so the capability files are
 * written by hand; these tests keep them honest: every window label comes from
 * the catalog, each development/production pair grants identical authority and
 * differs only by loopback origin, and no generic plugin family is granted.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SURFACE_ROUTES } from './routes.ts';

const CAPABILITIES_DIR = join(import.meta.dir, '..', 'src-tauri', 'capabilities');
const PAIRS = [
	'trusted-epicenter-apps',
	'trusted-whispering-native',
	'trusted-whispering-overlay',
] as const;
const DEVELOPMENT_ORIGIN = 'http://127.0.0.1:39131';
const PRODUCTION_ORIGIN = 'http://127.0.0.1:39130';
/** The one non-surface window: the Rust-owned recording overlay. */
const OVERLAY_WINDOW_LABEL = 'recording-overlay';

type Capability = {
	identifier: string;
	windows: string[];
	remote: { urls: string[] };
	permissions: string[];
};

const readCapability = (name: string): Capability =>
	JSON.parse(readFileSync(join(CAPABILITIES_DIR, `${name}.json`), 'utf8'));

describe('trusted-surface capabilities', () => {
	const knownWindows = [
		...Object.values(SURFACE_ROUTES).map((surface) => surface.windowLabel),
		OVERLAY_WINDOW_LABEL,
	];

	for (const pair of PAIRS) {
		test(`${pair} grants one authority across development and production`, () => {
			const development = readCapability(`${pair}-development`);
			const production = readCapability(`${pair}-production`);
			expect(development.permissions).toEqual(production.permissions);
			expect(development.windows).toEqual(production.windows);
			expect(development.remote.urls).toEqual([DEVELOPMENT_ORIGIN]);
			expect(production.remote.urls).toEqual([PRODUCTION_ORIGIN]);
		});

		test(`${pair} windows come from the surface catalog`, () => {
			for (const window of readCapability(`${pair}-development`).windows) {
				expect(knownWindows).toContain(window);
			}
		});

		test(`${pair} grants no generic plugin family`, () => {
			for (const permission of readCapability(`${pair}-development`)
				.permissions) {
				expect(permission).not.toMatch(/^(fs|http|shell|process|webview):/);
			}
		});
	}
});
