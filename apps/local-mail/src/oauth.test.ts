/**
 * Gmail OAuth Connect Flow Tests
 *
 * Exercises the interactive authorization-code + PKCE path without opening a
 * browser: the test captures the generated consent URL, sends the loopback
 * callback by hand, and serves mock Google token/profile endpoints.
 *
 * Key behaviors:
 * - Consent URL requests gmail.modify
 * - Token exchange authenticates the desktop client with form parameters
 * - The connected Gmail profile supplies the token-store account key
 */

import { expect, test } from 'bun:test';
import { type AppConfig, loadConfig } from './config.ts';
import {
	redeemRefreshToken,
	refreshAccessToken,
	runAuthorizationFlow,
} from './oauth.ts';
import type { TokenSet } from './tokens.ts';

// The credential resolver reads the BYO Google OAuth keyset from the
// environment. These tests assert the resolved client id against `clientIdUsed`,
// so seed it unconditionally to a known value rather than inheriting whatever
// the ambient environment holds.
process.env.GMAIL_CLIENT_ID = 'client-id-123';
process.env.GMAIL_CLIENT_SECRET = 'client-secret-456';

function config(overrides: Partial<AppConfig>): AppConfig {
	return {
		dataDir: '/tmp/local-mail-oauth-test',
		apiBase: 'http://127.0.0.1:0',
		authorizeUrl: 'http://127.0.0.1:0/auth',
		tokenUrl: 'http://127.0.0.1:0/token',
		historySafeWindowDays: 5,
		fullBackstopDays: 30,
		pageSize: 100,
		credentialsPath: '/tmp/local-mail-oauth-test/credentials.json',
		account: null,
		readOnly: false,
		...overrides,
	};
}

async function waitFor<T>(read: () => T | null): Promise<T> {
	for (let i = 0; i < 100; i += 1) {
		const value = read();
		if (value !== null) return value;
		await Bun.sleep(5);
	}
	throw new Error('timed out waiting for test value');
}

test('runAuthorizationFlow exchanges a PKCE callback and stores the connected Gmail account', async () => {
	const tokenRequests: URLSearchParams[] = [];
	const tokenAuthHeaders: (string | null)[] = [];
	const tokenServer = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		async fetch(request) {
			const body = await request.text();
			tokenRequests.push(new URLSearchParams(body));
			tokenAuthHeaders.push(request.headers.get('authorization') ?? '');
			return Response.json(
				{
					token_type: 'Bearer',
					access_token: 'access-token-123',
					refresh_token: 'refresh-token-123',
					expires_in: 3600,
				},
				{ headers: { 'content-type': 'application/json' } },
			);
		},
	});
	const apiServer = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch(request) {
			expect(request.headers.get('authorization')).toBe(
				'Bearer access-token-123',
			);
			return Response.json({
				historyId: '1000',
				emailAddress: 'you@example.com',
			});
		},
	});

	let authorizeUrl: string | null = null;
	const flow = runAuthorizationFlow(
		config({
			apiBase: `http://127.0.0.1:${apiServer.port}`,
			authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
			tokenUrl: `http://127.0.0.1:${tokenServer.port}/token`,
		}),
		{
			now: () => Date.parse('2026-07-01T00:00:00.000Z'),
			openBrowser: (url) => {
				authorizeUrl = url;
			},
			timeoutMs: 5000,
		},
	);

	const url = new URL(await waitFor(() => authorizeUrl));
	expect(url.searchParams.get('scope')).toBe(
		'https://www.googleapis.com/auth/gmail.modify',
	);
	expect(url.searchParams.get('code_challenge_method')).toBe('S256');
	expect(url.searchParams.get('access_type')).toBe('offline');

	const redirectUri = url.searchParams.get('redirect_uri');
	const state = url.searchParams.get('state');
	expect(redirectUri).not.toBeNull();
	expect(state).not.toBeNull();
	await fetch(
		`${redirectUri}?code=auth-code-123&state=${state}&iss=https%3A%2F%2Faccounts.google.com`,
	);

	const { data: token, error } = await flow;
	expect(error).toBeNull();
	expect(token?.accountEmail).toBe('you@example.com');
	expect(token?.refreshToken).toBe('refresh-token-123');
	expect(token?.clientIdUsed).toBe('client-id-123');

	const request = tokenRequests[0];
	expect(request?.get('grant_type')).toBe('authorization_code');
	expect(request?.get('client_id')).toBe('client-id-123');
	expect(request?.get('client_secret')).toBe('client-secret-456');
	expect(tokenAuthHeaders[0]).toBe('');
	expect(request?.get('code_verifier')).toBeTruthy();

	tokenServer.stop(true);
	apiServer.stop(true);
});

test('production config derives the authorization issuer from accounts.google.com', () => {
	expect(new URL(loadConfig().authorizeUrl).origin).toBe(
		'https://accounts.google.com',
	);
});

test('runAuthorizationFlow reports OAuth error details from the token endpoint', async () => {
	const tokenServer = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch() {
			return Response.json(
				{
					error: 'invalid_client',
					error_description: 'The OAuth client was not found.',
				},
				{ status: 401 },
			);
		},
	});

	let authorizeUrl: string | null = null;
	const flow = runAuthorizationFlow(
		config({
			authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
			tokenUrl: `http://127.0.0.1:${tokenServer.port}/token`,
		}),
		{
			now: () => Date.parse('2026-07-01T00:00:00.000Z'),
			openBrowser: (url) => {
				authorizeUrl = url;
			},
			timeoutMs: 5000,
		},
	);

	const url = new URL(await waitFor(() => authorizeUrl));
	const redirectUri = url.searchParams.get('redirect_uri');
	const state = url.searchParams.get('state');
	expect(redirectUri).not.toBeNull();
	expect(state).not.toBeNull();
	await fetch(
		`${redirectUri}?code=auth-code-123&state=${state}&iss=https%3A%2F%2Faccounts.google.com`,
	);

	const { data, error } = await flow;
	expect(data).toBeNull();
	expect(error?.message).toContain('invalid_client');
	expect(error?.message).toContain('The OAuth client was not found.');
	expect(error?.message).toContain('HTTP 401');

	tokenServer.stop(true);
});

test('refreshAccessToken uses a newly returned refresh token when Google rotates it', async () => {
	const tokenServer = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch() {
			return Response.json({
				token_type: 'Bearer',
				access_token: 'rotated-access-token',
				refresh_token: 'rotated-refresh-token',
				expires_in: 3600,
			});
		},
	});

	const { data: token, error } = await refreshAccessToken(
		config({
			tokenUrl: `http://127.0.0.1:${tokenServer.port}/token`,
		}),
		{
			accountEmail: 'you@example.com',
			clientIdUsed: 'client-id-123',
			accessToken: 'stale',
			accessTokenExpiresAt: new Date(0).toISOString(),
			refreshToken: 'old-refresh-token',
			obtainedAt: new Date(0).toISOString(),
		},
		() => Date.parse('2026-07-01T00:00:00.000Z'),
	);

	expect(error).toBeNull();
	expect(token?.accessToken).toBe('rotated-access-token');
	expect(token?.refreshToken).toBe('rotated-refresh-token');
	tokenServer.stop(true);
});

test('refreshAccessToken maps invalid_grant to ReauthRequired', async () => {
	const tokenServer = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch() {
			return Response.json({ error: 'invalid_grant' }, { status: 400 });
		},
	});

	const { data, error } = await refreshAccessToken(
		config({
			tokenUrl: `http://127.0.0.1:${tokenServer.port}/token`,
		}),
		{
			accountEmail: 'you@example.com',
			clientIdUsed: 'client-id-123',
			accessToken: 'stale',
			accessTokenExpiresAt: new Date(0).toISOString(),
			refreshToken: 'dead-refresh-token',
			obtainedAt: new Date(0).toISOString(),
		},
		() => Date.parse('2026-07-01T00:00:00.000Z'),
	);

	expect(data).toBeNull();
	expect(error?.name).toBe('ReauthRequired');
	expect(error?.message).toBe('Re-authentication required: invalid_grant.');
	tokenServer.stop(true);
});

test('redeemRefreshToken performs the grant now and reads the account email from the profile', async () => {
	const tokenRequests: URLSearchParams[] = [];
	const tokenServer = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		async fetch(request) {
			tokenRequests.push(new URLSearchParams(await request.text()));
			// Google's refresh grants often omit refresh_token; the seeded one
			// must survive via the fallback.
			return Response.json({
				token_type: 'Bearer',
				access_token: 'redeemed-access-token',
				expires_in: 3600,
			});
		},
	});
	const apiServer = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch(request) {
			expect(request.headers.get('authorization')).toBe(
				'Bearer redeemed-access-token',
			);
			return Response.json({
				historyId: '1000',
				emailAddress: 'profile@example.com',
			});
		},
	});

	const { data: token, error } = await redeemRefreshToken(
		config({
			apiBase: `http://127.0.0.1:${apiServer.port}`,
			tokenUrl: `http://127.0.0.1:${tokenServer.port}/token`,
		}),
		'seed-refresh-token',
		() => Date.parse('2026-07-01T00:00:00.000Z'),
	);

	expect(error).toBeNull();
	expect(token?.accountEmail).toBe('profile@example.com');
	expect(token?.refreshToken).toBe('seed-refresh-token');
	expect(token?.accessToken).toBe('redeemed-access-token');
	expect(tokenRequests[0]?.get('grant_type')).toBe('refresh_token');
	expect(tokenRequests[0]?.get('refresh_token')).toBe('seed-refresh-token');

	tokenServer.stop(true);
	apiServer.stop(true);
});

test('refreshAccessToken refuses a token minted by a different OAuth client, before any network call', async () => {
	const token: TokenSet = {
		accountEmail: 'you@example.com',
		clientIdUsed: 'the-original-client',
		accessToken: 'stale',
		accessTokenExpiresAt: new Date(0).toISOString(),
		refreshToken: 'a-refresh-token',
		obtainedAt: new Date(0).toISOString(),
	};

	// tokenUrl points at port 0: any attempted request would throw, so a
	// clean ClientIdMismatch also proves the guard fires before the network.
	const { data, error } = await refreshAccessToken(config({}), token, () =>
		Date.parse('2026-07-01T00:00:00.000Z'),
	);

	expect(data).toBeNull();
	expect(error?.name).toBe('ClientIdMismatch');
	expect(error?.message).toContain('the-original-client');
	expect(error?.message).toContain('client-id-123');
});

test('refreshAccessToken fails loudly when the Gmail keyset is missing', async () => {
	// Missing credentials fail before any network call. Clear the keyset so the
	// test holds regardless of the ambient environment.
	const savedId = process.env.GMAIL_CLIENT_ID;
	const savedSecret = process.env.GMAIL_CLIENT_SECRET;
	delete process.env.GMAIL_CLIENT_ID;
	delete process.env.GMAIL_CLIENT_SECRET;
	try {
		const token: TokenSet = {
			accountEmail: 'you@example.com',
			clientIdUsed: 'prod-client',
			accessToken: 'stale',
			accessTokenExpiresAt: new Date(0).toISOString(),
			refreshToken: 'a-refresh-token',
			obtainedAt: new Date(0).toISOString(),
		};
		const { data, error } = await refreshAccessToken(config({}), token, () =>
			Date.parse('2026-07-01T00:00:00.000Z'),
		);
		expect(data).toBeNull();
		expect(error?.name).toBe('MissingCredentials');
		expect(error?.message).toContain('GMAIL_CLIENT_ID');
	} finally {
		if (savedId === undefined) delete process.env.GMAIL_CLIENT_ID;
		else process.env.GMAIL_CLIENT_ID = savedId;
		if (savedSecret === undefined) delete process.env.GMAIL_CLIENT_SECRET;
		else process.env.GMAIL_CLIENT_SECRET = savedSecret;
	}
});
