/**
 * Hosted-only TikTok integration configuration: bindings, scopes, and the one
 * derived redirect URI.
 *
 * Cloud-only by construction. These bindings are read at this Worker's own edge
 * and are absent from `ServerBindings`, so the self-hosted instance never
 * inherits a credential it does not use (ADR-0076). When they are unset the
 * integration mounts in an explicitly unconfigured state: the routes answer a
 * named 503 instead of half-working.
 */

import { type } from 'arktype';
import { defineErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import {
	createTokenCipher,
	type TokenCipher,
	type TokenCipherError,
	type TokenKeyMaterial,
} from './token-cipher.js';

/**
 * TikTok calls the public half of its credential pair a "client key", not a
 * client id, and the token endpoint expects `client_key`. The naming is
 * preserved rather than normalized so a reader comparing this against TikTok's
 * docs sees the same word.
 */
export const TikTokBindings = type({
	'TIKTOK_CLIENT_KEY?': 'string',
	'TIKTOK_CLIENT_SECRET?': 'string',
	'TIKTOK_TOKEN_ENCRYPTION_KEY?': 'string',
	// Present only during a key rotation; see token-cipher.ts.
	'TIKTOK_TOKEN_ENCRYPTION_KEY_V2?': 'string',
});
export type TikTokBindings = typeof TikTokBindings.infer;

export const TikTokConfigError = defineErrors({
	NotConfigured: ({ missing }: { missing: readonly string[] }) => ({
		message: `TikTok integration is not configured on this deployment (missing: ${missing.join(', ')}).`,
		missing,
	}),
});
export type TikTokConfigError = import('wellcrafted/error').InferErrors<
	typeof TikTokConfigError
>;

/**
 * Every scope the connect ceremony requests, and why each is needed. TikTok's
 * consent screen lets a creator decline any of them individually, so the
 * GRANTED set is read back from the token response and stored per connection;
 * this list is only ever the request.
 */
export const TIKTOK_SCOPES = [
	/** Read the connected account's identity so the UI can name it exactly. */
	'user.info.basic',
	/** Read back posted videos to verify a publish actually landed. */
	'video.list',
	/** Send a video to the creator's TikTok inbox as an editable draft. */
	'video.upload',
	/** Direct Post: publish a video straight to the creator's profile. */
	'video.publish',
] as const;
export type TikTokScope = (typeof TIKTOK_SCOPES)[number];

/**
 * The callback path, and therefore the redirect URI registered with TikTok.
 *
 * It sits under `/api/` so it inherits the deployment's existing CORS and
 * cookie-CSRF posture. The CSRF gate exempts GET (it guards cookie MUTATIONS),
 * which is what lets TikTok's top-level GET navigation land here with the
 * session cookie attached.
 */
export const TIKTOK_CALLBACK_PATH = '/api/integrations/tiktok/callback';

/**
 * The exact value that must be registered in the TikTok developer portal.
 * Derived from the deployment origin (`c.var.authBaseURL`) rather than
 * hardcoded, so production and local sandbox agree by construction:
 *
 *   production: https://api.epicenter.so/api/integrations/tiktok/callback
 *   local dev:  http://localhost:8787/api/integrations/tiktok/callback
 */
export function tiktokRedirectUri(origin: string): string {
	return new URL(TIKTOK_CALLBACK_PATH, origin).toString();
}

/** Resolved, ready-to-use TikTok configuration. */
export type TikTokConfig = {
	clientKey: string;
	clientSecret: string;
	cipher: TokenCipher;
};

/**
 * Resolve the integration's configuration, or name precisely what is missing.
 *
 * The cipher is built here so a bad encryption key is a configuration failure
 * surfaced at the route boundary, never a surprise at publish time.
 */
export async function resolveTikTokConfig(
	env: TikTokBindings,
): Promise<Result<TikTokConfig, TikTokConfigError | TokenCipherError>> {
	const clientKey = env.TIKTOK_CLIENT_KEY?.trim();
	const clientSecret = env.TIKTOK_CLIENT_SECRET?.trim();
	const primaryKey = env.TIKTOK_TOKEN_ENCRYPTION_KEY?.trim();

	const missing = [
		clientKey ? null : 'TIKTOK_CLIENT_KEY',
		clientSecret ? null : 'TIKTOK_CLIENT_SECRET',
		primaryKey ? null : 'TIKTOK_TOKEN_ENCRYPTION_KEY',
	].filter((name): name is string => name !== null);
	if (!clientKey || !clientSecret || !primaryKey) {
		return TikTokConfigError.NotConfigured({ missing });
	}

	const rotationKey = env.TIKTOK_TOKEN_ENCRYPTION_KEY_V2?.trim();
	const keys: TokenKeyMaterial[] = [{ version: 1, base64Key: primaryKey }];
	if (rotationKey) keys.push({ version: 2, base64Key: rotationKey });

	const { data: cipher, error } = await createTokenCipher(keys);
	if (error) return { data: null, error };

	return Ok({ clientKey, clientSecret, cipher });
}
