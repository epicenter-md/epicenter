/**
 * The live access token for one connected account.
 *
 * What is stored and what is held apart deliberately. `epicenter.secrets` holds
 * the refresh token and nothing else (ADR-0310): it is the only part worth
 * keeping, it is the only part that cannot be re-derived, and it is the only
 * part a keychain should be asked to hold. The access token lives in this
 * object for the life of the process, because it expires in an hour and
 * persisting it would mean writing a secret to buy nothing.
 *
 * There is no proactive refresh-token expiry check, unlike `apps/local-books`.
 * Google returns no refresh-token expiry, so a dead grant is only discoverable
 * by attempting the refresh and reading `invalid_grant` back.
 */

import { Ok, type Result } from 'wellcrafted/result';
import type { SecretStore } from '@epicenter/app';
import type { GmailClientIdentity, MailConfig } from './config.ts';
import { OAuthError, refreshAccess } from './oauth.ts';

export type TokenError = OAuthError;

export type TokenManager = {
	getValidAccessToken(): Promise<Result<string, TokenError>>;
	forceRefresh(): Promise<Result<string, TokenError>>;
};

/** Refresh a little early so an in-flight request never races expiry. */
const ACCESS_TOKEN_SKEW_MS = 2 * 60 * 1000;

export function isAccessTokenExpired(
	expiresAt: string,
	now: number,
	skewMs: number = ACCESS_TOKEN_SKEW_MS,
): boolean {
	return Date.parse(expiresAt) - now <= skewMs;
}

export function createTokenManager({
	config,
	identity,
	secrets,
	accountId,
	now,
}: {
	config: MailConfig;
	identity: GmailClientIdentity;
	secrets: SecretStore;
	/** The Epicenter Data row id for this account, which keys the secret. */
	accountId: string;
	now: () => number;
}): TokenManager {
	let access: { token: string; expiresAt: string } | null = null;
	let inFlight: Promise<Result<string, TokenError>> | null = null;

	async function refreshOnce(): Promise<Result<string, TokenError>> {
		const stored = await secrets.get(accountId);
		// The account list synchronized and the credential did not, which is what
		// a secret is (ADR-0310). A browser build reads this after every reload,
		// and a new desktop device reads it once. A secret owner that FAILED and
		// one that holds nothing land here together on purpose: what a person does
		// about either is connect the account again.
		if (stored.error !== null || stored.data === null) {
			return OAuthError.ReauthRequired({
				reason: 'this device holds no credential for the account',
			});
		}
		const refreshed = await refreshAccess({
			config,
			identity,
			refreshToken: stored.data,
			now,
		});
		if (refreshed.error !== null) return refreshed;
		access = {
			token: refreshed.data.accessToken,
			expiresAt: refreshed.data.accessTokenExpiresAt,
		};
		// Google rotates on its own schedule, so store back whatever is current.
		if (refreshed.data.refreshToken !== stored.data) {
			await secrets.put(accountId, refreshed.data.refreshToken);
		}
		return Ok(refreshed.data.accessToken);
	}

	function refresh(): Promise<Result<string, TokenError>> {
		inFlight ??= refreshOnce().finally(() => {
			inFlight = null;
		});
		return inFlight;
	}

	return {
		async getValidAccessToken() {
			if (access !== null && !isAccessTokenExpired(access.expiresAt, now())) {
				return Ok(access.token);
			}
			return refresh();
		},
		forceRefresh: refresh,
	};
}
