import { OAUTH_ROUTES } from '@epicenter/constants/oauth-routes';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, type Result, tryAsync } from 'wellcrafted/result';
import type { AuthFetch } from './auth-contract.js';
import type { OAuthTokenGrant } from './auth-types.js';

/**
 * Shape-level failures rejecting an OAuth token endpoint payload before it
 * becomes a persisted grant. Each variant maps to one invariant in
 * {@link parseOAuthTokenGrant}: missing or non-string fields, a wrong
 * `token_type`, or a non-object payload.
 */
const OAuthTokenResponseError = defineErrors({
	InvalidResponse: () => ({
		message: 'Expected OAuth token response to be an object.',
	}),
	InvalidTokenType: ({ tokenType }: { tokenType: unknown }) => ({
		message: `Expected token_type to be bearer, got ${JSON.stringify(tokenType)}.`,
		tokenType,
	}),
	MissingAccessToken: () => ({
		message: 'Expected access_token to be a string.',
	}),
	MissingRefreshToken: () => ({
		message: 'Expected refresh_token to be a string.',
	}),
	MissingExpiresIn: () => ({
		message: 'Expected expires_in to be a positive finite number.',
	}),
});

type OAuthTokenResponseError = InferErrors<typeof OAuthTokenResponseError>;

/**
 * Normalize an OAuth token endpoint payload into Epicenter's persisted grant.
 *
 * Use this immediately after authorization-code and refresh-token exchanges.
 * It enforces the client-side token invariant before anything is written to
 * storage: grants must be bearer tokens with an access token, a refresh token
 * (or refresh fallback during rotation), and a positive `expires_in` value that
 * becomes an absolute refresh hint.
 *
 * `fallbackRefreshToken` is only for refresh-token rotation. Some OAuth servers
 * omit `refresh_token` when the existing refresh token remains valid; initial
 * authorization-code exchanges must not pass a fallback.
 */
export function parseOAuthTokenGrant(
	payload: unknown,
	{
		now,
		fallbackRefreshToken,
	}: {
		now: () => number;
		fallbackRefreshToken?: string;
	},
): Result<OAuthTokenGrant, OAuthTokenResponseError> {
	if (
		payload === null ||
		typeof payload !== 'object' ||
		Array.isArray(payload)
	) {
		return OAuthTokenResponseError.InvalidResponse();
	}
	const record = payload as Record<string, unknown>;
	const tokenType = record['token_type'];
	if (typeof tokenType !== 'string' || tokenType.toLowerCase() !== 'bearer') {
		return OAuthTokenResponseError.InvalidTokenType({ tokenType });
	}

	const accessToken = record['access_token'];
	if (typeof accessToken !== 'string') {
		return OAuthTokenResponseError.MissingAccessToken();
	}

	const refreshToken = record['refresh_token'];
	if (refreshToken != null && typeof refreshToken !== 'string') {
		return OAuthTokenResponseError.MissingRefreshToken();
	}
	const nextRefreshToken = refreshToken ?? fallbackRefreshToken;
	if (nextRefreshToken === undefined) {
		return OAuthTokenResponseError.MissingRefreshToken();
	}

	const expiresIn = record['expires_in'];
	if (
		typeof expiresIn !== 'number' ||
		!Number.isFinite(expiresIn) ||
		expiresIn <= 0
	) {
		return OAuthTokenResponseError.MissingExpiresIn();
	}

	return Ok({
		accessToken,
		refreshToken: nextRefreshToken,
		accessTokenExpiresAt: now() + expiresIn * 1000,
	});
}

/**
 * Exchange a refresh token at the OAuth token endpoint and normalize the
 * response into a fresh grant. Throws on a non-OK response or an invalid
 * payload; callers treat a throw as "refresh failed, pause network auth".
 */
/**
 * The four ways a refresh can fail, and only one of them means the credential
 * is dead.
 *
 * The distinction is the whole point of this type. `Rejected` is the only
 * variant that may pause network auth; every other one is a condition a later
 * attempt can survive. Collapsing them, which this endpoint used to do by
 * throwing a bare `Error` for all four, made a train tunnel indistinguishable
 * from a revoked token and dropped people to `reauth-required` for going
 * offline.
 *
 * Deliberately the same four names as {@link ApiSessionReadError}, because the
 * two are the same question asked of two endpoints and a reader should not
 * have to learn a second vocabulary to answer it.
 */
export const OAuthRefreshError = defineErrors({
	/** The `fetch` itself threw (network, DNS, CORS, offline). Retry later. */
	Unreachable: ({ cause }: { cause: unknown }) => ({
		message: `Could not reach the OAuth token endpoint: ${extractErrorMessage(cause)}`,
		cause,
	}),
	/**
	 * The server refused this grant, and only a new sign-in fixes it.
	 *
	 * RFC 6749 puts this at **400** with `error: "invalid_grant"`, not 401, so
	 * a status-only check would miss every revoked, expired, and reused refresh
	 * token there is. Verified against the provider: an unknown, expired,
	 * revoked, or wrong-client refresh token all answer
	 * `400 {"error":"invalid_grant"}`, and a bad client secret answers
	 * `invalid_client`.
	 */
	Rejected: ({ code, status }: { code: string; status: number }) => ({
		message: `The OAuth token endpoint refused the refresh (${status} ${code}).`,
		code,
		status,
	}),
	/** Some other non-ok status, a 5xx among them. The server, not the grant. */
	Unexpected: ({ status }: { status: number }) => ({
		message: `The OAuth token endpoint failed with ${status}.`,
		status,
	}),
	/** The body could not be read, or was not a usable grant. */
	Malformed: ({ cause }: { cause: unknown }) => ({
		message: `The OAuth token endpoint returned an unusable grant: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type OAuthRefreshError = InferErrors<typeof OAuthRefreshError>;

/** The OAuth error codes that mean this refresh token will never work again. */
const TERMINAL_OAUTH_ERRORS = new Set(['invalid_grant', 'invalid_client']);

/**
 * Read the OAuth error code out of a non-ok token response.
 *
 * Best effort by construction: a proxy or a gateway can answer a token request
 * with HTML, and an unreadable body is not evidence that a grant is dead. So
 * anything unparseable falls through to `Unexpected`, which retries, rather
 * than to `Rejected`, which signs someone out.
 */
async function refusalCode(response: Response): Promise<string | undefined> {
	try {
		const body: unknown = await response.json();
		if (typeof body !== 'object' || body === null) return undefined;
		const code = (body as { error?: unknown }).error;
		return typeof code === 'string' ? code : undefined;
	} catch {
		return undefined;
	}
}

export async function refreshOAuthTokenWithEndpoint({
	baseURL,
	clientId,
	grant,
	fetch,
	now,
}: {
	baseURL: string;
	clientId: string;
	grant: OAuthTokenGrant;
	fetch: AuthFetch;
	now: () => number;
}): Promise<Result<OAuthTokenGrant, OAuthRefreshError>> {
	const body = new URLSearchParams({
		grant_type: 'refresh_token',
		refresh_token: grant.refreshToken,
		client_id: clientId,
		resource: baseURL,
	});
	let response: Response;
	try {
		response = await fetch(OAUTH_ROUTES.token.url(baseURL), {
			method: 'POST',
			body,
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			credentials: 'omit',
		});
	} catch (cause) {
		return OAuthRefreshError.Unreachable({ cause });
	}
	if (!response.ok) {
		const code = await refusalCode(response);
		if (code !== undefined && TERMINAL_OAUTH_ERRORS.has(code)) {
			return OAuthRefreshError.Rejected({ code, status: response.status });
		}
		return OAuthRefreshError.Unexpected({ status: response.status });
	}
	return tryAsync({
		try: async () => {
			const data = await response.json();
			const { data: parsed, error } = parseOAuthTokenGrant(data, {
				now,
				fallbackRefreshToken: grant.refreshToken,
			});
			if (error) throw error;
			return parsed;
		},
		catch: (cause) => OAuthRefreshError.Malformed({ cause }),
	});
}

/**
 * Best-effort revoke of a refresh token at the OAuth revoke endpoint. Throws
 * on a non-OK response; sign-out swallows that because local auth is already
 * cleared by the time this runs.
 */
export async function revokeOAuthRefreshTokenWithEndpoint({
	baseURL,
	clientId,
	refreshToken,
	fetch,
}: {
	baseURL: string;
	clientId: string;
	refreshToken: string;
	fetch: AuthFetch;
}) {
	const body = new URLSearchParams({
		client_id: clientId,
		token: refreshToken,
		token_type_hint: 'refresh_token',
	});
	const response = await fetch(OAUTH_ROUTES.revoke.url(baseURL), {
		method: 'POST',
		body,
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		credentials: 'omit',
	});
	if (!response.ok) {
		throw new Error(`OAuth revoke failed with ${response.status}.`);
	}
}
