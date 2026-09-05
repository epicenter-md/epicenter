/**
 * OAuth Client Tests
 *
 * Verifies the shared OAuth 2.1 PKCE launcher used by browser and extension
 * app auth adapters.
 * The tests pin the ownership split: the OAuth client owns PKCE, state,
 * transaction storage, callback classification, and token exchange; launchers
 * only choose how the runtime reaches the callback URL.
 *
 * Key behaviors:
 * - Authorization URLs include PKCE, default scopes, state, and resource
 * - Callback handling rejects missing state, callback errors, and mismatches
 * - Token exchange requires access token, refresh token, and expiry metadata
 */

import { expect, test } from 'bun:test';
import { EPICENTER_OAUTH_SCOPE } from '@epicenter/constants/oauth-clients';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { AuthFetch } from '../auth-contract.js';
import {
	createBrowserOAuthLauncher,
	createExtensionOAuthLauncher,
	createOAuthClient,
} from './index.js';

type MaybePromise<T> = T | Promise<T>;
type MemoryOAuthStorage = {
	getItem: (key: string) => MaybePromise<string | null>;
	setItem: (key: string, value: string) => MaybePromise<void>;
	removeItem: (key: string) => MaybePromise<void>;
};

const REDIRECT_URI = 'http://app.test/auth/callback';

function createMemoryStorage(seed: Record<string, string> = {}) {
	const values = new Map(Object.entries(seed));
	const storage: MemoryOAuthStorage = {
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
		scope: EPICENTER_OAUTH_SCOPE,
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
		resource: 'http://auth.test',
		storage,
		fetch: createFetch(),
	});

	const url = expectOk(await client.createAuthorizationUrl(REDIRECT_URI));

	expect(url.searchParams.get('response_type')).toBe('code');
	expect(url.searchParams.get('client_id')).toBe('client-1');
	expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
	expect(url.searchParams.get('scope')).toBe(EPICENTER_OAUTH_SCOPE);
	expect(url.searchParams.get('resource')).toBe('http://auth.test');
	expect(url.searchParams.get('code_challenge_method')).toBe('S256');
	expect(url.searchParams.get('code_challenge')).toBeTruthy();
	expect(values.size).toBe(1);
	expect([...values.values()][0]).toContain(REDIRECT_URI);
});

/**
 * Run `body` with the browser launcher's one ambient read standing in.
 *
 * The launcher reads `window.location.href` to learn what callback it is
 * sitting on, and that is the seam rather than an injected option: a second way
 * to say "the current URL" would be a thing to keep in step with the real one.
 */
async function atUrl(href: string, body: () => Promise<void>): Promise<void> {
	const hadWindow = 'window' in globalThis;
	const originalWindow = globalThis.window;
	Object.defineProperty(globalThis, 'window', {
		configurable: true,
		value: { location: { href } },
	});
	try {
		await body();
	} finally {
		if (hadWindow) {
			Object.defineProperty(globalThis, 'window', {
				configurable: true,
				value: originalWindow,
			});
		} else {
			delete (globalThis as { window?: unknown }).window;
		}
	}
}

test('browser launcher returns launched after starting redirect', async () => {
	const { storage } = createMemoryStorage();
	const redirects: string[] = [];
	await atUrl('http://app.test/sign-in', async () => {
		const launcher = createBrowserOAuthLauncher({
			issuer: 'http://auth.test/auth',
			clientId: 'client-1',
			redirectUri: REDIRECT_URI,
			resource: 'http://auth.test',
			storage,
			fetch: createFetch(),
			redirectTo: (url) => {
				redirects.push(url);
			},
		});

		const result = await launcher.startSignIn();

		expect(result.error).toBeNull();
		expect(result.data).toEqual({ status: 'launched' });
		expect(redirects).toHaveLength(1);
		const redirect = redirects[0];
		if (!redirect) throw new Error('Expected browser redirect URL.');
		expect(new URL(redirect).searchParams.get('redirect_uri')).toBe(
			REDIRECT_URI,
		);
	});
});

test('startSignIn on a callback URL starts a fresh flow instead of finishing one', async () => {
	// The behaviour this pins is the one that was removed. `startSignIn` used to
	// inspect the current URL and exchange the code it found, so the same call
	// meant "begin" or "finish" depending on a query string, and the callback
	// route asked to begin in order to finish.
	const { storage, values } = createMemoryStorage({
		'epicenter.oauth.client-1': JSON.stringify({
			state: 'state-1',
			codeVerifier: 'verifier-1',
			redirectUri: REDIRECT_URI,
		}),
	});
	const redirects: string[] = [];
	await atUrl(
		'http://app.test/auth/callback?code=code-1&state=state-1',
		async () => {
			const launcher = createBrowserOAuthLauncher({
				issuer: 'http://auth.test/auth',
				clientId: 'client-1',
				redirectUri: REDIRECT_URI,
				resource: 'http://auth.test',
				storage,
				fetch: createFetch(),
				redirectTo: (url) => {
					redirects.push(url);
				},
			});

			expect(expectOk(await launcher.startSignIn())).toEqual({
				status: 'launched',
			});
		},
	);
	expect(redirects).toHaveLength(1);
	// A new transaction, because a launch is a launch: the stale verifier is
	// replaced rather than spent.
	expect([...values.values()][0]).not.toContain('verifier-1');
});

test('completeSignIn exchanges the callback the browser is sitting on', async () => {
	const { storage, values } = createMemoryStorage({
		'epicenter.oauth.client-1': JSON.stringify({
			state: 'state-1',
			codeVerifier: 'verifier-1',
			redirectUri: REDIRECT_URI,
		}),
	});
	await atUrl(
		'http://app.test/auth/callback?code=code-1&state=state-1',
		async () => {
			const launcher = createBrowserOAuthLauncher({
				issuer: 'http://auth.test/auth',
				clientId: 'client-1',
				redirectUri: REDIRECT_URI,
				resource: 'http://auth.test',
				storage,
				fetch: createFetch(),
				redirectTo: () => {
					throw new Error('Completing a callback must not redirect.');
				},
			});

			const grant = expectOk(await launcher.completeSignIn());

			expect(grant.accessToken).toBe('access-token');
			expect(grant.refreshToken).toBe('refresh-token');
		},
	);
	// The verifier is single-use, so the transaction is consumed either way.
	expect(values.size).toBe(0);
});

test('completeSignIn refuses a URL carrying no authorization response, and keeps the transaction', async () => {
	// The refusal is what protects a sign-in still in progress in another tab:
	// reading the transaction consumes it, so a bare visit to the callback route
	// must not get that far.
	const { storage, values } = createMemoryStorage({
		'epicenter.oauth.client-1': JSON.stringify({
			state: 'state-1',
			codeVerifier: 'verifier-1',
			redirectUri: REDIRECT_URI,
		}),
	});
	await atUrl('http://app.test/auth/callback', async () => {
		const launcher = createBrowserOAuthLauncher({
			issuer: 'http://auth.test/auth',
			clientId: 'client-1',
			redirectUri: REDIRECT_URI,
			resource: 'http://auth.test',
			storage,
			fetch: createFetch(),
			redirectTo: () => {
				throw new Error('Completing a callback must not redirect.');
			},
		});

		expect(expectErr(await launcher.completeSignIn()).name).toBe(
			'MissingCallbackParameters',
		);
	});
	expect(values.size).toBe(1);
});

test('completeSignIn surfaces an authorization error carried on the callback', async () => {
	const { storage } = createMemoryStorage();
	await atUrl(
		'http://app.test/auth/callback?error=access_denied&error_description=No',
		async () => {
			const launcher = createBrowserOAuthLauncher({
				issuer: 'http://auth.test/auth',
				clientId: 'client-1',
				redirectUri: REDIRECT_URI,
				resource: 'http://auth.test',
				storage,
				fetch: createFetch(),
				redirectTo: () => {
					throw new Error('Completing a callback must not redirect.');
				},
			});

			const error = expectErr(await launcher.completeSignIn());

			expect(error.name).toBe('AuthorizationFailed');
			expect(error.message).toContain('No');
		},
	);
});

test('the extension launcher cannot complete a callback', () => {
	// It never returns to a redirect URI: `launchWebAuthFlow` hands the response
	// URL straight back, so the whole exchange happens inside `startSignIn`.
	const { storage } = createMemoryStorage();
	const launcher = createExtensionOAuthLauncher({
		issuer: 'http://auth.test/auth',
		clientId: 'client-1',
		redirectUri: REDIRECT_URI,
		resource: 'http://auth.test',
		storage,
		fetch: createFetch(),
		launchWebAuthFlow: async () => REDIRECT_URI,
	});

	expect('completeSignIn' in launcher).toBe(false);
});

test('extension launcher returns completed grant after web-auth callback', async () => {
	const { storage } = createMemoryStorage();
	const launcher = createExtensionOAuthLauncher({
		issuer: 'http://auth.test/auth',
		clientId: 'client-1',
		redirectUri: REDIRECT_URI,
		resource: 'http://auth.test',
		storage,
		fetch: createFetch(),
		launchWebAuthFlow: async (url) => {
			const state = new URL(url).searchParams.get('state');
			expect(state).toBeTruthy();
			return `${REDIRECT_URI}?code=code-1&state=${state}`;
		},
	});

	const before = Date.now();
	const result = expectOk(await launcher.startSignIn());
	const after = Date.now();

	expect(result.status).toBe('completed');
	if (result.status !== 'completed') {
		throw new Error('Expected completed extension OAuth launch.');
	}
	expect(result.grant.accessToken).toBe('access-token');
	expect(result.grant.accessTokenExpiresAt).toBeGreaterThanOrEqual(
		before + 900_000,
	);
	expect(result.grant.accessTokenExpiresAt).toBeLessThanOrEqual(
		after + 900_000,
	);
});

test('exchangeCallback rejects missing stored transaction', async () => {
	const { storage } = createMemoryStorage();
	const client = createOAuthClient({
		issuer: 'http://auth.test/auth',
		clientId: 'client-1',
		resource: 'http://auth.test',
		storage,
		fetch: createFetch(),
	});

	const error = expectErr(
		await client.exchangeCallback(
			'http://app.test/auth/callback?code=code-1&state=state-1',
		),
	);

	expect(error.name).toBe('MissingCallbackTransaction');
});

test('exchangeCallback reports callback authorization errors', async () => {
	const { storage } = createMemoryStorage({
		'epicenter.oauth.client-1': JSON.stringify({
			state: 'state-1',
			codeVerifier: 'verifier-1',
			redirectUri: REDIRECT_URI,
		}),
	});
	const client = createOAuthClient({
		issuer: 'http://auth.test/auth',
		clientId: 'client-1',
		resource: 'http://auth.test',
		storage,
		fetch: createFetch(),
	});

	const error = expectErr(
		await client.exchangeCallback(
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

test('exchangeCallback rejects state mismatch before token exchange', async () => {
	const { storage } = createMemoryStorage({
		'epicenter.oauth.client-1': JSON.stringify({
			state: 'state-1',
			codeVerifier: 'verifier-1',
			redirectUri: REDIRECT_URI,
		}),
	});
	let tokenRequests = 0;
	const client = createOAuthClient({
		issuer: 'http://auth.test/auth',
		clientId: 'client-1',
		resource: 'http://auth.test',
		storage,
		fetch: createFetch({
			onTokenBody: () => {
				tokenRequests += 1;
			},
		}),
	});

	const error = expectErr(
		await client.exchangeCallback(
			'http://app.test/auth/callback?code=code-1&state=state-2',
		),
	);

	expect(error.name).toBe('StateMismatch');
	expect(tokenRequests).toBe(0);
});

test('exchangeCallback returns token result after successful exchange', async () => {
	const { storage, values } = createMemoryStorage({
		'epicenter.oauth.client-1': JSON.stringify({
			state: 'state-1',
			codeVerifier: 'verifier-1',
			redirectUri: REDIRECT_URI,
		}),
	});
	let tokenBody: URLSearchParams | undefined;
	const client = createOAuthClient({
		issuer: 'http://auth.test/auth',
		clientId: 'client-1',
		resource: 'http://auth.test',
		storage,
		fetch: createFetch({
			onTokenBody: (body) => {
				tokenBody = body;
			},
		}),
	});

	const before = Date.now();
	const data = expectOk(
		await client.exchangeCallback(
			'http://app.test/auth/callback?code=code-1&state=state-1',
		),
	);
	const after = Date.now();

	expect(data.accessToken).toBe('access-token');
	expect(data.refreshToken).toBe('refresh-token');
	expect(data.accessTokenExpiresAt).toBeGreaterThanOrEqual(before + 900_000);
	expect(data.accessTokenExpiresAt).toBeLessThanOrEqual(after + 900_000);
	expect(tokenBody?.get('redirect_uri')).toBe(REDIRECT_URI);
	expect(tokenBody?.get('resource')).toBe('http://auth.test');
	expect(values.size).toBe(0);
});

test('exchangeCallback reports token exchange failure', async () => {
	const { storage } = createMemoryStorage({
		'epicenter.oauth.client-1': JSON.stringify({
			state: 'state-1',
			codeVerifier: 'verifier-1',
			redirectUri: REDIRECT_URI,
		}),
	});
	const client = createOAuthClient({
		issuer: 'http://auth.test/auth',
		clientId: 'client-1',
		resource: 'http://auth.test',
		storage,
		fetch: createFetch({ tokenStatus: 400 }),
	});

	const error = expectErr(
		await client.exchangeCallback(
			'http://app.test/auth/callback?code=code-1&state=state-1',
		),
	);

	expect(error.name).toBe('TokenExchangeFailed');
});

test('exchangeCallback rejects a token response without access token', async () => {
	const { storage } = createMemoryStorage({
		'epicenter.oauth.client-1': JSON.stringify({
			state: 'state-1',
			codeVerifier: 'verifier-1',
			redirectUri: REDIRECT_URI,
		}),
	});
	const client = createOAuthClient({
		issuer: 'http://auth.test/auth',
		clientId: 'client-1',
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
		await client.exchangeCallback(
			'http://app.test/auth/callback?code=code-1&state=state-1',
		),
	);

	expect(error.name).toBe('TokenExchangeFailed');
});

test('exchangeCallback wraps missing refresh_token as TokenExchangeFailed', async () => {
	const { storage } = createMemoryStorage({
		'epicenter.oauth.client-1': JSON.stringify({
			state: 'state-1',
			codeVerifier: 'verifier-1',
			redirectUri: REDIRECT_URI,
		}),
	});
	const client = createOAuthClient({
		issuer: 'http://auth.test/auth',
		clientId: 'client-1',
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
		await client.exchangeCallback(
			'http://app.test/auth/callback?code=code-1&state=state-1',
		),
	) as { name?: string; cause?: { name?: string } };

	expect(error.name).toBe('TokenExchangeFailed');
	expect(error.cause?.name).toBe('MissingRefreshToken');
});

test('exchangeCallback wraps missing expires_in as TokenExchangeFailed', async () => {
	const { storage } = createMemoryStorage({
		'epicenter.oauth.client-1': JSON.stringify({
			state: 'state-1',
			codeVerifier: 'verifier-1',
			redirectUri: REDIRECT_URI,
		}),
	});
	const client = createOAuthClient({
		issuer: 'http://auth.test/auth',
		clientId: 'client-1',
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
		await client.exchangeCallback(
			'http://app.test/auth/callback?code=code-1&state=state-1',
		),
	) as { name?: string; cause?: { name?: string } };

	expect(error.name).toBe('TokenExchangeFailed');
	expect(error.cause?.name).toBe('MissingExpiresIn');
});

test('exchangeCallback rejects a non-bearer token response', async () => {
	const { storage } = createMemoryStorage({
		'epicenter.oauth.client-1': JSON.stringify({
			state: 'state-1',
			codeVerifier: 'verifier-1',
			redirectUri: REDIRECT_URI,
		}),
	});
	const client = createOAuthClient({
		issuer: 'http://auth.test/auth',
		clientId: 'client-1',
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
		await client.exchangeCallback(
			'http://app.test/auth/callback?code=code-1&state=state-1',
		),
	);

	expect(error.name).toBe('TokenExchangeFailed');
});
