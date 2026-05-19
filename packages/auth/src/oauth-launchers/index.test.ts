/**
 * OAuth Client Tests
 *
 * Verifies the shared OAuth 2.1 PKCE launcher used by browser and extension
 * app auth adapters.
 *
 * Key behaviors:
 * - Authorization URLs include PKCE, default scopes, state, and resource
 * - Callback handling rejects missing state, callback errors, and mismatches
 * - Token exchange requires access token, refresh token, and expiry metadata
 */

import { expect, test } from 'bun:test';
import { expectErr, expectOk } from '@epicenter/test-utils/result';
import type { AuthFetch } from '../create-oauth-app-auth.js';
import { createOAuthClient, type OAuthTemporaryStorage } from './index.js';

function createMemoryStorage(seed: Record<string, string> = {}) {
	const values = new Map(Object.entries(seed));
	const storage: OAuthTemporaryStorage = {
		getItem: (key) => values.get(key) ?? null,
		setItem: (key, value) => {
			values.set(key, value);
		},
		removeItem: (key) => {
			values.delete(key);
		},
	};
	return { storage, values };
}

function createFetch({
	tokenStatus = 200,
	tokenBody = {
		access_token: 'access-token',
		refresh_token: 'refresh-token',
		expires_in: 900,
		token_type: 'Bearer',
		scope: 'openid profile email offline_access workspaces:open',
	},
	onTokenBody,
}: {
	tokenStatus?: number;
	tokenBody?: Record<string, unknown>;
	onTokenBody?: (body: URLSearchParams) => void;
} = {}): AuthFetch {
	return async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : input);
		if (url.pathname === '/.well-known/oauth-authorization-server/auth') {
			return Response.json({
				issuer: 'http://auth.test/auth',
				authorization_endpoint: 'http://auth.test/auth/oauth2/authorize',
				token_endpoint: 'http://auth.test/auth/oauth2/token',
			});
		}
		if (url.pathname === '/auth/oauth2/token') {
			const body = new URLSearchParams(String(init?.body ?? ''));
			onTokenBody?.(body);
			return Response.json(
				tokenStatus === 200 ? tokenBody : { error: 'invalid_grant' },
				{ status: tokenStatus },
			);
		}
		throw new Error(`Unexpected fetch: ${url.toString()}`);
	};
}

test('createAuthorizationUrl stores verifier state and returns PKCE URL', async () => {
	const { storage, values } = createMemoryStorage();
	const client = createOAuthClient({
		issuer: 'http://auth.test/auth',
		clientId: 'client-1',
		redirectUri: 'http://app.test/auth/callback',
		resource: 'http://auth.test',
		storage,
		fetch: createFetch(),
	});

	const url = expectOk(await client.createAuthorizationUrl());

	expect(url.searchParams.get('response_type')).toBe('code');
	expect(url.searchParams.get('client_id')).toBe('client-1');
	expect(url.searchParams.get('scope')).toBe(
		'openid profile email offline_access workspaces:open',
	);
	expect(url.searchParams.get('resource')).toBe('http://auth.test');
	expect(url.searchParams.get('code_challenge_method')).toBe('S256');
	expect(url.searchParams.get('code_challenge')).toBeTruthy();
	expect(values.size).toBe(1);
});

test('handleCallback rejects missing stored transaction', async () => {
	const { storage } = createMemoryStorage();
	const client = createOAuthClient({
		issuer: 'http://auth.test/auth',
		clientId: 'client-1',
		redirectUri: 'http://app.test/auth/callback',
		resource: 'http://auth.test',
		storage,
		fetch: createFetch(),
	});

	const error = expectErr(
		await client.handleCallback(
			'http://app.test/auth/callback?code=code-1&state=state-1',
		),
	);

	expect(error.name).toBe('MissingCallbackTransaction');
});

test('handleCallback reports callback authorization errors', async () => {
	const { storage } = createMemoryStorage({
		'epicenter.oauth.client-1': JSON.stringify({
			state: 'state-1',
			codeVerifier: 'verifier-1',
			redirectUri: 'http://app.test/auth/callback',
		}),
	});
	const client = createOAuthClient({
		issuer: 'http://auth.test/auth',
		clientId: 'client-1',
		redirectUri: 'http://app.test/auth/callback',
		resource: 'http://auth.test',
		storage,
		fetch: createFetch(),
	});

	const error = expectErr(
		await client.handleCallback(
			'http://app.test/auth/callback?error=access_denied&error_description=Denied&state=state-1',
		),
	);

	expect(error).toEqual(
		expect.objectContaining({
			name: 'AuthorizationFailed',
			error: 'access_denied',
			description: 'Denied',
		}),
	);
});

test('handleCallback rejects state mismatch before token exchange', async () => {
	const { storage } = createMemoryStorage({
		'epicenter.oauth.client-1': JSON.stringify({
			state: 'state-1',
			codeVerifier: 'verifier-1',
			redirectUri: 'http://app.test/auth/callback',
		}),
	});
	let tokenRequests = 0;
	const client = createOAuthClient({
		issuer: 'http://auth.test/auth',
		clientId: 'client-1',
		redirectUri: 'http://app.test/auth/callback',
		resource: 'http://auth.test',
		storage,
		fetch: createFetch({
			onTokenBody: () => {
				tokenRequests += 1;
			},
		}),
	});

	const error = expectErr(
		await client.handleCallback(
			'http://app.test/auth/callback?code=code-1&state=state-2',
		),
	);

	expect(error.name).toBe('StateMismatch');
	expect(tokenRequests).toBe(0);
});

test('handleCallback returns token result after successful exchange', async () => {
	const { storage, values } = createMemoryStorage({
		'epicenter.oauth.client-1': JSON.stringify({
			state: 'state-1',
			codeVerifier: 'verifier-1',
			redirectUri: 'http://app.test/auth/callback',
		}),
	});
	let tokenBody: URLSearchParams | undefined;
	const now = Date.now();
	const client = createOAuthClient({
		issuer: 'http://auth.test/auth',
		clientId: 'client-1',
		redirectUri: 'http://app.test/auth/callback',
		resource: 'http://auth.test',
		storage,
		fetch: createFetch({
			onTokenBody: (body) => {
				tokenBody = body;
			},
		}),
	});

	const data = expectOk(
		await client.handleCallback(
			'http://app.test/auth/callback?code=code-1&state=state-1',
		),
	);
	if (!data) throw new Error('Expected non-null token grant');

	expect(data.accessToken).toBe('access-token');
	expect(data.refreshToken).toBe('refresh-token');
	expect(data.accessTokenExpiresAt).toBeGreaterThanOrEqual(now + 899_000);
	expect(tokenBody?.get('resource')).toBe('http://auth.test');
	expect(values.size).toBe(0);
});

test('handleCallback reports token exchange failure', async () => {
	const { storage } = createMemoryStorage({
		'epicenter.oauth.client-1': JSON.stringify({
			state: 'state-1',
			codeVerifier: 'verifier-1',
			redirectUri: 'http://app.test/auth/callback',
		}),
	});
	const client = createOAuthClient({
		issuer: 'http://auth.test/auth',
		clientId: 'client-1',
		redirectUri: 'http://app.test/auth/callback',
		resource: 'http://auth.test',
		storage,
		fetch: createFetch({ tokenStatus: 400 }),
	});

	const error = expectErr(
		await client.handleCallback(
			'http://app.test/auth/callback?code=code-1&state=state-1',
		),
	);

	expect(error.name).toBe('TokenExchangeFailed');
});

test('handleCallback rejects a token response without access token', async () => {
	const { storage } = createMemoryStorage({
		'epicenter.oauth.client-1': JSON.stringify({
			state: 'state-1',
			codeVerifier: 'verifier-1',
			redirectUri: 'http://app.test/auth/callback',
		}),
	});
	const client = createOAuthClient({
		issuer: 'http://auth.test/auth',
		clientId: 'client-1',
		redirectUri: 'http://app.test/auth/callback',
		resource: 'http://auth.test',
		storage,
		fetch: createFetch({
			tokenBody: {
				refresh_token: 'refresh-token',
				expires_in: 900,
				token_type: 'Bearer',
			},
		}),
	});

	const error = expectErr(
		await client.handleCallback(
			'http://app.test/auth/callback?code=code-1&state=state-1',
		),
	);

	expect(error.name).toBe('TokenExchangeFailed');
});

test('handleCallback rejects a token response without refresh token', async () => {
	const { storage } = createMemoryStorage({
		'epicenter.oauth.client-1': JSON.stringify({
			state: 'state-1',
			codeVerifier: 'verifier-1',
			redirectUri: 'http://app.test/auth/callback',
		}),
	});
	const client = createOAuthClient({
		issuer: 'http://auth.test/auth',
		clientId: 'client-1',
		redirectUri: 'http://app.test/auth/callback',
		resource: 'http://auth.test',
		storage,
		fetch: createFetch({
			tokenBody: {
				access_token: 'access-token',
				expires_in: 900,
				token_type: 'Bearer',
			},
		}),
	});

	const error = expectErr(
		await client.handleCallback(
			'http://app.test/auth/callback?code=code-1&state=state-1',
		),
	);

	expect(error.name).toBe('MissingRefreshToken');
});

test('handleCallback rejects a token response without expires_in', async () => {
	const { storage } = createMemoryStorage({
		'epicenter.oauth.client-1': JSON.stringify({
			state: 'state-1',
			codeVerifier: 'verifier-1',
			redirectUri: 'http://app.test/auth/callback',
		}),
	});
	const client = createOAuthClient({
		issuer: 'http://auth.test/auth',
		clientId: 'client-1',
		redirectUri: 'http://app.test/auth/callback',
		resource: 'http://auth.test',
		storage,
		fetch: createFetch({
			tokenBody: {
				access_token: 'access-token',
				refresh_token: 'refresh-token',
				token_type: 'Bearer',
			},
		}),
	});

	const error = expectErr(
		await client.handleCallback(
			'http://app.test/auth/callback?code=code-1&state=state-1',
		),
	);

	expect(error.name).toBe('MissingExpiresIn');
});

test('handleCallback rejects a non-bearer token response', async () => {
	const { storage } = createMemoryStorage({
		'epicenter.oauth.client-1': JSON.stringify({
			state: 'state-1',
			codeVerifier: 'verifier-1',
			redirectUri: 'http://app.test/auth/callback',
		}),
	});
	const client = createOAuthClient({
		issuer: 'http://auth.test/auth',
		clientId: 'client-1',
		redirectUri: 'http://app.test/auth/callback',
		resource: 'http://auth.test',
		storage,
		fetch: createFetch({
			tokenBody: {
				access_token: 'access-token',
				refresh_token: 'refresh-token',
				expires_in: 900,
				token_type: 'mac',
			},
		}),
	});

	const error = expectErr(
		await client.handleCallback(
			'http://app.test/auth/callback?code=code-1&state=state-1',
		),
	);

	expect(error.name).toBe('TokenExchangeFailed');
});
