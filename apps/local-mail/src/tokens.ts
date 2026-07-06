import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';

/**
 * A persisted Google OAuth2 token set for one Gmail account, stored verbatim in
 * the token file keyed by `accountEmail`. Expiries are absolute ISO timestamps
 * (not the relative `expires_in` Google returns) so a process that starts hours
 * later can still decide whether the access token is live without knowing when
 * it was issued. This schema is the single source of truth: `TokenSet` derives
 * from it, and the file token store validates disk bytes against it on read.
 *
 * `clientIdUsed` records the OAuth client that minted the refresh token. A token
 * written by a different configured client id reads as a local mismatch during
 * refresh instead of surfacing later as Google's opaque `invalid_grant`.
 */
export const TokenSetSchema = Type.Object({
	accountEmail: Type.String({ minLength: 1 }),
	clientIdUsed: Type.String({ minLength: 1 }),
	accessToken: Type.String({ minLength: 1 }),
	refreshToken: Type.String({ minLength: 1 }),
	accessTokenExpiresAt: Type.String({ minLength: 1 }),
	obtainedAt: Type.String({ minLength: 1 }),
});
export type TokenSet = Static<typeof TokenSetSchema>;

/**
 * The fields we read off a raw Google bearer-token grant. Unknown fields are
 * preserved by TypeBox (no `additionalProperties: false`), so a new grant field
 * never trips validation. Google has no `x_refresh_token_expires_in` equivalent:
 * a Gmail refresh token does not expire on a fixed schedule once the OAuth
 * client is out of Testing mode (the 7-day test-user expiry is a Testing-mode
 * artifact, not a token property to track here).
 */
const TokenGrantSchema = Type.Object({
	token_type: Type.String({ minLength: 1 }),
	access_token: Type.String({ minLength: 1 }),
	refresh_token: Type.Optional(Type.String({ minLength: 1 })),
	expires_in: Type.Number({ exclusiveMinimum: 0 }),
});
export type TokenGrant = Static<typeof TokenGrantSchema>;

export const TokenGrantError = defineErrors({
	InvalidGrant: ({ reason }: { reason: string }) => ({
		message: `Google token response was malformed: ${reason}`,
		reason,
	}),
});
export type TokenGrantError = InferErrors<typeof TokenGrantError>;

/**
 * Normalize a raw token-endpoint payload into a {@link TokenSet}, converting the
 * relative `expires_in` seconds into an absolute timestamp anchored at `now`.
 *
 * `fallbackRefreshToken` covers Google's own rotation behavior: a refresh grant
 * may omit `refresh_token` when the existing one stays valid, so the caller
 * threads the prior token through. An authorization-code exchange must not pass
 * one (there is no prior token to fall back to).
 */
export function tokenSetFromGrant(
	payload: unknown,
	{
		accountEmail,
		clientIdUsed,
		now,
		fallbackRefreshToken,
	}: {
		accountEmail: string;
		clientIdUsed: string;
		now: number;
		fallbackRefreshToken?: string;
	},
): Result<TokenSet, TokenGrantError> {
	if (!Value.Check(TokenGrantSchema, payload)) {
		const [first] = Value.Errors(TokenGrantSchema, payload);
		const reason = first
			? `${first.message} at ${first.instancePath || '/'}`
			: 'unexpected shape';
		return TokenGrantError.InvalidGrant({ reason });
	}

	if (payload.token_type.toLowerCase() !== 'bearer') {
		return TokenGrantError.InvalidGrant({
			reason: `expected token_type "bearer", got ${JSON.stringify(payload.token_type)}`,
		});
	}

	const refreshToken = payload.refresh_token ?? fallbackRefreshToken;
	if (!refreshToken) {
		return TokenGrantError.InvalidGrant({ reason: 'missing refresh_token' });
	}

	return Ok({
		accountEmail,
		clientIdUsed,
		accessToken: payload.access_token,
		refreshToken,
		accessTokenExpiresAt: new Date(
			now + payload.expires_in * 1000,
		).toISOString(),
		obtainedAt: new Date(now).toISOString(),
	});
}

/** Default skew: refresh a little early so an in-flight request never races expiry. */
const ACCESS_TOKEN_SKEW_MS = 2 * 60 * 1000;

function accessTokenTtlMs(token: TokenSet, now: number): number {
	return Date.parse(token.accessTokenExpiresAt) - now;
}

export function isAccessTokenExpired(
	token: TokenSet,
	now: number,
	skewMs: number = ACCESS_TOKEN_SKEW_MS,
): boolean {
	return accessTokenTtlMs(token, now) <= skewMs;
}
