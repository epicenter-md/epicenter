import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '../src/config.ts';
import type { TokenStore } from '../src/token-store.ts';
import type { TokenSet } from '../src/tokens.ts';

// The credential resolver (ADR-0108) reads the Intuit keyset from the environment
// by its environment-qualified name. Every test drives the sandbox mock server, so
// seed the sandbox keyset once here for any test that exercises the OAuth/refresh
// path. `??=` leaves a real environment untouched. The values are placeholders:
// the mock QB server never checks them.
process.env.QB_SANDBOX_CLIENT_ID ??= 'test-client';
process.env.QB_SANDBOX_CLIENT_SECRET ??= 'test-secret';

/** Process-lifetime in-memory token store, for tests. Holds the typed set, no codec. */
export function createMemoryTokenStore(): TokenStore {
	const map = new Map<string, TokenSet>();
	return {
		async get(realmId) {
			return map.get(realmId) ?? null;
		},
		async listRealms() {
			return [...map.keys()].sort();
		},
		async set(token) {
			map.set(token.realmId, token);
		},
	};
}

/** A full AppConfig with test defaults; override per test. Bypasses env/file. */
export function makeConfig(over: Partial<AppConfig> = {}): AppConfig {
	return {
		dataDir: '/tmp/local-books-test',
		environment: 'sandbox',
		redirectUri: 'http://localhost:8765/callback',
		scopes: ['com.intuit.quickbooks.accounting'],
		entities: ['Invoice'],
		apiBase: 'http://localhost:0',
		tokenUrl: 'http://localhost:0/oauth2/v1/tokens/bearer',
		authorizeUrl: 'https://appcenter.intuit.com/connect/oauth2',
		minorVersion: '70',
		cdcSafeWindowDays: 25,
		fullBackstopDays: 7,
		pageSize: 1000,
		credentialsPath: '/tmp/local-books-test/credentials.json',
		realmOverride: null,
		callbackPort: null,
		readOnly: false,
		...over,
	};
}

export const sampleGrant = {
	token_type: 'bearer',
	access_token: 'access-seed',
	refresh_token: 'refresh-seed',
	expires_in: 3600,
	x_refresh_token_expires_in: 8726400,
};

/** Make a throwaway temp directory and return it plus a cleanup fn. */
export function tempDir(): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), 'local-books-'));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * A throwaway Epicenter root and the Local Books directory below it. Tests that
 * drive the binary pass `EPICENTER_DATA_DIR: root`, which is the only override
 * there is now that no app computes an application-data path of its own
 * (ADR-0201), and seed fixtures at `appDir` because that is where the app looks.
 */
export function tempRoot(): {
	root: string;
	appDir: string;
	cleanup: () => void;
} {
	const { dir, cleanup } = tempDir();
	return { root: dir, appDir: join(dir, 'apps', 'local-books'), cleanup };
}
