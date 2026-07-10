/**
 * Hosted SPA identity tests.
 *
 * Whispering is one SPA with browser and Epicenter build environments. It keeps
 * its application routes and platform adapters, while Epicenter owns the native
 * desktop identity.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	normalizeWhisperingPath,
	whisperingPath,
} from '../src/lib/constants/urls';

const ROOT = join(import.meta.dir, '..');
const REPO_ROOT = join(ROOT, '..', '..');
const read = (name: string) => readFileSync(join(ROOT, name), 'utf8');

describe('Epicenter-hosted Whispering identity', () => {
	test('the canonical package is the independently hostable SPA', () => {
		expect(JSON.parse(read('package.json')).name).toBe('@epicenter/whispering');
		expect(existsSync(join(ROOT, 'src-tauri'))).toBe(false);
		expect(existsSync(join(REPO_ROOT, 'apps/epicenter/whispering'))).toBe(
			false,
		);
		expect(existsSync(join(REPO_ROOT, 'apps/epicenter/src-tauri'))).toBe(true);
	});

	test('the browser and Epicenter builds own distinct base paths and outputs', () => {
		const config = read('svelte.config.js');
		const vite = read('vite.config.ts');
		expect(config).toContain("pages: '../epicenter/dist/whispering'");
		expect(config).toContain("paths: { base: '/apps/whispering' }");
		expect(vite).toContain("process.env.EPICENTER_SURFACE === '1'");
		expect(vite).not.toContain('TAURI_ENV_PLATFORM');
		expect(vite).not.toContain('TAURI_DEV_HOST');
		expect(read('src/lib/platform/base-path.browser.ts')).toContain(
			"WHISPERING_BASE_PATHNAME = ''",
		);
		expect(read('src/lib/platform/base-path.tauri.ts')).toContain(
			"WHISPERING_BASE_PATHNAME = '/apps/whispering'",
		);
		expect(whisperingPath('/')).toBe('/');
		expect(whisperingPath('/recording-overlay')).toBe('/recording-overlay');
		expect(normalizeWhisperingPath('/settings')).toBe('/settings');
	});

	test('the canonical SPA no longer documents the retired native identifier', () => {
		expect(read('src/lib/services/fs-paths.ts')).not.toContain(
			'so.epicenter.whispering',
		);
		expect(read('src/lib/services/fs-paths.ts')).toContain('so.epicenter');
	});

	test('OAuth callbacks use the unified Epicenter deep-link scheme', () => {
		const auth = read('src/lib/platform/auth.tauri.ts');
		expect(auth).toContain('EPICENTER_DESKTOP_OAUTH_CLIENT_ID');
		expect(auth).toContain('EPICENTER_DESKTOP_TAURI_OAUTH_REDIRECT_URI');
		expect(auth).not.toContain('EPICENTER_WHISPERING_TAURI_OAUTH_REDIRECT_URI');
	});
});
