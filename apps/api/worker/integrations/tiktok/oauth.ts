/**
 * TikTok Login Kit OAuth mechanics: authorize URL, code exchange, refresh, revoke.
 *
 * Deliberately concrete. There is no provider-neutral OAuth abstraction here
 * because TikTok is not a neutral OAuth server:
 *
 * - The public credential is `client_key`, not `client_id`, on every endpoint.
 * - Scopes are COMMA-separated, not space-separated.
 * - `/v2/oauth/token/` answers a FLAT OAuth body (`{ access_token, ... }` or
 *   `{ error, error_description }`), unlike the rest of the v2 API, which wraps
 *   everything in a `{ data, error: { code: 'ok' } }` envelope.
 * - The refresh token ROTATES: every exchange may return a different one, and
 *   the replacement must be persisted or the grant is lost.
 *
 * Nothing in this module persists anything. It performs exchanges and returns
 * what TikTok said; `tokens.ts` owns custody and rotation.
 */

import { defineErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';

const AUTHORIZE_URL = 'https://www.tiktok.com/v2/auth/authorize/';
const TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const REVOKE_URL = 'https://open.tiktokapis.com/v2/oauth/revoke/';

export const TikTokOAuthError = defineErrors({
	/** The network call itself failed, or the body was not JSON. */
	RequestFailed: ({
		endpoint,
		reason,
	}: {
		endpoint: string;
		reason: string;
	}) => ({
		message: `TikTok ${endpoint} request failed: ${reason}`,
		endpoint,
		reason,
	}),
	/** TikTok answered with its flat OAuth error body. */
	ProviderRejected: ({
		endpoint,
		code,
		description,
		logId,
	}: {
		endpoint: string;
		code: string;
		description: string;
		logId?: string;
	}) => ({
		message: `TikTok ${endpoint} rejected the request: ${description} (${code})`,
		endpoint,
		code,
		description,
		logId,
	}),
	/** A 2xx body that is missing a field the grant cannot work without. */
	MalformedResponse: ({
		endpoint,
		field,
	}: {
		endpoint: string;
		field: string;
	}) => ({
		message: `TikTok ${endpoint} response is missing ${field}.`,
		endpoint,
		field,
	}),
});
export type TikTokOAuthError = import('wellcrafted/error').InferErrors<
	typeof TikTokOAuthError
>;

/** A complete token grant, exactly as TikTok reported it. */
export type TikTokTokenGrant = {
	accessToken: string;
	/** Seconds from now. TikTok's access tokens live 24h. */
	expiresInSec: number;
	refreshToken: string;
	/** Seconds from now. TikTok's refresh tokens live up to 365 days. */
	refreshExpiresInSec: number;
	openId: string;
	/** The scopes TikTok actually GRANTED, which may be narrower than requested. */
	scopes: readonly string[];
};

function toBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}

/** A 32-byte PKCE verifier, base64url-encoded (43 chars, within RFC 7636's 43-128). */
export function createCodeVerifier(): string {
	return toBase64Url(
		crypto.getRandomValues(new Uint8Array(new ArrayBuffer(32))),
	);
}

/** An opaque, unguessable OAuth `state`. */
export function createOAuthStateValue(): string {
	return toBase64Url(
		crypto.getRandomValues(new Uint8Array(new ArrayBuffer(32))),
	);
}

/** The S256 challenge for a verifier. TikTok supports PKCE on the web flow. */
export async function deriveCodeChallenge(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(verifier),
	);
	return toBase64Url(new Uint8Array(digest));
}

/**
 * Where the creator is sent to authorize. Scopes are comma-joined because that
 * is what TikTok parses; a space-joined list is silently read as one unknown
 * scope and the consent screen comes back empty.
 */
export function buildAuthorizeUrl({
	clientKey,
	redirectUri,
	scopes,
	state,
	codeChallenge,
}: {
	clientKey: string;
	redirectUri: string;
	scopes: readonly string[];
	state: string;
	codeChallenge: string;
}): string {
	const url = new URL(AUTHORIZE_URL);
	url.searchParams.set('client_key', clientKey);
	url.searchParams.set('scope', scopes.join(','));
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('redirect_uri', redirectUri);
	url.searchParams.set('state', state);
	url.searchParams.set('code_challenge', codeChallenge);
	url.searchParams.set('code_challenge_method', 'S256');
	return url.toString();
}

/**
 * Read TikTok's flat OAuth body. The client secret is in the REQUEST, never the
 * response, and no error path here echoes the request body, so a leaked log
 * cannot leak the credential.
 */
async function readTokenResponse(
	endpoint: string,
	response: Response,
): Promise<Result<Record<string, unknown>, TikTokOAuthError>> {
	let body: unknown = null;
	try {
		body = await response.json();
	} catch {
		return TikTokOAuthError.RequestFailed({
			endpoint,
			reason: `HTTP ${response.status} with an unreadable body`,
		});
	}
	if (typeof body !== 'object' || body === null) {
		return TikTokOAuthError.RequestFailed({
			endpoint,
			reason: `HTTP ${response.status} with a non-object body`,
		});
	}
	const fields = body as Record<string, unknown>;
	// TikTok signals failure with a flat `error` string. It also returns
	// `error: ''` on some successful bodies, so emptiness is success.
	const errorCode = typeof fields.error === 'string' ? fields.error : '';
	if (!response.ok || errorCode.length > 0) {
		return TikTokOAuthError.ProviderRejected({
			endpoint,
			code: errorCode.length > 0 ? errorCode : `http_${response.status}`,
			description:
				typeof fields.error_description === 'string' &&
				fields.error_description.length > 0
					? fields.error_description
					: `HTTP ${response.status}`,
			...(typeof fields.log_id === 'string' ? { logId: fields.log_id } : {}),
		});
	}
	return Ok(fields);
}

function readGrant(
	endpoint: string,
	fields: Record<string, unknown>,
): Result<TikTokTokenGrant, TikTokOAuthError> {
	const string = (key: string): string | null =>
		typeof fields[key] === 'string' && (fields[key] as string).length > 0
			? (fields[key] as string)
			: null;
	const number = (key: string): number | null =>
		typeof fields[key] === 'number' && Number.isFinite(fields[key])
			? (fields[key] as number)
			: null;

	const accessToken = string('access_token');
	if (!accessToken) {
		return TikTokOAuthError.MalformedResponse({
			endpoint,
			field: 'access_token',
		});
	}
	const refreshToken = string('refresh_token');
	if (!refreshToken) {
		return TikTokOAuthError.MalformedResponse({
			endpoint,
			field: 'refresh_token',
		});
	}
	const openId = string('open_id');
	if (!openId) {
		return TikTokOAuthError.MalformedResponse({ endpoint, field: 'open_id' });
	}
	const expiresInSec = number('expires_in');
	if (expiresInSec === null) {
		return TikTokOAuthError.MalformedResponse({
			endpoint,
			field: 'expires_in',
		});
	}
	const refreshExpiresInSec = number('refresh_expires_in');
	if (refreshExpiresInSec === null) {
		return TikTokOAuthError.MalformedResponse({
			endpoint,
			field: 'refresh_expires_in',
		});
	}
	// `scope` is a comma-separated list of what was GRANTED. A grant with no
	// scope is possible only if the creator declined everything, which is a
	// usable-but-empty connection the caller decides what to do with.
	const scopes = (string('scope') ?? '')
		.split(',')
		.map((entry) => entry.trim())
		.filter(Boolean);

	return Ok({
		accessToken,
		expiresInSec,
		refreshToken,
		refreshExpiresInSec,
		openId,
		scopes,
	});
}

async function postForm(
	url: string,
	endpoint: string,
	form: Record<string, string>,
	send: typeof globalThis.fetch,
): Promise<Result<Record<string, unknown>, TikTokOAuthError>> {
	let response: Response;
	try {
		response = await send(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				'Cache-Control': 'no-cache',
			},
			body: new URLSearchParams(form).toString(),
		});
	} catch (cause) {
		return TikTokOAuthError.RequestFailed({
			endpoint,
			reason: cause instanceof Error ? cause.message : 'network failure',
		});
	}
	return readTokenResponse(endpoint, response);
}

export type TikTokOAuthClient = ReturnType<typeof createTikTokOAuthClient>;

export function createTikTokOAuthClient({
	clientKey,
	clientSecret,
	fetch: send = globalThis.fetch,
}: {
	clientKey: string;
	clientSecret: string;
	fetch?: typeof globalThis.fetch;
}) {
	return {
		/** Exchange an authorization code (plus its PKCE verifier) for a grant. */
		async exchangeCode({
			code,
			redirectUri,
			codeVerifier,
		}: {
			code: string;
			redirectUri: string;
			codeVerifier: string;
		}): Promise<Result<TikTokTokenGrant, TikTokOAuthError>> {
			const endpoint = 'oauth/token (authorization_code)';
			const { data, error } = await postForm(
				TOKEN_URL,
				endpoint,
				{
					client_key: clientKey,
					client_secret: clientSecret,
					code,
					grant_type: 'authorization_code',
					redirect_uri: redirectUri,
					code_verifier: codeVerifier,
				},
				send,
			);
			if (error) return { data: null, error };
			return readGrant(endpoint, data);
		},

		/**
		 * Exchange a refresh token for a new grant. The returned `refreshToken` may
		 * differ from the one sent; persisting the replacement is the caller's
		 * obligation and the reason `tokens.ts` serializes this call.
		 */
		async refresh(
			refreshToken: string,
		): Promise<Result<TikTokTokenGrant, TikTokOAuthError>> {
			const endpoint = 'oauth/token (refresh_token)';
			const { data, error } = await postForm(
				TOKEN_URL,
				endpoint,
				{
					client_key: clientKey,
					client_secret: clientSecret,
					grant_type: 'refresh_token',
					refresh_token: refreshToken,
				},
				send,
			);
			if (error) return { data: null, error };
			return readGrant(endpoint, data);
		},

		/**
		 * Ask TikTok to revoke the grant. Revocation is the PROVIDER's fact; the
		 * caller must not present a failure here as a successful disconnect.
		 */
		async revoke(accessToken: string): Promise<Result<null, TikTokOAuthError>> {
			const { error } = await postForm(
				REVOKE_URL,
				'oauth/revoke',
				{
					client_key: clientKey,
					client_secret: clientSecret,
					token: accessToken,
				},
				send,
			);
			if (error) return { data: null, error };
			return Ok(null);
		},
	};
}
