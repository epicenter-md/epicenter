/**
 * Hosted SPA identity tests.
 *
 * Whispering is one SPA with browser and Epicenter build environments. It keeps
 * its app routes and platform adapters, while Epicenter owns the native
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
		expect(read('src/lib/platform/base-path.epicenter-host.ts')).toContain(
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

	test('desktop auth uses the Bun authority instead of a window OAuth launcher', () => {
		const auth = read('src/lib/platform/auth.epicenter-host.ts');
		const bootstrap = read(
			'src/lib/platform/desktop-auth-bootstrap.epicenter-host.ts',
		);
		const instance = read('src/lib/platform/instance.epicenter-host.ts');
		expect(auth).toContain('createDesktopBrokerAuth');
		// The element and its removal are `@epicenter/auth/desktop`'s, shared with
		// every other compiled application; this build only reads the snapshot.
		expect(bootstrap).toContain('readDesktopAuthBootstrap');
		expect(instance).toContain('createDesktopInstanceSetting');
		expect(instance).not.toContain('createInstanceSetting');
		expect(auth).not.toContain('createHostedDeepLinkAuth');
		expect(auth).not.toContain('keyring');
	});
});
