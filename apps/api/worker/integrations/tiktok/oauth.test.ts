import { expect, test } from 'bun:test';
import {
	buildAuthorizeUrl,
	createCodeVerifier,
	createOAuthStateValue,
	createTikTokOAuthClient,
	deriveCodeChallenge,
} from './oauth.js';

/** A fetch stand-in that records what it was called with. */
function recordingFetch(
	respond: (request: { url: string; form: URLSearchParams }) => Response,
) {
	const calls: { url: string; form: URLSearchParams }[] = [];
	const send = (async (input: string | URL, init?: RequestInit) => {
		const call = {
			url: String(input),
			form: new URLSearchParams(String(init?.body ?? '')),
		};
		calls.push(call);
		return respond(call);
	}) as unknown as typeof globalThis.fetch;
	return { send, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}

const GRANT_BODY = {
	access_token: 'act.fresh',
	expires_in: 86_400,
	refresh_token: 'rft.fresh',
	refresh_expires_in: 31_536_000,
	open_id: 'open-abc',
	scope: 'user.info.basic,video.list,video.upload,video.publish',
};

test('the authorize URL comma-joins scopes and carries PKCE', async () => {
	const verifier = createCodeVerifier();
	const challenge = await deriveCodeChallenge(verifier);

	const url = new URL(
		buildAuthorizeUrl({
			clientKey: 'client-key-123',
			redirectUri: 'https://api.epicenter.so/api/integrations/tiktok/callback',
			scopes: ['user.info.basic', 'video.publish'],
			state: 'state-xyz',
			codeChallenge: challenge,
		}),
	);

	expect(url.origin + url.pathname).toBe(
		'https://www.tiktok.com/v2/auth/authorize/',
	);
	// TikTok parses scopes as a COMMA-separated list; a space-joined list reads
	// as one unknown scope and the consent screen comes back empty.
	expect(url.searchParams.get('scope')).toBe('user.info.basic,video.publish');
	// The public credential is `client_key`, not `client_id`.
	expect(url.searchParams.get('client_key')).toBe('client-key-123');
	expect(url.searchParams.get('client_id')).toBeNull();
	expect(url.searchParams.get('response_type')).toBe('code');
	expect(url.searchParams.get('state')).toBe('state-xyz');
	expect(url.searchParams.get('code_challenge')).toBe(challenge);
	expect(url.searchParams.get('code_challenge_method')).toBe('S256');
	// The verifier itself must never leave the server.
	expect(url.toString()).not.toContain(verifier);
});

test('state values and PKCE verifiers are unguessable and unique per ceremony', () => {
	const states = new Set(
		Array.from({ length: 50 }, () => createOAuthStateValue()),
	);
	const verifiers = new Set(
		Array.from({ length: 50 }, () => createCodeVerifier()),
	);

	expect(states.size).toBe(50);
	expect(verifiers.size).toBe(50);
	// RFC 7636 requires a 43-128 character verifier.
	for (const verifier of verifiers) {
		expect(verifier.length).toBeGreaterThanOrEqual(43);
		expect(verifier.length).toBeLessThanOrEqual(128);
	}
});

test('exchangeCode posts the client secret and PKCE verifier, and reads the grant', async () => {
	const { send, calls } = recordingFetch(() => jsonResponse(GRANT_BODY));
	const oauth = createTikTokOAuthClient({
		clientKey: 'ck',
		clientSecret: 'cs',
		fetch: send,
	});

	const { data, error } = await oauth.exchangeCode({
		code: 'auth-code',
		redirectUri: 'https://api.epicenter.so/api/integrations/tiktok/callback',
		codeVerifier: 'verifier-value',
	});

	expect(error).toBeNull();
	expect(data).toMatchObject({
		accessToken: 'act.fresh',
		refreshToken: 'rft.fresh',
		openId: 'open-abc',
		expiresInSec: 86_400,
		refreshExpiresInSec: 31_536_000,
	});
	// The GRANTED scopes are parsed from the comma-separated `scope` string.
	expect(data?.scopes).toEqual([
		'user.info.basic',
		'video.list',
		'video.upload',
		'video.publish',
	]);

	const call = calls[0];
	expect(call?.url).toBe('https://open.tiktokapis.com/v2/oauth/token/');
	expect(call?.form.get('grant_type')).toBe('authorization_code');
	expect(call?.form.get('client_key')).toBe('ck');
	expect(call?.form.get('client_secret')).toBe('cs');
	expect(call?.form.get('code_verifier')).toBe('verifier-value');
});

test('a partial consent is reported as the narrower granted scope set', async () => {
	const { send } = recordingFetch(() =>
		jsonResponse({ ...GRANT_BODY, scope: 'user.info.basic' }),
	);
	const oauth = createTikTokOAuthClient({
		clientKey: 'ck',
		clientSecret: 'cs',
		fetch: send,
	});

	const { data } = await oauth.exchangeCode({
		code: 'c',
		redirectUri: 'https://x/cb',
		codeVerifier: 'v',
	});

	// Requested four, granted one. The caller must store what was GRANTED.
	expect(data?.scopes).toEqual(['user.info.basic']);
});

test("TikTok's flat OAuth error body becomes a named provider rejection", async () => {
	const { send } = recordingFetch(() =>
		jsonResponse(
			{
				error: 'invalid_grant',
				error_description: 'Authorization code is expired.',
				log_id: 'log-1',
			},
			400,
		),
	);
	const oauth = createTikTokOAuthClient({
		clientKey: 'ck',
		clientSecret: 'cs',
		fetch: send,
	});

	const { data, error } = await oauth.exchangeCode({
		code: 'stale',
		redirectUri: 'https://x/cb',
		codeVerifier: 'v',
	});

	expect(data).toBeNull();
	expect(error?.name).toBe('ProviderRejected');
	expect(error).toMatchObject({ code: 'invalid_grant', logId: 'log-1' });
	expect(error?.message).toContain('Authorization code is expired.');
});

test('an error body returned with HTTP 200 is still a failure', async () => {
	// TikTok has been observed answering 200 with a populated `error` field.
	const { send } = recordingFetch(() =>
		jsonResponse(
			{ error: 'invalid_client', error_description: 'bad key' },
			200,
		),
	);
	const oauth = createTikTokOAuthClient({
		clientKey: 'ck',
		clientSecret: 'cs',
		fetch: send,
	});

	const { error } = await oauth.exchangeCode({
		code: 'c',
		redirectUri: 'https://x/cb',
		codeVerifier: 'v',
	});

	expect(error?.name).toBe('ProviderRejected');
});

test('an empty `error` string on a success body is treated as success', async () => {
	const { send } = recordingFetch(() =>
		jsonResponse({ ...GRANT_BODY, error: '' }),
	);
	const oauth = createTikTokOAuthClient({
		clientKey: 'ck',
		clientSecret: 'cs',
		fetch: send,
	});

	const { data, error } = await oauth.exchangeCode({
		code: 'c',
		redirectUri: 'https://x/cb',
		codeVerifier: 'v',
	});

	expect(error).toBeNull();
	expect(data?.accessToken).toBe('act.fresh');
});

test('a 2xx grant missing refresh_token is refused rather than half-stored', async () => {
	const { refresh_token: _dropped, ...withoutRefresh } = GRANT_BODY;
	const { send } = recordingFetch(() => jsonResponse(withoutRefresh));
	const oauth = createTikTokOAuthClient({
		clientKey: 'ck',
		clientSecret: 'cs',
		fetch: send,
	});

	const { data, error } = await oauth.exchangeCode({
		code: 'c',
		redirectUri: 'https://x/cb',
		codeVerifier: 'v',
	});

	expect(data).toBeNull();
	expect(error?.name).toBe('MalformedResponse');
	expect(error).toMatchObject({ field: 'refresh_token' });
});

test('refresh sends grant_type=refresh_token and surfaces the ROTATED refresh token', async () => {
	const { send, calls } = recordingFetch(() =>
		jsonResponse({
			...GRANT_BODY,
			access_token: 'act.rotated',
			// TikTok rotates: the replacement differs from what was sent.
			refresh_token: 'rft.rotated',
		}),
	);
	const oauth = createTikTokOAuthClient({
		clientKey: 'ck',
		clientSecret: 'cs',
		fetch: send,
	});

	const { data, error } = await oauth.refresh('rft.old');

	expect(error).toBeNull();
	expect(data?.accessToken).toBe('act.rotated');
	expect(data?.refreshToken).toBe('rft.rotated');
	expect(data?.refreshToken).not.toBe('rft.old');
	expect(calls[0]?.form.get('grant_type')).toBe('refresh_token');
	expect(calls[0]?.form.get('refresh_token')).toBe('rft.old');
});

test('a network failure is a named request failure, not a thrown error', async () => {
	const send = (async () => {
		throw new Error('connection reset');
	}) as unknown as typeof globalThis.fetch;
	const oauth = createTikTokOAuthClient({
		clientKey: 'ck',
		clientSecret: 'cs',
		fetch: send,
	});

	const { data, error } = await oauth.refresh('rft');

	expect(data).toBeNull();
	expect(error?.name).toBe('RequestFailed');
	expect(error?.message).toContain('connection reset');
});

test('revoke posts the token and reports provider failure honestly', async () => {
	const { send, calls } = recordingFetch(() => jsonResponse({}));
	const ok = createTikTokOAuthClient({
		clientKey: 'ck',
		clientSecret: 'cs',
		fetch: send,
	});
	const { error: noError } = await ok.revoke('act.live');
	expect(noError).toBeNull();
	expect(calls[0]?.url).toBe('https://open.tiktokapis.com/v2/oauth/revoke/');
	expect(calls[0]?.form.get('token')).toBe('act.live');

	const { send: failing } = recordingFetch(() =>
		jsonResponse({ error: 'invalid_request', error_description: 'nope' }, 400),
	);
	const failed = createTikTokOAuthClient({
		clientKey: 'ck',
		clientSecret: 'cs',
		fetch: failing,
	});
	const { error } = await failed.revoke('act.live');
	expect(error?.name).toBe('ProviderRejected');
});

test('no error message ever echoes the client secret', async () => {
	const { send } = recordingFetch(() =>
		jsonResponse({ error: 'invalid_client', error_description: 'bad' }, 401),
	);
	const oauth = createTikTokOAuthClient({
		clientKey: 'ck',
		clientSecret: 'TOP-SECRET-VALUE',
		fetch: send,
	});

	const { error } = await oauth.refresh('rft');

	expect(JSON.stringify(error)).not.toContain('TOP-SECRET-VALUE');
});
