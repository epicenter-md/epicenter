/**
 * Token Manager Tests
 *
 * Verifies the live-token manager that sits between Gmail callers and the
 * persisted OAuth token store.
 *
 * Key behaviors:
 * - Live access tokens are returned without touching the token endpoint
 * - Expired access tokens refresh once and persist the rotated set
 * - Concurrent refresh callers share one in-flight grant
 * - Failed refreshes clear the in-flight grant so later callers retry
 */

import { expect, test } from 'bun:test';
import type { AppConfig } from './config.ts';
import { createTokenManager } from './token-manager.ts';
import type { TokenStore } from './token-store.ts';
import type { TokenSet } from './tokens.ts';

// The credential resolver reads the BYO Google OAuth keyset from the
// environment; seed it unconditionally so the resolved client id matches
// `clientIdUsed` exactly.
process.env.GMAIL_CLIENT_ID = 'client-id-123';
process.env.GMAIL_CLIENT_SECRET = 'client-secret-456';

function config(overrides: Partial<AppConfig>): AppConfig {
	return {
		dataDir: '/tmp/local-mail-token-manager-test',
		apiBase: 'http://127.0.0.1:0',
		authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
		tokenUrl: 'http://127.0.0.1:0/token',
		historySafeWindowDays: 5,
		fullBackstopDays: 30,
		pageSize: 100,
		credentialsPath: '/tmp/local-mail-token-manager-test/credentials.json',
		account: null,
		readOnly: false,
		...overrides,
	};
}

function token(overrides: Partial<TokenSet> = {}): TokenSet {
	return {
		accountEmail: 'you@example.com',
		clientIdUsed: 'client-id-123',
		accessToken: 'old-access-token',
		accessTokenExpiresAt: new Date(0).toISOString(),
		refreshToken: 'old-refresh-token',
		obtainedAt: new Date(0).toISOString(),
		...overrides,
	};
}

function fakeStore() {
	const writes: TokenSet[] = [];
	const store: TokenStore = {
		async get() {
			return null;
		},
		async listAccounts() {
			return [];
		},
		async set(tokenSet) {
			writes.push(tokenSet);
		},
	};
	return { store, writes };
}

test('getValidAccessToken returns a live token without refreshing', async () => {
	const fetch = globalThis.fetch;
	let tokenRequests = 0;
	globalThis.fetch = ((input, init) => {
		tokenRequests += 1;
		return fetch(input, init);
	}) as typeof globalThis.fetch;
	const { store, writes } = fakeStore();
	const manager = createTokenManager({
		config: config({}),
		store,
		token: token({
			accessToken: 'live-access-token',
			accessTokenExpiresAt: new Date(
				Date.parse('2026-07-01T00:10:00.000Z'),
			).toISOString(),
		}),
		now: () => Date.parse('2026-07-01T00:00:00.000Z'),
	});

	try {
		const { data, error } = await manager.getValidAccessToken();

		expect(error).toBeNull();
		expect(data).toBe('live-access-token');
		expect(tokenRequests).toBe(0);
		expect(writes).toEqual([]);
	} finally {
		globalThis.fetch = fetch;
	}
});

test('getValidAccessToken refreshes an expired token and persists the rotated set', async () => {
	const tokenRequests: URLSearchParams[] = [];
	const tokenServer = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		async fetch(request) {
			tokenRequests.push(new URLSearchParams(await request.text()));
			return Response.json({
				token_type: 'Bearer',
				access_token: 'new-access-token',
				refresh_token: 'new-refresh-token',
				expires_in: 3600,
			});
		},
	});
	const { store, writes } = fakeStore();
	const manager = createTokenManager({
		config: config({ tokenUrl: `http://127.0.0.1:${tokenServer.port}/token` }),
		store,
		token: token(),
		now: () => Date.parse('2026-07-01T00:00:00.000Z'),
	});

	const { data, error } = await manager.getValidAccessToken();

	expect(error).toBeNull();
	expect(data).toBe('new-access-token');
	expect(tokenRequests).toHaveLength(1);
	expect(tokenRequests[0]?.get('grant_type')).toBe('refresh_token');
	expect(tokenRequests[0]?.get('refresh_token')).toBe('old-refresh-token');
	expect(writes).toHaveLength(1);
	expect(writes[0]).toMatchObject({
		accountEmail: 'you@example.com',
		clientIdUsed: 'client-id-123',
		accessToken: 'new-access-token',
		refreshToken: 'new-refresh-token',
		accessTokenExpiresAt: '2026-07-01T01:00:00.000Z',
		obtainedAt: '2026-07-01T00:00:00.000Z',
	});
	tokenServer.stop(true);
});

test('concurrent getValidAccessToken callers share one refresh grant', async () => {
	const release = Promise.withResolvers<void>();
	let tokenRequests = 0;
	const tokenServer = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		async fetch() {
			tokenRequests += 1;
			await release.promise;
			return Response.json({
				token_type: 'Bearer',
				access_token: 'shared-access-token',
				refresh_token: 'shared-refresh-token',
				expires_in: 3600,
			});
		},
	});
	const { store, writes } = fakeStore();
	const manager = createTokenManager({
		config: config({ tokenUrl: `http://127.0.0.1:${tokenServer.port}/token` }),
		store,
		token: token(),
		now: () => Date.parse('2026-07-01T00:00:00.000Z'),
	});

	const first = manager.getValidAccessToken();
	const second = manager.getValidAccessToken();
	while (tokenRequests === 0) await Bun.sleep(1);
	release.resolve();
	const [firstResult, secondResult] = await Promise.all([first, second]);

	expect(firstResult.error).toBeNull();
	expect(secondResult.error).toBeNull();
	expect(firstResult.data).toBe('shared-access-token');
	expect(secondResult.data).toBe('shared-access-token');
	expect(tokenRequests).toBe(1);
	expect(writes).toHaveLength(1);
	tokenServer.stop(true);
});

test('refresh failure returns an error and the next call retries', async () => {
	let tokenRequests = 0;
	const tokenServer = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch() {
			tokenRequests += 1;
			if (tokenRequests === 1) {
				return Response.json(
					{
						error: 'invalid_client',
						error_description: 'The OAuth client was not found.',
					},
					{ status: 401 },
				);
			}
			return Response.json({
				token_type: 'Bearer',
				access_token: 'retried-access-token',
				refresh_token: 'retried-refresh-token',
				expires_in: 3600,
			});
		},
	});
	const { store, writes } = fakeStore();
	const manager = createTokenManager({
		config: config({ tokenUrl: `http://127.0.0.1:${tokenServer.port}/token` }),
		store,
		token: token(),
		now: () => Date.parse('2026-07-01T00:00:00.000Z'),
	});

	const failed = await manager.getValidAccessToken();
	const retried = await manager.getValidAccessToken();

	expect(failed.data).toBeNull();
	expect(failed.error?.name).toBe('TokenExchangeFailed');
	expect(retried.error).toBeNull();
	expect(retried.data).toBe('retried-access-token');
	expect(tokenRequests).toBe(2);
	expect(writes).toHaveLength(1);
	tokenServer.stop(true);
});
