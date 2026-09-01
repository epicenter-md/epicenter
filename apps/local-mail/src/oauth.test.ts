/**
 * The authorization-code and PKCE flow, without a browser and without a
 * loopback server.
 *
 * What is pinned here: the consent URL asks for the mailbox and the identity,
 * the exchange authenticates with form parameters rather than a header, the
 * account is identified by Google's stable subject rather than its address, a
 * grant with no refresh token is refused rather than stored, and a revoked
 * grant asks for re-consent instead of a retry.
 */

import { expect, test } from 'bun:test';
import { DEFAULT_MAIL_CONFIG, type MailConfig } from './config.ts';
import {
	beginAuthorization,
	completeAuthorization,
	refreshAccess,
} from './oauth.ts';

const IDENTITY = { clientId: 'client-id-123', clientSecret: 'client-secret-456' };
const REDIRECT = 'http://127.0.0.1:39130/apps/mail/connected';
const NOW = () => Date.parse('2026-07-01T00:00:00.000Z');

function config(overrides: Partial<MailConfig> = {}): MailConfig {
	return {
		...DEFAULT_MAIL_CONFIG,
		authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
		...overrides,
	};
}

/**
 * An id_token the way a client reads one back from the token endpoint.
 *
 * Unsigned on purpose. OpenID Connect lets a client that obtained the token
 * directly from the token endpoint skip signature validation, which is exactly
 * this flow, so what a test has to get right is the claim set.
 *
 * `exp` is anchored to the wall clock rather than to `NOW`, because the library
 * checks it against the real one. `NOW` is the application's injected clock and
 * governs only what the returned expiry reads as.
 */
function idToken(claims: Record<string, unknown>): string {
	const encode = (value: unknown) =>
		Buffer.from(JSON.stringify(value)).toString('base64url');
	const issued = Math.floor(Date.now() / 1000);
	return `${encode({ alg: 'RS256' })}.${encode({
		iss: 'https://accounts.google.com',
		aud: IDENTITY.clientId,
		exp: issued + 3600,
		iat: issued,
		...claims,
	})}.signature`;
}

function tokenServer(
	handler: (request: Request) => Response | Promise<Response>,
) {
	return Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handler });
}

/** The URL Google would send the person back to, given a consent URL. */
function callbackFor(authorizeUrl: string, code = 'auth-code-123'): URL {
	const state = new URL(authorizeUrl).searchParams.get('state') ?? '';
	const callback = new URL(REDIRECT);
	callback.searchParams.set('code', code);
	callback.searchParams.set('state', state);
	return callback;
}

test('the consent URL asks for the mailbox and the identity', async () => {
	const request = await beginAuthorization({
		config: config(),
		identity: IDENTITY,
		redirectUri: REDIRECT,
	});
	const url = new URL(request.authorizeUrl);

	expect(url.searchParams.get('scope')).toBe(
		'https://www.googleapis.com/auth/gmail.modify openid email',
	);
	expect(url.searchParams.get('code_challenge_method')).toBe('S256');
	// Without both of these Google returns no refresh token on a reconnect, and
	// background synchronization stops at the first expiry.
	expect(url.searchParams.get('access_type')).toBe('offline');
	expect(url.searchParams.get('prompt')).toBe('consent');
	expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
	expect(request.codeVerifier.length).toBeGreaterThan(20);
});

test('the account is identified by Googles subject, and the address is metadata', async () => {
	const bodies: URLSearchParams[] = [];
	const authHeaders: (string | null)[] = [];
	const server = tokenServer(async (request) => {
		bodies.push(new URLSearchParams(await request.text()));
		authHeaders.push(request.headers.get('authorization'));
		return Response.json({
			token_type: 'Bearer',
			access_token: 'access-token-123',
			refresh_token: 'refresh-token-123',
			expires_in: 3600,
			id_token: idToken({ sub: 'google-sub-1', email: 'you@example.com' }),
		});
	});
	const settings = config({ tokenUrl: `http://127.0.0.1:${server.port}/token` });
	const request = await beginAuthorization({
		config: settings,
		identity: IDENTITY,
		redirectUri: REDIRECT,
	});

	const result = await completeAuthorization({
		config: settings,
		identity: IDENTITY,
		request,
		callbackUrl: callbackFor(request.authorizeUrl),
		now: NOW,
	});

	expect(result.error).toBeNull();
	expect(result.data).toEqual({
		providerAccountId: 'google-sub-1',
		email: 'you@example.com',
		refreshToken: 'refresh-token-123',
		accessToken: 'access-token-123',
		accessTokenExpiresAt: '2026-07-01T01:00:00.000Z',
	});
	expect(bodies[0]?.get('client_id')).toBe(IDENTITY.clientId);
	expect(bodies[0]?.get('client_secret')).toBe(IDENTITY.clientSecret);
	expect(bodies[0]?.get('code_verifier')).toBe(request.codeVerifier);
	expect(authHeaders[0]).toBeNull();
	server.stop(true);
});

test('a grant with no refresh token is refused rather than stored', async () => {
	// Nothing could sync later, so connecting has to fail here rather than
	// succeed and go quiet at the first expiry.
	const server = tokenServer(() =>
		Response.json({
			token_type: 'Bearer',
			access_token: 'access-token-123',
			expires_in: 3600,
			id_token: idToken({ sub: 'google-sub-1', email: 'you@example.com' }),
		}),
	);
	const settings = config({ tokenUrl: `http://127.0.0.1:${server.port}/token` });
	const request = await beginAuthorization({
		config: settings,
		identity: IDENTITY,
		redirectUri: REDIRECT,
	});

	const result = await completeAuthorization({
		config: settings,
		identity: IDENTITY,
		request,
		callbackUrl: callbackFor(request.authorizeUrl),
		now: NOW,
	});

	expect(result.error?.name).toBe('IdentityMissing');
	expect(result.error?.message).toContain('refresh token');
	server.stop(true);
});

test('a denied authorization is reported as denial, not as a transport failure', async () => {
	const settings = config();
	const request = await beginAuthorization({
		config: settings,
		identity: IDENTITY,
		redirectUri: REDIRECT,
	});
	const callback = new URL(REDIRECT);
	callback.searchParams.set('error', 'access_denied');
	callback.searchParams.set('state', request.state);

	const result = await completeAuthorization({
		config: settings,
		identity: IDENTITY,
		request,
		callbackUrl: callback,
		now: NOW,
	});

	expect(result.error?.name).toBe('AuthorizationDenied');
});

test('refreshing keeps the token Google did not rotate', async () => {
	const server = tokenServer(() =>
		Response.json({
			token_type: 'Bearer',
			access_token: 'fresh-access-token',
			expires_in: 3600,
		}),
	);
	const result = await refreshAccess({
		config: config({ tokenUrl: `http://127.0.0.1:${server.port}/token` }),
		identity: IDENTITY,
		refreshToken: 'refresh-token-123',
		now: NOW,
	});

	expect(result.data).toEqual({
		accessToken: 'fresh-access-token',
		accessTokenExpiresAt: '2026-07-01T01:00:00.000Z',
		refreshToken: 'refresh-token-123',
	});
	server.stop(true);
});

test('a revoked grant asks for re-consent', async () => {
	const server = tokenServer(() =>
		Response.json(
			{ error: 'invalid_grant', error_description: 'Token has been expired.' },
			{ status: 400 },
		),
	);
	const result = await refreshAccess({
		config: config({ tokenUrl: `http://127.0.0.1:${server.port}/token` }),
		identity: IDENTITY,
		refreshToken: 'refresh-token-123',
		now: NOW,
	});

	expect(result.error?.name).toBe('ReauthRequired');
	server.stop(true);
});
