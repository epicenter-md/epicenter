import { expect, test } from 'bun:test';
import {
	buildAuthorizeUrl,
	createOAuthStateValue,
	createTikTokOAuthClient,
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
	scope: 'user.info.basic,user.info.profile,video.publish',
};

test('the authorize URL carries exactly the documented web parameters', () => {
	const url = new URL(
		buildAuthorizeUrl({
			clientKey: 'client-key-123',
			redirectUri: 'https://api.epicenter.so/api/integrations/tiktok/callback',
			scopes: ['user.info.basic', 'video.publish'],
			state: 'state-xyz',
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
	expect(url.searchParams.get('redirect_uri')).toBe(
		'https://api.epicenter.so/api/integrations/tiktok/callback',
	);

	// NO PKCE. TikTok's Login Kit for Web authorize contract lists client_key,
	// scope, response_type, redirect_uri, state and optional disable_auto_auth;
	// code_challenge is documented for the Desktop/mobile PUBLIC clients. This is
	// a confidential client whose secret authenticates the exchange, so sending
	// undocumented parameters would be hopeful at best and rejected at worst.
	expect(url.searchParams.get('code_challenge')).toBeNull();
	expect(url.searchParams.get('code_challenge_method')).toBeNull();

	// Nothing beyond the documented set is sent.
	expect([...url.searchParams.keys()].sort()).toEqual([
		'client_key',
		'redirect_uri',
		'response_type',
		'scope',
		'state',
	]);
});

test('disable_auto_auth is opt-in and appears only when asked for', () => {
	const withoutFlag = new URL(
		buildAuthorizeUrl({
			clientKey: 'ck',
			redirectUri: 'https://x/cb',
			scopes: ['user.info.basic'],
			state: 's',
		}),
	);
	expect(withoutFlag.searchParams.get('disable_auto_auth')).toBeNull();

	// Set when connecting, so a creator adding a SECOND account is shown consent
	// instead of being silently re-authorized back into the first one.
	const withFlag = new URL(
		buildAuthorizeUrl({
			clientKey: 'ck',
			redirectUri: 'https://x/cb',
			scopes: ['user.info.basic'],
			state: 's',
			disableAutoAuth: true,
		}),
	);
	expect(withFlag.searchParams.get('disable_auto_auth')).toBe('1');
});

test('state values are unguessable and unique per ceremony', () => {
	// With no PKCE, `state` carries the whole CSRF and session-fixation defense,
	// so uniqueness and entropy are load-bearing rather than incidental.
	const states = new Set(
		Array.from({ length: 100 }, () => createOAuthStateValue()),
	);

	expect(states.size).toBe(100);
	for (const state of states) {
		expect(state.length).toBeGreaterThanOrEqual(43);
		expect(state).toMatch(/^[A-Za-z0-9_-]+$/);
	}
});

test('exchangeCode posts exactly the documented web exchange body', async () => {
	const { send, calls } = recordingFetch(() => jsonResponse(GRANT_BODY));
	const oauth = createTikTokOAuthClient({
		clientKey: 'ck',
		clientSecret: 'cs',
		fetch: send,
	});

	const { data, error } = await oauth.exchangeCode({
		code: 'auth-code',
		redirectUri: 'https://api.epicenter.so/api/integrations/tiktok/callback',
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
		'user.info.profile',
		'video.publish',
	]);

	const call = calls[0];
	expect(call?.url).toBe('https://open.tiktokapis.com/v2/oauth/token/');
	expect(call?.form.get('grant_type')).toBe('authorization_code');
	expect(call?.form.get('client_key')).toBe('ck');
	expect(call?.form.get('client_secret')).toBe('cs');
	expect(call?.form.get('redirect_uri')).toBe(
		'https://api.epicenter.so/api/integrations/tiktok/callback',
	);
	// No code_verifier: TikTok's web token exchange does not specify one.
	expect(call?.form.get('code_verifier')).toBeNull();
	expect([...(call?.form.keys() ?? [])].sort()).toEqual([
		'client_key',
		'client_secret',
		'code',
		'grant_type',
		'redirect_uri',
	]);
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
