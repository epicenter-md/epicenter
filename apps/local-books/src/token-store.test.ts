import { describe, expect, test } from 'bun:test';
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './config.ts';
import { credentialsFilePath } from './paths.ts';
import {
	createFileTokenStore,
	resolveRealm,
	type TokenStore,
} from './token-store.ts';
import type { TokenSet } from './tokens.ts';

function tempDir(): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), 'local-books-token-store-'));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const token: TokenSet = {
	realmId: 'realm-1',
	environment: 'sandbox',
	accessToken: 'access-1',
	refreshToken: 'refresh-1',
	accessTokenExpiresAt: '2026-02-01T01:00:00.000Z',
	refreshTokenExpiresAt: '2026-05-12T00:00:00.000Z',
	obtainedAt: '2026-02-01T00:00:00.000Z',
};

describe('createFileTokenStore', () => {
	test('writes a 0600 file and round-trips a token set', async () => {
		const { dir, cleanup } = tempDir();
		try {
			const file = join(dir, 'credentials.json');
			const store = createFileTokenStore(file);

			expect(await store.get('realm-1')).toBeNull();
			await store.set(token);
			expect(readFileSync(file, 'utf8')).toContain('access-1');
			expect(statSync(file).mode & 0o777).toBe(0o600);
			expect(await store.get('realm-1')).toEqual(token);
		} finally {
			cleanup();
		}
	});

	test('treats a malformed on-disk entry as absent', async () => {
		const { dir, cleanup } = tempDir();
		try {
			// A token entry missing required fields must not deserialize to a partial
			// TokenSet: the untrusted-disk boundary validates and reports "no token".
			const file = join(dir, 'credentials.json');
			writeFileSync(
				file,
				JSON.stringify({ 'realm-1': JSON.stringify({ realmId: 'realm-1' }) }),
			);
			expect(await createFileTokenStore(file).get('realm-1')).toBeNull();
		} finally {
			cleanup();
		}
	});

	test('listRealms is the connected-company index, and skips malformed entries', async () => {
		const { dir, cleanup } = tempDir();
		try {
			const file = join(dir, 'credentials.json');
			const store = createFileTokenStore(file);
			expect(await store.listRealms()).toEqual([]);

			await store.set(token);
			await store.set({ ...token, realmId: 'realm-0' });
			expect(await store.listRealms()).toEqual(['realm-0', 'realm-1']);

			// A partial entry is absent to `get`, so it must be absent here too, or
			// `resolveRealm` would offer a company no verb can use.
			const map = JSON.parse(readFileSync(file, 'utf8'));
			map['realm-2'] = JSON.stringify({ realmId: 'realm-2' });
			writeFileSync(file, JSON.stringify(map));
			expect(await store.listRealms()).toEqual(['realm-0', 'realm-1']);
		} finally {
			cleanup();
		}
	});
});

describe('resolveRealm', () => {
	function storeWith(realms: string[]): TokenStore {
		return {
			async get(realmId) {
				return realms.includes(realmId) ? { ...token, realmId } : null;
			},
			async listRealms() {
				return [...realms].sort();
			},
			async set() {},
		};
	}

	test('uses the sole connected company', async () => {
		const { data, error } = await resolveRealm(
			{ realmOverride: null },
			storeWith(['realm-1']),
		);
		expect(error).toBeNull();
		expect(data).toBe('realm-1');
	});

	test('asks for --realm when more than one is connected', async () => {
		const { error } = await resolveRealm(
			{ realmOverride: null },
			storeWith(['realm-1', 'realm-2']),
		);
		expect(error).toContain('--realm');
	});

	test('says to run auth when none is connected', async () => {
		const { error } = await resolveRealm(
			{ realmOverride: null },
			storeWith([]),
		);
		expect(error).toContain('local-books auth');
	});

	test('takes an override at its word, so a mirror without a token stays readable', async () => {
		// `demo` builds a company that never authenticates, and the read verbs work
		// without a token, so an override is not checked against the store.
		const { data, error } = await resolveRealm(
			{ realmOverride: 'realm-9' },
			storeWith([]),
		);
		expect(error).toBeNull();
		expect(data).toBe('realm-9');
	});
});

describe('credentials path resolution', () => {
	const FILE = 'LOCAL_BOOKS_TOKEN_FILE';
	const ROOT = 'EPICENTER_DATA_DIR';

	/** Run `fn` with `LOCAL_BOOKS_TOKEN_FILE` set to `file`, restored after. */
	function withFileEnv(file: string | undefined, fn: () => void): void {
		const prev = process.env[FILE];
		if (file === undefined) delete process.env[FILE];
		else process.env[FILE] = file;
		try {
			fn();
		} finally {
			if (prev === undefined) delete process.env[FILE];
			else process.env[FILE] = prev;
		}
	}

	test('defaults to a file at the app directory root, below the one Epicenter root', () => {
		const prevRoot = process.env[ROOT];
		process.env[ROOT] = '/tmp/lb-resolve';
		try {
			withFileEnv(undefined, () => {
				const config = loadConfig();
				expect(config.dataDir).toBe('/tmp/lb-resolve/apps/local-books');
				expect(config.credentialsPath).toBe(
					credentialsFilePath('/tmp/lb-resolve/apps/local-books'),
				);
			});
		} finally {
			if (prevRoot === undefined) delete process.env[ROOT];
			else process.env[ROOT] = prevRoot;
		}
	});

	test('an explicit LOCAL_BOOKS_TOKEN_FILE wins', () => {
		withFileEnv('/custom/creds.json', () => {
			expect(loadConfig().credentialsPath).toBe('/custom/creds.json');
		});
	});
});
