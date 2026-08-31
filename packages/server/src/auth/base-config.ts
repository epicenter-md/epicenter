import type { BetterAuthOptions } from 'better-auth';
import {
	APIError,
	createAuthMiddleware,
	getSessionFromCtx,
} from 'better-auth/api';

export const AUTH_BASE_PATH = '/auth';

/**
 * Better Auth paths that ADD or REMOVE a way to sign in. Adding one is at least
 * as sensitive as removing one (a new door is a new attack surface), but
 * upstream guards them asymmetrically: `/unlink-account` and passkey
 * registration already demand a FRESH session, while `/link-social` and
 * `/passkey/delete-passkey` accept any active one (up to the 7-day session
 * lifetime). This set is the paths we lift to the same freshness bar.
 */
const FRESH_SESSION_REQUIRED_PATHS = new Set([
	'/link-social',
	'/passkey/delete-passkey',
]);

/**
 * A global `before` hook that holds the {@link FRESH_SESSION_REQUIRED_PATHS} to
 * the same freshness Better Auth's own `freshSessionMiddleware` enforces
 * (`session.freshAge`, default 24h), mirroring its check exactly. It runs as a
 * hook rather than route middleware because those endpoints' middleware is
 * baked into the plugin and cannot be swapped.
 *
 * Why it matters: `account.accountLinking.allowDifferentEmails` (below) lets a
 * signed-in user attach a provider whose email differs from their account's, so
 * the account page can plant an entirely new login identity. Without this gate,
 * a transiently-borrowed already-signed-in browser could add a permanent
 * backdoor login without re-proving the human. A stale session is refused with
 * the same `SESSION_NOT_FRESH` code the client already handles for passkey
 * registration; the remedy is identical (sign in again).
 */
const requireFreshSessionForLoginChanges = createAuthMiddleware(async (ctx) => {
	if (!FRESH_SESSION_REQUIRED_PATHS.has(ctx.path)) return;
	const session = await getSessionFromCtx(ctx);
	if (!session?.session) {
		throw APIError.from('UNAUTHORIZED', {
			message: 'Unauthorized',
			code: 'UNAUTHORIZED',
		});
	}
	const { freshAge } = ctx.context.sessionConfig;
	if (freshAge === 0) return;
	const createdAt = new Date(session.session.createdAt).getTime();
	if (Date.now() - createdAt >= freshAge * 1000) {
		throw APIError.from('FORBIDDEN', {
			message: 'Sign in again to change your login methods.',
			code: 'SESSION_NOT_FRESH',
		});
	}
});

/** Shared Better Auth config used by both the runtime and the CLI schema tool. */
export const BASE_AUTH_CONFIG = {
	basePath: AUTH_BASE_PATH,
	// Email/password is intentionally disabled. The social IdPs are the only
	// sign-in methods and assert verified emails; no mail sender is wired up,
	// so a local account could never verify. better-auth 1.6.23's
	// `requireLocalEmailVerified` linking gate (default true) closes the old
	// pre-registered-unverified-account takeover path, but an unverifiable
	// credential flow is still not one we serve. Do not re-enable without first
	// wiring email verification (sendVerificationEmail) and
	// requireEmailVerification.
	emailAndPassword: { enabled: false },
	account: {
		// Only Google is a trusted linking provider. A trusted provider bypasses
		// the incoming `emailVerified` check (better-auth 1.6.23 `link-account`
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
			// Let a signed-in user link a provider whose email differs from their
			// account email (a work Google, a work Microsoft, an Apple private
			// relay), so one human keeps one Epicenter identity and one
			// partition instead of fragmenting into separate, unmergeable users.
			// This ONLY relaxes the explicit `/link-social` flow, which runs a full
			// OAuth ceremony proving the user controls the provider; it does NOT
			// enable different-email IMPLICIT linking during sign-in, which is
			// structurally impossible (implicit linking keys on the email match).
			// The upstream takeover warning is the stale-session backdoor, which
			// `requireFreshSessionForLoginChanges` above closes: linking requires a
			// fresh session, and the account page names the current account email
			// and asks for confirmation before it runs.
			allowDifferentEmails: true,
		},
	},
	// Hold add/remove-login mutations to a fresh session (see the hook above).
	hooks: { before: requireFreshSessionForLoginChanges },
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
