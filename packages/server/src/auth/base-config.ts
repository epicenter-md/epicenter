import type { BetterAuthOptions } from 'better-auth';

export const AUTH_BASE_PATH = '/auth';

/** Shared Better Auth config used by both the runtime and the CLI schema tool. */
export const BASE_AUTH_CONFIG = {
	basePath: AUTH_BASE_PATH,
	// Email/password is intentionally disabled. The social IdPs are the only
	// sign-in methods and assert verified emails; no mail sender is wired up,
	// so a local account could never verify. better-auth 1.6.18's
	// `requireLocalEmailVerified` linking gate (default true) closes the old
	// pre-registered-unverified-account takeover path, but an unverifiable
	// credential flow is still not one we serve. Do not re-enable without first
	// wiring email verification (sendVerificationEmail) and
	// requireEmailVerification.
	emailAndPassword: { enabled: false },
	account: {
		// Only Google is a trusted linking provider. A trusted provider bypasses
		// the incoming `emailVerified` check (better-auth 1.6.18 `link-account`
		// gate: `!isTrustedProvider && !userInfo.emailVerified`, plus a
		// `requireLocalEmailVerified` check on the existing user), so the set must
		// contain only IdPs that always assert a verified email. Google does;
		// GitHub does NOT (it can return an unverified primary email), so GitHub
		// is intentionally excluded even when enabled in create-auth.ts: an
		// untrusted GitHub identity only links to an existing same-email account
		// when GitHub itself reports the email verified. `email-password` is
		// absent because local credentials are disabled above.
		accountLinking: {
			enabled: true,
			trustedProviders: ['google'],
		},
	},
} satisfies BetterAuthOptions;

/**
 * The JWT signing algorithm Epicenter pins for `id_token` and access tokens.
 *
 * This is the one signing knob Epicenter owns. Better Auth owns the rest of the
 * mechanics: it generates the key pair, stores it in the `jwks` table, and
 * publishes the public JWK. We only pin the algorithm. Everything downstream of
 * it (`kty: 'EC'`, `crv: 'P-256'`, the key material) is a result of `jose`
 * generating an ES256 key, not config we supply. Better Auth's `keyPairConfig`
 * for ES256 accepts `alg` alone (its type is `{ alg: 'ES256'; crv?: never }`),
 * so there is nothing else here to pin.
 *
 * ES256 (P-256 ECDSA) is chosen over the `jose` and Better Auth default of
 * EdDSA (Ed25519) for the broadest verifier-library support across browser
 * `jose`, Tauri Rust crates, and mobile. EdDSA is cryptographically sound and
 * is now in FIPS 186-5, but ES256 stays the safer compatibility default until
 * every Epicenter verifier (browser, Tauri Rust, mobile) is confirmed to verify
 * EdDSA.
 *
 * Stale `jwks` rows (for example an Ed25519 key minted before ES256 was pinned)
 * are durable data, not a config problem. They are repaired outside the request
 * path with a one-time SQL delete; the signing path never filters the table.
 */
export const JWT_SIGNING_ALG = 'ES256' as const;
