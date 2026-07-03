import { oauthProvider } from '@better-auth/oauth-provider';
import { EPICENTER_OAUTH_SCOPES } from '@epicenter/constants/oauth-clients';
import { buildTrustedOAuthClients } from '@epicenter/constants/oauth-seed';
import type { BetterAuthOptions } from 'better-auth';
import { jwt } from 'better-auth/plugins/jwt';
import { JWT_SIGNING_ALG } from './base-config.js';

/**
 * Build the Better Auth plugins that define Epicenter's OAuth server boundary.
 *
 * Use this only from the API auth factory, where the request URL is known.
 * `apiBaseURL` plays two roles: it's the OAuth resource audience (clients
 * pass it as `resource`, and we accept tokens minted only for this audience,
 * preventing tokens from one resource server being replayed against another),
 * and it's the deployment input to `buildTrustedOAuthClients` so the
 * trusted-client-id set matches the clients the seeder will install.
 */
export function authPlugins(apiBaseURL: string) {
	const trustedOAuthClientIds = new Set(
		buildTrustedOAuthClients(apiBaseURL).map((client) => client.clientId),
	);
	return [
		// `JWT_SIGNING_ALG` (ES256, P-256 ECDSA) signs the id_token and JWT
		// access tokens. `id_token_signing_alg_values_supported` on
		// `/.well-known/openid-configuration` is derived from this same
		// `keyPairConfig.alg` by the OAuth provider plugin, not a second
		// hardcoded list, so the advertised alg and the signing alg cannot
		// drift. See that constant for why ES256 is pinned over the `jose`
		// EdDSA default, and why `alg` is the only thing we configure (Better
		// Auth derives the key shape from it).
		//
		// `keyPairConfig.alg` governs only newly minted keys. If the `jwks`
		// table ever holds a row of another algorithm (such as a pre-ES256
		// Ed25519 key), signing crashes because `importJWK` rejects the
		// mismatch. The fix is to delete that stale row so Better Auth mints a
		// compliant key, not to filter the table in this read path.
		jwt({ jwks: { keyPairConfig: { alg: JWT_SIGNING_ALG } } }),
		oauthProvider({
			loginPage: '/sign-in',
			consentPage: '/consent',
			requirePKCE: true,
			// JWT access tokens are stateless: the resource server verifies them
			// against JWKS with no per-request introspection, so a token stays
			// valid until it expires even after the session or refresh token is
			// revoked. The plugin default is 3600s (1h); 600s (10min) keeps that
			// post-revocation window short while the client refreshes
			// transparently (refresh tokens rotate, and the auth runtime refreshes
			// on a 60s skew and on any 401). Refresh-token lifetime is unchanged.
			accessTokenExpiresIn: 600,
			// Refresh-token semantics, verified against the installed
			// @better-auth/oauth-provider 1.6.18 dist (2026-07-01 spike; re-verify
			// on upgrade):
			//
			// - Rotation is unconditional (every refresh mints a new token) and
			//   reuse detection is built in: replaying a rotated-out token
			//   invalidates the whole (clientId, userId) family per RFC 9700
			//   §4.14. On by default; nothing to configure. Family granularity is
			//   per client id, so one detected replay signs the user out of that
			//   app on every device: coarse but fail-safe.
			// - Refresh lifetime is a SLIDING window (`refreshTokenExpiresIn`,
			//   default 30 days, reset on every rotation). No absolute-cap knob
			//   exists upstream; `auth_time` is carried through rotations, so an
			//   absolute cap could be enforced by a periodic delete on
			//   `oauth_refresh_token.auth_time` if replay risk ever demands one.
			// - Better Auth session revocation does NOT revoke grants: sign-out
			//   deletes the session row and the refresh row survives with
			//   `session_id` SET NULL (offline_access semantics). Killing a grant
			//   takes /oauth2/revoke or deleting its rows.
			cachedTrustedClients: trustedOAuthClientIds,
			validAudiences: [apiBaseURL],
			allowDynamicClientRegistration: false,
			scopes: [...EPICENTER_OAUTH_SCOPES],
			// The plugin warns that /.well-known/oauth-authorization-server/auth must exist
			// because basePath is /auth (not /), so it can't auto-mount at the root.
			// We already mount both discovery endpoints manually in app.ts.
			silenceWarnings: { oauthAuthServerConfig: true, openidConfig: true },
		}),
	] satisfies NonNullable<BetterAuthOptions['plugins']>;
}
