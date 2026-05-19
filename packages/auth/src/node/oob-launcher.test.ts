/**
 * OOB OAuth launcher tests.
 *
 * Covers:
 * - happy path: token response -> 3-field OAuthTokenGrant
 * - PKCE: code_challenge = base64url(SHA-256(code_verifier))
 * - cancellation: empty paste short-circuits before network
 * - invalid token responses (non-bearer token_type, etc.)
 * - server errors propagate status + body
 * - openBrowser failure is non-fatal
 * - case-insensitive token_type check
 */

import { expect, test } from 'bun:test';
import { expectErr, expectOk } from '@epicenter/test-utils/result';
import type { AuthFetch } from '../create-oauth-app-auth.js';
import { createOobOAuthLauncher } from './oob-launcher.js';

const NOW = 1_700_000_000_000;

function makeJsonResponse(value: unknown, init?: ResponseInit) {
	return new Response(JSON.stringify(value), {
		status: 200,
		...init,
		headers: { 'content-type': 'application/json', ...init?.headers },
	});
}

function captureBody(body: BodyInit | null | undefined): URLSearchParams {
	if (!body) return new URLSearchParams();
	if (body instanceof URLSearchParams) return body;
	if (typeof body === 'string') return new URLSearchParams(body);
	throw new Error('Unexpected body type in test.');
}

async function base64UrlSha256(input: string) {
	const bytes = new Uint8Array(
		await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input)),
	);
	let binary = '';
	for (let i = 0; i < bytes.byteLength; i += 1) {
		binary += String.fromCharCode(bytes[i] as number);
	}
	return btoa(binary)
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/u, '');
}

function setup({
	readCode = async () => 'CODE123',
	openBrowser = async () => {},
	fetchImpl,
}: {
	readCode?: () => Promise<string>;
	openBrowser?: (url: string) => Promise<void> | void;
	fetchImpl?: AuthFetch;
} = {}) {
	const printed: string[] = [];
	const tokenRequests: Array<{ url: string; body: URLSearchParams }> = [];
	const defaultFetch: AuthFetch = async (req, init) => {
		const url =
			typeof req === 'string'
				? req
				: req instanceof URL
					? req.toString()
					: req.url;
		tokenRequests.push({
			url,
			body: captureBody(init?.body ?? null),
		});
		return makeJsonResponse({
			access_token: 'a',
			refresh_token: 'r',
			expires_in: 3600,
			token_type: 'bearer',
		});
	};
	const launcher = createOobOAuthLauncher({
		baseURL: 'http://localhost:8787',
		clientId: 'epicenter-cli',
		fetch: fetchImpl ?? defaultFetch,
		now: () => NOW,
		print: (line) => printed.push(line),
		openBrowser,
		readCode,
	});
	return { launcher, printed, tokenRequests };
}

test('happy path returns a 3-field OAuthTokenGrant', async () => {
	const { launcher, printed, tokenRequests } = setup();
	const data = expectOk(await launcher.startSignIn());
	if (!data) throw new Error('Expected non-null token grant');
	expect(data).toEqual({
		accessToken: 'a',
		refreshToken: 'r',
		accessTokenExpiresAt: NOW + 3_600_000,
	});
	expect(tokenRequests).toHaveLength(1);
	const { url, body } = tokenRequests[0]!;
	expect(url).toBe('http://localhost:8787/auth/oauth2/token');
	expect(body.get('grant_type')).toBe('authorization_code');
	expect(body.get('code')).toBe('CODE123');
	expect(body.get('code_verifier')).toBeTruthy();
	expect(body.get('client_id')).toBe('epicenter-cli');
	expect(body.get('redirect_uri')).toBe(
		'http://localhost:8787/auth/cli-callback',
	);
	expect(body.get('resource')).toBe('http://localhost:8787');
	expect(printed[0]).toContain('/auth/oauth2/authorize');
});

test('PKCE verifier and challenge are linked', async () => {
	const printed: string[] = [];
	let receivedVerifier: string | null = null;
	const launcher = createOobOAuthLauncher({
		baseURL: 'http://localhost:8787',
		clientId: 'epicenter-cli',
		fetch: async (_input, init) => {
			const body = captureBody(init?.body ?? null);
			receivedVerifier = body.get('code_verifier');
			return makeJsonResponse({
				access_token: 'a',
				refresh_token: 'r',
				expires_in: 3600,
				token_type: 'bearer',
			});
		},
		now: () => NOW,
		print: (line) => printed.push(line),
		openBrowser: async () => {},
		readCode: async () => 'CODE',
	});
	expectOk(await launcher.startSignIn());
	expect(receivedVerifier).toBeTruthy();
	const urlLine = printed[0];
	expect(urlLine).toBeDefined();
	const url = new URL(urlLine!);
	expect(url.searchParams.get('state')).toBeNull();
	const challenge = url.searchParams.get('code_challenge');
	const method = url.searchParams.get('code_challenge_method');
	expect(method).toBe('S256');
	if (!receivedVerifier) throw new Error('Expected PKCE verifier.');
	expect(challenge).toBe(await base64UrlSha256(receivedVerifier));
});

test('cancellation: empty paste returns Err(AuthorizationCancelled) and no network', async () => {
	let fetched = false;
	const { launcher } = setup({
		readCode: async () => '   ',
		fetchImpl: async () => {
			fetched = true;
			return new Response(null, { status: 500 });
		},
	});
	const err = expectErr(await launcher.startSignIn()) as { name?: string };
	expect(fetched).toBe(false);
	expect(err.name).toBe('AuthorizationCancelled');
});

test('invalid token_type returns Err(InvalidTokenResponse)', async () => {
	const { launcher } = setup({
		fetchImpl: async () =>
			makeJsonResponse({
				access_token: 'a',
				refresh_token: 'r',
				expires_in: 3600,
				token_type: 'mac',
			}),
	});
	const err = expectErr(await launcher.startSignIn()) as { name?: string };
	expect(err.name).toBe('InvalidTokenResponse');
});

test('server 400 returns Err(TokenExchangeFailed) with status + body', async () => {
	const { launcher } = setup({
		fetchImpl: async () =>
			new Response(JSON.stringify({ error: 'invalid_grant' }), {
				status: 400,
				headers: { 'content-type': 'application/json' },
			}),
	});
	const err = expectErr(await launcher.startSignIn()) as {
		name?: string;
		status?: number;
		body?: string;
	};
	expect(err.name).toBe('TokenExchangeFailed');
	expect(err.status).toBe(400);
	expect(err.body).toContain('invalid_grant');
});

test('openBrowser failure does not abort the flow', async () => {
	const { launcher } = setup({
		openBrowser: async () => {
			throw new Error('no browser available');
		},
	});
	const data = expectOk(await launcher.startSignIn());
	if (!data) throw new Error('Expected non-null token grant');
	expect(data.accessToken).toBe('a');
});

test('case-insensitive token_type check', async () => {
	const { launcher } = setup({
		fetchImpl: async () =>
			makeJsonResponse({
				access_token: 'a',
				refresh_token: 'r',
				expires_in: 3600,
				token_type: 'Bearer',
			}),
	});
	const data = expectOk(await launcher.startSignIn());
	if (!data) throw new Error('Expected non-null token grant');
	expect(data.accessToken).toBe('a');
});
