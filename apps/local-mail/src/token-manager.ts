import { Ok, type Result } from 'wellcrafted/result';
import type { AppConfig } from './config.ts';
import { type OAuthError, refreshAccessToken } from './oauth.ts';
import type { TokenStore } from './token-store.ts';
import {
	isAccessTokenExpired,
	type TokenGrantError,
	type TokenSet,
} from './tokens.ts';

export type TokenError = OAuthError | TokenGrantError;

/**
 * Owns the live access token for one Gmail account: hands out a valid bearer
 * token, refreshing transparently when it is near expiry or when the API
 * rejects it (401). Every refresh persists the rotated token set back to the
 * token store so the next process starts from the newest credentials.
 *
 * Unlike `apps/local-books`' `TokenManager`, there is no proactive
 * `isRefreshTokenExpired` check before attempting a refresh: Google does not
 * return a refresh-token expiry in the grant response the way QuickBooks does,
 * so a dead refresh token (revoked, or a Testing-mode client's 7-day test-user
 * expiry) is only discoverable by attempting the refresh and reading the
 * `invalid_grant` error back (see `oauth.ts`'s `ReauthRequired`).
 */
export type TokenManager = {
	getValidAccessToken(): Promise<Result<string, TokenError>>;
	forceRefresh(): Promise<Result<string, TokenError>>;
};

export function createTokenManager({
	config,
	store,
	token,
	now,
}: {
	config: AppConfig;
	store: TokenStore;
	token: TokenSet;
	now: () => number;
}): TokenManager {
	let current = token;
	let refreshInFlight: Promise<Result<string, TokenError>> | null = null;

	async function refreshOnce(): Promise<Result<string, TokenError>> {
		const { data: refreshed, error } = await refreshAccessToken(
			config,
			current,
			now,
		);
		if (error) return { data: null, error };
		current = refreshed;
		await store.set(refreshed);
		return Ok(refreshed.accessToken);
	}

	function refresh(): Promise<Result<string, TokenError>> {
		refreshInFlight ??= refreshOnce().finally(() => {
			refreshInFlight = null;
		});
		return refreshInFlight;
	}

	return {
		async getValidAccessToken() {
			if (!isAccessTokenExpired(current, now())) return Ok(current.accessToken);
			return refresh();
		},
		forceRefresh: refresh,
	};
}
