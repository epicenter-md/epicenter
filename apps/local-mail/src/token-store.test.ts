/**
 * `get` validates disk bytes against `TokenSetSchema` and returns `null` on a
 * mismatch (token-store.ts). That's a trap for any writer that doesn't itself
 * respect the schema: `bin.ts`'s `seed-token` once wrote `accessToken: ''`,
 * which silently failed `TokenSetSchema`'s `minLength: 1` on the very next
 * `get`, so `sync` reported "no token stored" right after `seed-token` had
 * just written one. This test locks the round-trip, not just the schema.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AppConfig } from './config.ts';
import { createFileTokenStore, resolveAccount } from './token-store.ts';
import type { TokenSet } from './tokens.ts';

function tempTokenFile() {
	const dir = mkdtempSync(join(tmpdir(), 'local-mail-token-store-test-'));
	return {
		path: join(dir, 'credentials.json'),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

function mode(path: string): number {
	return statSync(path).mode & 0o777;
}

function token(accountEmail: string): TokenSet {
	return {
		accountEmail,
		clientIdUsed: 'test-client',
		accessToken: 'access-token',
		accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
		refreshToken: 'refresh-token',
		obtainedAt: new Date(0).toISOString(),
	};
}

function config(account: string | null): AppConfig {
	return {
		dataDir: '/tmp/local-mail-test',
		apiBase: 'https://gmail.googleapis.com',
		authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
		tokenUrl: 'https://oauth2.googleapis.com/token',
		historySafeWindowDays: 5,
		fullBackstopDays: 30,
		pageSize: 100,
		credentialsPath: '/tmp/local-mail-test/credentials.json',
		account,
		readOnly: false,
	};
}

describe('token sets round-trip through the real store', () => {
	test('a token with epoch timestamps (already expired) survives set-then-get', async () => {
		const { path, cleanup } = tempTokenFile();
		const store = createFileTokenStore(path);
		const seeded: TokenSet = {
			accountEmail: 'you@example.com',
			clientIdUsed: 'test-client',
			accessToken: 'an-expired-access-token',
			accessTokenExpiresAt: new Date(0).toISOString(),
			refreshToken: 'a-real-refresh-token',
			obtainedAt: new Date(0).toISOString(),
		};

		await store.set(seeded);
		const read = await store.get('you@example.com');

		expect(read).not.toBeNull();
		expect(read?.refreshToken).toBe('a-real-refresh-token');
		expect(mode(dirname(path))).toBe(0o700);
		expect(mode(path)).toBe(0o600);
		cleanup();
	});

	test('an empty accessToken (the actual regression) fails TokenSetSchema and get() returns null', async () => {
		const { path, cleanup } = tempTokenFile();
		const store = createFileTokenStore(path);
		// Bypass the TokenSet type to prove the schema, not just TypeScript,
		// is what would have caught this.
		await store.set({
			accountEmail: 'you@example.com',
			clientIdUsed: 'test-client',
			accessToken: '',
			accessTokenExpiresAt: new Date(0).toISOString(),
			refreshToken: 'a-real-refresh-token',
			obtainedAt: new Date(0).toISOString(),
		} as TokenSet);

		expect(await store.get('you@example.com')).toBeNull();
		cleanup();
	});
});

describe('account resolution from the token store', () => {
	test('resolveAccount uses the sole stored account when LOCAL_MAIL_ACCOUNT is unset', async () => {
		const { path, cleanup } = tempTokenFile();
		const store = createFileTokenStore(path);
		await store.set(token('you@example.com'));

		const { data, error } = await resolveAccount(config(null), store);

		expect(error).toBeNull();
		expect(data).toBe('you@example.com');
		cleanup();
	});

	test('resolveAccount asks for LOCAL_MAIL_ACCOUNT when multiple accounts are stored', async () => {
		const { path, cleanup } = tempTokenFile();
		const store = createFileTokenStore(path);
		await store.set(token('a@example.com'));
		await store.set(token('b@example.com'));

		const { data, error } = await resolveAccount(config(null), store);

		expect(data).toBeNull();
		expect(error?.message).toBe(
			'Multiple Gmail accounts connected (a@example.com, b@example.com). Set LOCAL_MAIL_ACCOUNT to choose one.',
		);
		cleanup();
	});

	test('resolveAccount lets LOCAL_MAIL_ACCOUNT pick one of the stored accounts', async () => {
		const { path, cleanup } = tempTokenFile();
		const store = createFileTokenStore(path);
		await store.set(token('a@example.com'));
		await store.set(token('b@example.com'));

		const { data, error } = await resolveAccount(
			config('b@example.com'),
			store,
		);

		expect(error).toBeNull();
		expect(data).toBe('b@example.com');
		cleanup();
	});

	test('resolveAccount rejects a LOCAL_MAIL_ACCOUNT that is not connected', async () => {
		const { path, cleanup } = tempTokenFile();
		const store = createFileTokenStore(path);
		await store.set(token('a@example.com'));

		const { data, error } = await resolveAccount(
			config('typo@example.com'),
			store,
		);

		expect(data).toBeNull();
		expect(error?.message).toBe(
			'LOCAL_MAIL_ACCOUNT is set to typo@example.com, which is not a connected account (connected: a@example.com).',
		);
		cleanup();
	});
});
