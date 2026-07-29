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
	// Rotation keys are `TIKTOK_TOKEN_ENCRYPTION_KEY_V<n>` for any n > 1 and are
	// discovered by name at runtime (see ROTATION_KEY_PATTERN), so a third or
	// fourth rotation needs a new binding, not a code change. They are not
	// enumerated here because arktype cannot express the open-ended family and
	// pinning `_V2` alone would build in exactly the wall this avoids.
	'+': 'ignore',
});
export type TikTokBindings = typeof TikTokBindings.infer;

/**
 * A rotation key binding and the ciphertext version it writes.
 *
 * `TIKTOK_TOKEN_ENCRYPTION_KEY` is version 1 and `..._V<n>` is version n, so
 * rotating is: add `..._V<n+1>`, let refreshes carry rows forward onto it, then
 * drop the key below it. Version numbers only ever climb, and every configured
 * key stays available for decryption, so no rotation forces a reconnect.
 */
const ROTATION_KEY_PATTERN = /^TIKTOK_TOKEN_ENCRYPTION_KEY_V(\d+)$/;

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
 *
 * Kept at the minimum the product actually exercises, because TikTok's app
 * review guidelines hold this list to two rules at once: "Only request
 * permissions and features that your app needs", and "All selected products and
 * scopes must be clearly demonstrated in the video. If you don't need certain
 * products or scopes, make sure to remove them before review." A scope nothing
 * in the UI drives is therefore not merely untidy, it delays the review.
 *
 * Two scopes were deliberately REMOVED rather than left requested:
 *
 * - `video.list` (Display API) read the creator's recent posts back. It is not
 *   how a publish is verified: `status/fetch` returns TikTok's own
 *   `publicaly_available_post_id` for the exact task, which is a stronger fact
 *   about THIS post than a list of recent uploads. Keeping it would have added a
 *   second product to review, and a browse-your-own-posts surface is the
 *   account-management framing the guidelines reject.
 * - `video.upload` sent a video to the creator's TikTok inbox as a draft. It is
 *   an alternative publishing product, not a step in Direct Post, and Direct
 *   Post never calls it.
 */
export const TIKTOK_SCOPES = [
	/** Read the connected account's stable id, display name, and avatar. */
	'user.info.basic',
	/**
	 * Read the exact @username. TikTok moved `username` out of
	 * `user.info.basic`, and multiple accounts can share a display name.
	 */
	'user.info.profile',
	/**
	 * Direct Post: read the account's current posting options
	 * (`creator_info/query`), publish a video straight to the creator's profile,
	 * and read that task's status back.
	 */
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
 * hardcoded, so each deployment derives its own callback:
 *
 *   production: https://api.epicenter.so/api/integrations/tiktok/callback
 *
 * TikTok's Web Login Kit accepts HTTPS callbacks only. The ordinary local
 * origin still derives an HTTP URL for diagnostics, but it cannot complete
 * OAuth; use the deployed sandbox or a stable HTTPS tunnel for a live ceremony.
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

	// Every configured rotation key, discovered by name so an Nth rotation is a
	// new binding rather than an edit here. The cipher encrypts under the highest
	// version and decrypts under any of them.
	const keys: TokenKeyMaterial[] = [{ version: 1, base64Key: primaryKey }];
	for (const [binding, value] of Object.entries(
		env as Record<string, unknown>,
	)) {
		const match = ROTATION_KEY_PATTERN.exec(binding);
		const material = typeof value === 'string' ? value.trim() : null;
		if (!match?.[1] || !material) continue;
		const version = Number(match[1]);
		// Version 1 is the primary binding above; a `..._V1` would be a duplicate
		// claim on the same version, which the cipher could not disambiguate.
		if (version > 1) keys.push({ version, base64Key: material });
	}

	const { data: cipher, error } = await createTokenCipher(keys);
	if (error) return { data: null, error };

	return Ok({ clientKey, clientSecret, cipher });
}
