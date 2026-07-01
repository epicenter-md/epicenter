import { expect } from 'bun:test';
import { EPICENTER_OAUTH_SCOPE } from '@epicenter/constants/oauth-clients';
import { projectTrustedOAuthClientToRow } from '@epicenter/constants/oauth-seed';
import type { MemoryDB } from 'better-auth/adapters/memory';
import { generateCodeChallenge } from 'better-auth/oauth2';

export const OAUTH_TEST_REDIRECT_URI = 'http://localhost:5174/auth/callback';

export const OAUTH_TEST_SCOPE = EPICENTER_OAUTH_SCOPE;

const verifier = 'test-verifier-test-verifier-test-verifier';

type TestAuth = {
	handler(request: Request): Response | Promise<Response>;
};

/**
 * Create the Better Auth memory adapter shape used by OAuth tests.
 *
 * The database row names are owned by Better Auth. Keeping this fixture in one
 * helper avoids each test file maintaining its own partial adapter shape while
 * still leaving per-test seed data inline at the behavior being asserted.
 */
export function createOAuthTestDb(): MemoryDB {
	return {
		user: [],
		session: [],
		account: [],
		verification: [],
		oauthClient: [],
		oauthAccessToken: [],
		oauthConsent: [],
		oauthRefreshToken: [],
		jwks: [],
	};
}

/**
 * Identify the transient port collision Bun raises during local test servers.
 *
 * Port retry loops need this unsafe Node-style error-code check. Keeping that
 * check here gives the OAuth tests one boundary for the cast instead of
 * repeating it beside every `Bun.serve` call.
 */
export function isAddressInUse(error: unknown) {
	return (
		error instanceof Error &&
		'code' in error &&
		(error as { code?: unknown }).code === 'EADDRINUSE'
	);
}

export function randomOAuthTestPort() {
	return 10_000 + Math.floor(Math.random() * 50_000);
}

/**
 * Issue a real OAuth access token through the Better Auth protocol.
 *
 * This helper is intentionally the single source of truth for the shared OAuth
 * ceremony: sign up a user, register a public PKCE client, authorize with a
 * resource audience, and exchange the code for tokens. Callers keep local
 * literals like client names and emails inline because those describe the test
 * case, not the protocol boundary.
 */
export async function issueOAuthTokens(
	{ auth, baseURL, db }: { auth: TestAuth; baseURL: string; db: MemoryDB },
	{
		clientName,
		email,
		name,
		resource = baseURL,
		scope = OAUTH_TEST_SCOPE,
	}: {
		clientName: string;
		email: string;
		name: string;
		resource?: string;
		scope?: string;
	},
) {
	const signUpResponse = await auth.handler(
		new Request(`${baseURL}/auth/sign-up/email`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ email, password: 'password123', name }),
		}),
	);
	const cookie = signUpResponse.headers.get('set-cookie');
	expect(cookie).toBeTruthy();

	const clientId = `test-client-${crypto.randomUUID()}`;
	db.oauthClient?.push(
		projectTrustedOAuthClientToRow({
			clientId,
			name: clientName,
			redirectUris: [OAUTH_TEST_REDIRECT_URI],
		}),
	);

	const authorizeUrl = new URL(`${baseURL}/auth/oauth2/authorize`);
	for (const [key, value] of Object.entries({
		response_type: 'code',
		client_id: clientId,
		redirect_uri: OAUTH_TEST_REDIRECT_URI,
		scope,
		state: 'state-1',
		code_challenge: await generateCodeChallenge(verifier),
		code_challenge_method: 'S256',
		resource,
	})) {
		authorizeUrl.searchParams.set(key, value);
	}

	const authorizeResponse = await auth.handler(
		new Request(authorizeUrl.toString(), {
			headers: { cookie: cookie ?? '' },
		}),
	);
	const location = authorizeResponse.headers.get('location');
	expect(location).toBeTruthy();
	const code = new URL(location ?? OAUTH_TEST_REDIRECT_URI).searchParams.get(
		'code',
	);
	expect(code).toBeTruthy();

	const tokenResponse = await auth.handler(
		new Request(`${baseURL}/auth/oauth2/token`, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'authorization_code',
				client_id: clientId,
				redirect_uri: OAUTH_TEST_REDIRECT_URI,
				code: code ?? '',
				code_verifier: verifier,
				resource,
			}),
		}),
	);
	expect(tokenResponse.status).toBe(200);
	const tokenBody = (await tokenResponse.json()) as {
		access_token: string;
		refresh_token?: string;
	};
	return {
		accessToken: tokenBody.access_token,
		refreshToken: tokenBody.refresh_token ?? null,
	};
}
