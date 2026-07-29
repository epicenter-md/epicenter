/**
 * The ONE owner of TikTok token custody: decrypt, refresh, and atomically
 * persist the rotated replacement.
 *
 * No other module decrypts a stored token or calls TikTok's refresh endpoint.
 * That exclusivity is the whole design, because TikTok ROTATES refresh tokens:
 * a successful refresh can invalidate the token it was called with, so two
 * concurrent refreshers can permanently destroy a grant. One writes its
 * replacement, the other's in-flight token is already dead, and the creator has
 * to reconnect.
 *
 * The serialization is a row lock:
 *
 *   BEGIN
 *     SELECT ... WHERE id = $1 FOR UPDATE   -- only one request holds this
 *     if the access token is still usable: return it, refresh NOTHING
 *     otherwise: refresh at TikTok, write both rotated tokens
 *   COMMIT
 *
 * The re-read AFTER acquiring the lock is what makes the loser of a race cheap
 * and safe: by the time it holds the lock, the winner has already committed a
 * fresh access token, so the loser's freshness check passes and it never calls
 * TikTok at all. Only one refresh request per connection is ever in flight.
 *
 * The cost is an open transaction across an external HTTP call. That is
 * deliberate. The alternative (optimistic compare-and-swap) lets both callers
 * hit TikTok and is exactly the "race into invalidation" this must prevent.
 * A refresh happens at most once per 24h per connection and the call is a
 * single sub-second form POST, so the lock is held rarely and briefly.
 */

import { type Db, tiktokConnection } from '@epicenter/server/cloud-db';
import { eq } from 'drizzle-orm';
import { defineErrors } from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { TikTokOAuthClient, TikTokOAuthError } from './oauth.js';
import type { TokenCipher, TokenCipherError } from './token-cipher.js';

export const TikTokTokenError = defineErrors({
	ConnectionNotFound: ({ connectionId }: { connectionId: string }) => ({
		message: 'That TikTok connection no longer exists.',
		connectionId,
	}),
	/**
	 * The refresh token itself has expired (TikTok caps it at ~365 days). No
	 * refresh can recover this; the creator must authorize again.
	 */
	RefreshTokenExpired: ({ connectionId }: { connectionId: string }) => ({
		message:
			'This TikTok connection has expired. Reconnect the account to keep publishing.',
		connectionId,
	}),
});
export type TikTokTokenError = import('wellcrafted/error').InferErrors<
	typeof TikTokTokenError
>;

export type TikTokAccessError =
	| TikTokTokenError
	| TikTokOAuthError
	| TokenCipherError;

/**
 * Refresh this far BEFORE the access token actually expires, so a token that
 * would die mid-upload is replaced first. TikTok access tokens live 24h, so a
 * 5-minute skirt costs nothing and covers clock skew plus a slow upload.
 */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

export type TikTokAccess = {
	accessToken: string;
	openId: string;
	/** The scopes currently granted, re-read after any refresh. */
	scopes: string[];
};

/**
 * Return a usable access token for one connection, refreshing if needed.
 *
 * `now` is injected so the freshness boundary is testable without waiting a day.
 */
export async function ensureAccessToken({
	db,
	cipher,
	oauth,
	connectionId,
	now = new Date(),
}: {
	db: Db;
	cipher: TokenCipher;
	oauth: TikTokOAuthClient;
	connectionId: string;
	now?: Date;
}): Promise<Result<TikTokAccess, TikTokAccessError>> {
	return db.transaction(
		async (tx): Promise<Result<TikTokAccess, TikTokAccessError>> => {
			const locked = await tx
				.select()
				.from(tiktokConnection)
				.where(eq(tiktokConnection.id, connectionId))
				.for('update')
				.limit(1);
			const row = locked[0];
			if (!row) return TikTokTokenError.ConnectionNotFound({ connectionId });

			// Fast path, and the path the loser of a lock race takes: whoever held
			// the lock before us already refreshed, so there is nothing to do.
			const stillUsable =
				row.accessTokenExpiresAt.getTime() - REFRESH_SKEW_MS > now.getTime();
			if (stillUsable && cipher.isCurrent(row.accessTokenCiphertext)) {
				const { data: accessToken, error } = await cipher.decrypt(
					row.accessTokenCiphertext,
				);
				if (error) return Err(error);
				return Ok({ accessToken, openId: row.openId, scopes: row.scopes });
			}

			// The refresh token is the only durable credential. Once it expires,
			// nothing here can recover the grant.
			if (row.refreshTokenExpiresAt.getTime() <= now.getTime()) {
				return TikTokTokenError.RefreshTokenExpired({ connectionId });
			}

			const { data: refreshToken, error: decryptError } = await cipher.decrypt(
				row.refreshTokenCiphertext,
			);
			if (decryptError) return Err(decryptError);

			const { data: grant, error: refreshError } =
				await oauth.refresh(refreshToken);
			if (refreshError) return Err(refreshError);

			// Encrypt BOTH tokens before writing either. TikTok may have rotated the
			// refresh token, and storing the new access token beside a stale refresh
			// token would silently strand the connection at the next expiry.
			const { data: accessCiphertext, error: accessEncryptError } =
				await cipher.encrypt(grant.accessToken);
			if (accessEncryptError) return Err(accessEncryptError);
			const { data: refreshCiphertext, error: refreshEncryptError } =
				await cipher.encrypt(grant.refreshToken);
			if (refreshEncryptError) return Err(refreshEncryptError);

			// One statement, inside the lock: the rotated refresh token can never be
			// committed apart from the access token it was issued with.
			await tx
				.update(tiktokConnection)
				.set({
					accessTokenCiphertext: accessCiphertext,
					accessTokenExpiresAt: new Date(
						now.getTime() + grant.expiresInSec * 1000,
					),
					refreshTokenCiphertext: refreshCiphertext,
					refreshTokenExpiresAt: new Date(
						now.getTime() + grant.refreshExpiresInSec * 1000,
					),
					// Re-read rather than preserved: a creator can narrow scopes from
					// TikTok's own settings, and the UI must show what is true now.
					scopes: [...grant.scopes],
					updatedAt: now,
				})
				.where(eq(tiktokConnection.id, connectionId));

			return Ok({
				accessToken: grant.accessToken,
				openId: grant.openId,
				scopes: [...grant.scopes],
			});
		},
	);
}
