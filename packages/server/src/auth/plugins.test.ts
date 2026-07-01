/**
 * Auth plugin (OAuth server) tests.
 *
 * Verifies the first-party OAuth client registry projected by
 * `@epicenter/constants/oauth-seed` and the Better Auth behavior `authPlugins`
 * wires around it.
 *
 * Key behaviors:
 * - Trusted registry clients are projected as public PKCE clients
 * - Trusted clients skip consent during authorization
 * - Registered non-trusted clients still require consent
 * - A clean JWKS table mints an ES256/P-256 signing key
 */

import { expect, test } from 'bun:test';
import {
	EPICENTER_CLI_OAUTH_CLIENT_ID,
	EPICENTER_FUJI_OAUTH_CLIENT_ID,
	EPICENTER_OAUTH_SCOPES,
} from '@epicenter/constants/oauth-clients';
import {
	buildTrustedOAuthClients,
	projectTrustedOAuthClientToRow,
	type TrustedOAuthClient,
} from '@epicenter/constants/oauth-seed';
import { betterAuth } from 'better-auth';
import { type MemoryDB, memoryAdapter } from 'better-auth/adapters/memory';
import { generateCodeChallenge } from 'better-auth/oauth2';
import { authPlugins } from './plugins.js';

const trustedClientFixture = {
	clientId: EPICENTER_FUJI_OAUTH_CLIENT_ID,
	name: 'Fuji',
	redirectUris: [
		'http://localhost:5174/auth/callback',
		'https://fuji.epicenter.so/auth/callback',
	],
} as const satisfies TrustedOAuthClient;
const redirectUri = trustedClientFixture.redirectUris[0];

function findCliClient(baseURL: string) {
	const cliClient = buildTrustedOAuthClients(baseURL).find(
		(client) => client.clientId === EPICENTER_CLI_OAUTH_CLIENT_ID,
	);
	if (!cliClient) throw new Error('Expected trusted CLI OAuth client');
	return cliClient;
}
const verifier = 'test-verifier-test-verifier-test-verifier';

test('trusted OAuth clients project to public PKCE client rows', () => {
	const row = projectTrustedOAuthClientToRow({
		clientId: 'trusted-client-1',
		name: 'Trusted Client',
		redirectUris: [redirectUri],
	});

	expect(row).toMatchObject({
		id: 'trusted-client-1',
		clientId: 'trusted-client-1',
		name: 'Trusted Client',
		redirectUris: [redirectUri],
		tokenEndpointAuthMethod: 'none',
		grantTypes: ['authorization_code'],
		responseTypes: ['code'],
		scopes: [...EPICENTER_OAUTH_SCOPES],
		public: true,
		type: null,
		requirePKCE: true,
		skipConsent: true,
	});
});

test('trusted OAuth client exchanges code for API-origin access token', async () => {
	const setup = createTrustedClientTestAuth();

	const cookie = await signUpTestUser(setup.auth, setup.baseURL);
	const code = await authorize(setup, {
		clientId: setup.trustedClientId,
		cookie,
	});
	if (!code) throw new Error('Expected authorization code');

	const response = await setup.auth.handler(
		new Request(`${setup.baseURL}/auth/oauth2/token`, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'authorization_code',
				code,
				code_verifier: verifier,
				client_id: setup.trustedClientId,
				redirect_uri: redirectUri,
				resource: setup.baseURL,
			}),
		}),
	);
	const body = await response.json();
	if (
		!body ||
		typeof body !== 'object' ||
		!('access_token' in body) ||
		typeof body.access_token !== 'string'
	) {
		throw new Error('Expected token response with access_token');
	}
	const payload = decodeJwtPayload(body.access_token);
	const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];

	expect(response.status).toBe(200);
	expect(audiences).toContain(setup.baseURL);
	expect(payload.iss).toBe(`${setup.baseURL}/auth`);
});

test('trusted CLI OAuth client exchanges code with PKCE', async () => {
	const baseURL = 'http://localhost:47878';
	const cliClient = findCliClient(baseURL);
	const setup = createTrustedClientTestAuth({
		trustedClient: cliClient,
		baseURL,
	});

	const cookie = await signUpTestUser(setup.auth, setup.baseURL);
	const code = await authorize(setup, {
		clientId: EPICENTER_CLI_OAUTH_CLIENT_ID,
		cookie,
		redirectUri: cliClient.redirectUris[0],
	});
	if (!code) throw new Error('Expected authorization code');

	const response = await setup.auth.handler(
		new Request(`${setup.baseURL}/auth/oauth2/token`, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'authorization_code',
				code,
				code_verifier: verifier,
				client_id: EPICENTER_CLI_OAUTH_CLIENT_ID,
				redirect_uri: cliClient.redirectUris[0],
				resource: setup.baseURL,
			}),
		}),
	);
	const body = (await response.json()) as {
		access_token?: unknown;
		refresh_token?: unknown;
		scope?: unknown;
		token_type?: unknown;
	};

	expect(response.status).toBe(200);
	expect(body).toMatchObject({
		token_type: 'Bearer',
		scope: EPICENTER_OAUTH_SCOPES.join(' '),
	});
	expect(typeof body.access_token).toBe('string');
	expect(typeof body.refresh_token).toBe('string');
});

test('clean JWKS table mints an ES256/P-256 signing key', async () => {
	const setup = createTrustedClientTestAuth();

	const response = await setup.auth.handler(
		new Request(`${setup.baseURL}/auth/jwks`),
	);
	const body = (await response.json()) as {
		keys: Array<Record<string, unknown>>;
	};
	const [key] = body.keys;

	expect(response.status).toBe(200);
	expect(key).toMatchObject({ alg: 'ES256', kty: 'EC', crv: 'P-256' });
});

test('buildTrustedOAuthClients gives the CLI a callback at each deployment baseURL', () => {
	for (const baseURL of [
		'https://api.epicenter.so',
		'http://localhost:8787',
		'http://localhost:9999',
		'https://api.acme.example',
	]) {
		const cliClient = findCliClient(baseURL);
		expect(cliClient.redirectUris).toEqual([`${baseURL}/auth/cli-callback`]);
	}
});

test('registered non-trusted OAuth client requires consent', async () => {
	const setup = createTrustedClientTestAuth();

	const cookie = await signUpTestUser(setup.auth, setup.baseURL);
	const response = await authorizeResponse(setup, {
		clientId: 'registered-client-1',
		cookie,
	});
	const location = response.headers.get('location');

	expect(response.status).toBe(302);
	expect(location).toBeTruthy();
	expect(new URL(location ?? setup.baseURL, setup.baseURL).pathname).toBe(
		'/consent',
	);
});

function createTrustedClientTestAuth({
	trustedClient: inputTrustedClient = trustedClientFixture,
	baseURL = 'http://localhost:47878',
}: {
	trustedClient?: TrustedOAuthClient;
	baseURL?: string;
} = {}) {
	const trustedClient = projectTrustedOAuthClientToRow(inputTrustedClient);
	const registeredClient = {
		...projectTrustedOAuthClientToRow({
			clientId: 'registered-client-1',
			name: 'Registered Client',
			redirectUris: [redirectUri],
		}),
		skipConsent: false,
	};
	const db: MemoryDB = {
		user: [],
		session: [],
		account: [],
		verification: [],
		oauthClient: [trustedClient, registeredClient],
		oauthAccessToken: [],
		oauthConsent: [],
		oauthRefreshToken: [],
		jwks: [],
	};

	const auth = betterAuth({
		database: memoryAdapter(db),
		emailAndPassword: { enabled: true },
		basePath: '/auth',
		baseURL,
		secret: 'test-secret-test-secret-test-secret',
		plugins: authPlugins(baseURL),
	});

	return { auth, baseURL, trustedClientId: trustedClient.clientId };
}

async function signUpTestUser(
	auth: ReturnType<typeof createTrustedClientTestAuth>['auth'],
	baseURL: string,
) {
	const response = await auth.handler(
		new Request(`${baseURL}/auth/sign-up/email`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				email: `trusted-client-${crypto.randomUUID()}@example.com`,
				password: 'password123',
				name: 'Trusted Client Test',
			}),
		}),
	);
	const cookie = response.headers.get('set-cookie');
	expect(cookie).toBeTruthy();
	return cookie ?? '';
}

async function authorize(
	setup: ReturnType<typeof createTrustedClientTestAuth>,
	input: { clientId: string; cookie: string; redirectUri?: string },
) {
	const response = await authorizeResponse(setup, input);
	const location = response.headers.get('location');
	expect(location).toBeTruthy();
	return new URL(location ?? redirectUri).searchParams.get('code');
}

async function authorizeResponse(
	{ auth, baseURL }: ReturnType<typeof createTrustedClientTestAuth>,
	{
		clientId,
		cookie,
		redirectUri: inputRedirectUri = redirectUri,
	}: { clientId: string; cookie: string; redirectUri?: string },
) {
	const authorizeUrl = new URL(`${baseURL}/auth/oauth2/authorize`);
	for (const [key, value] of Object.entries({
		response_type: 'code',
		client_id: clientId,
		redirect_uri: inputRedirectUri,
		scope: 'openid profile email offline_access',
		state: 'state-1',
		code_challenge: await generateCodeChallenge(verifier),
		code_challenge_method: 'S256',
		resource: baseURL,
	})) {
		authorizeUrl.searchParams.set(key, value);
	}

	return auth.handler(
		new Request(authorizeUrl.toString(), { headers: { cookie } }),
	);
}

function decodeJwtPayload(token: string) {
	// Better Auth access tokens are JWTs here. This test reads unverified claims
	// because token verification is covered at the protected resource boundary.
	const [, payload] = token.split('.');
	if (!payload) throw new Error('Expected JWT access token');
	const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
	const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
	return JSON.parse(atob(padded)) as Record<string, unknown>;
}
