import { type } from 'arktype';
import { type BetterAuthOptions, betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../db/schema/index.js';
import {
	APPLE_AUDIENCE,
	generateAppleClientSecret,
} from './apple-client-secret.js';
import { BASE_AUTH_CONFIG } from './base-config.js';
import { createCookieAdvancedConfig } from './cookie-config.js';
import { authPlugins } from './plugins.js';

type Db = NodePgDatabase<typeof schema>;

/**
 * The cloud-only auth env, as BOTH an arktype schema and its inferred type, and
 * the single SSOT for the relational-auth layer's secrets. It lives beside its
 * reader (cloud-only, reached only through `mountCloudAuth`), NOT in the portable
 * {@link ServerBindings}: the relational-auth substrate is a Cloud-only layer, so
 * its env contract is too, and the single-partition instance's env never inherits
 * secrets it does not read (ADR-0076). The cloud threads it onto
 * `c.var.authSecrets` (mount-cloud-auth.ts) from its own deploy-gated env, the
 * same honest-edge move every Cloudflare-only binding already makes (ADR-0066),
 * so both readers (this builder and the `authApp` sign-in page) take it from one
 * resolved value rather than reaching into the raw `c.env` bag.
 *
 * `BETTER_AUTH_SECRET` is required: every deployment that reaches this composes
 * Better Auth and must sign sessions with a real secret (the runtime gate below
 * is defense-in-depth against an empty value). Each OAuth provider is optional
 * and register-when-present (ADR-0071): a deployment configures the ones it has
 * an app for, or none; an absent provider is simply not offered, never a button
 * that 500s.
 */
export const CloudAuthBindings = type({
	BETTER_AUTH_SECRET: 'string',
	'GOOGLE_CLIENT_ID?': 'string',
	'GOOGLE_CLIENT_SECRET?': 'string',
	'GITHUB_CLIENT_ID?': 'string',
	'GITHUB_CLIENT_SECRET?': 'string',
	'MICROSOFT_CLIENT_ID?': 'string',
	'MICROSOFT_CLIENT_SECRET?': 'string',
	// Apple is register-when-present like the others, but "present" means all
	// four parts of the signing material: the Services ID plus the Team ID, Key
	// ID, and .p8 private key the client-secret JWT is minted from (there is no
	// static APPLE_CLIENT_SECRET). See {@link generateAppleClientSecret}.
	'APPLE_CLIENT_ID?': 'string',
	'APPLE_TEAM_ID?': 'string',
	'APPLE_KEY_ID?': 'string',
	'APPLE_PRIVATE_KEY?': 'string',
});
export type CloudAuthBindings = typeof CloudAuthBindings.infer;

/**
 * Assemble and return a configured `betterAuth()` instance from runtime deps.
 *
 * Cloudflare Workers doesn't expose `env` or database connections at module scope,
 * so this defers Better Auth initialization to request time. The returned object is
 * the raw Better Auth instance, with no wrapper or additional abstraction.
 *
 * Wires up:
 * - Drizzle adapter (portable Postgres wire; Hyperdrive on Workers, a pool on Node)
 * - Google OAuth, plus GitHub, Microsoft, and Apple when their credentials are
 *   configured (email/password is disabled; see {@link BASE_AUTH_CONFIG})
 * - Plugins: JWT (ES256), OAuth provider (PKCE)
 *
 * `/api/session` is the single Epicenter session surface; this builder no longer
 * enriches `/auth/get-session` with encryption keys.
 */
export function createAuth({
	db,
	env,
	baseURL,
	trustedOrigins,
}: {
	db: Db;
	env: CloudAuthBindings;
	baseURL: string;
	/** Deployment-supplied trusted origins (CORS, CSRF, redirect allow-list). */
	trustedOrigins: string[];
}) {
	// Better Auth signs sessions and the JWE cookie cache with this secret. Handed
	// an empty or missing one, the library silently falls back to its PUBLIC default
	// (`better-auth-secret-...`) and only throws when `NODE_ENV === 'production'`,
	// which is never set on a Worker. That is forgeable session signing, so fail
	// closed at the one place the secret reaches Better Auth. This makes the
	// guarantee runtime, not deploy-time only (the wrangler `secrets.required` gate
	// blocks a missing secret at deploy, but not a later dashboard deletion or a
	// preview path), and it covers both cloud entries since both reach `betterAuth`
	// only through here (ADR-0076).
	const secret = env.BETTER_AUTH_SECRET?.trim();
	if (!secret) {
		throw new Error(
			'BETTER_AUTH_SECRET is not set: refusing to construct Better Auth with an empty signing secret, which would fall back to a public default and sign forgeable sessions.',
		);
	}
	// Apple needs all four parts of its signing material to be offered at all;
	// the same flag gates both the provider registration and the trusted-origin
	// addition below (Apple posts its callback from appleid.apple.com).
	const appleConfigured = Boolean(
		env.APPLE_CLIENT_ID &&
			env.APPLE_TEAM_ID &&
			env.APPLE_KEY_ID &&
			env.APPLE_PRIVATE_KEY,
	);
	return betterAuth({
		...BASE_AUTH_CONFIG,
		database: drizzleAdapter(db, { provider: 'pg', schema }),
		baseURL,
		secret,
		// `account` (accountLinking) comes from BASE_AUTH_CONFIG via the spread.
		//
		// The Better Auth state-cookie check stays ENABLED (its default). The
		// Google sign-in leg validates the callback two ways: a single-use
		// Postgres verification record AND a signed state cookie set during the
		// sign-in POST. An earlier note disabled the cookie check on the theory
		// that the sign-in POST was a cross-origin fetch whose third-party
		// Set-Cookie browsers would drop. That is not how this deploys: the only
		// caller of `/auth/sign-in/social` is the API-hosted Svelte sign-in page,
		// which fetches a same-origin relative URL, so the state cookie is
		// first-party, stored, and sent on the
		// Google callback navigation. The cookie binds the callback to the
		// initiating browser (the DB record alone does not), so keeping the check
		// on restores that login-CSRF / session-fixation defense.
		//
		// Each provider is registered only when its credentials are configured,
		// so the hosted star is Google-by-default and a custom self-hosted
		// deployment that configures an OAuth app adds whichever providers it set,
		// instead of a button that 500s. The single-partition instance offers none:
		// it composes no Better Auth at all (this builder is cloud-only, reached
		// only through `mountCloudAuth`), and the operator bearer is its only gate
		// (ADR-0075). better-auth requests `read:user` +
		// `user:email` for GitHub by default, so it reads the primary email and
		// GitHub's verification flag. GitHub is deliberately NOT a trusted linking
		// provider (see BASE_AUTH_CONFIG): an unverified GitHub email must not link
		// into an existing account.
		socialProviders: {
			...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
				? {
						google: {
							clientId: env.GOOGLE_CLIENT_ID,
							clientSecret: env.GOOGLE_CLIENT_SECRET,
						},
					}
				: {}),
			...(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
				? {
						github: {
							clientId: env.GITHUB_CLIENT_ID,
							clientSecret: env.GITHUB_CLIENT_SECRET,
						},
					}
				: {}),
			// Microsoft (Entra / personal MSA), register-when-present like GitHub.
			// tenantId defaults to 'common' so both work/school and personal
			// accounts can sign in. Like GitHub, Microsoft is deliberately NOT a
			// trusted linking provider (see BASE_AUTH_CONFIG): a personal MSA email
			// is not a guaranteed-verified assertion, so an untrusted Microsoft
			// identity only links to an existing same-email account when Microsoft
			// itself reports the email verified.
			...(env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET
				? {
						microsoft: {
							clientId: env.MICROSOFT_CLIENT_ID,
							clientSecret: env.MICROSOFT_CLIENT_SECRET,
						},
					}
				: {}),
			// Apple's clientSecret is a per-request-minted ES256 JWT, so this is
			// an async factory rather than a static pair. `appleConfigured`
			// guarantees the four inputs are present (the `!` are safe under it).
			// Like GitHub and Microsoft, Apple is NOT a trusted linking provider:
			// it can issue a private-relay email, so an untrusted Apple identity
			// only links to an existing same-email account when Apple reports the
			// email verified.
			...(appleConfigured
				? {
						apple: async () => ({
							// biome-ignore lint/style/noNonNullAssertion: guarded by appleConfigured
							clientId: env.APPLE_CLIENT_ID!,
							clientSecret: await generateAppleClientSecret({
								// biome-ignore lint/style/noNonNullAssertion: guarded by appleConfigured
								clientId: env.APPLE_CLIENT_ID!,
								// biome-ignore lint/style/noNonNullAssertion: guarded by appleConfigured
								teamId: env.APPLE_TEAM_ID!,
								// biome-ignore lint/style/noNonNullAssertion: guarded by appleConfigured
								keyId: env.APPLE_KEY_ID!,
								// biome-ignore lint/style/noNonNullAssertion: guarded by appleConfigured
								privateKey: env.APPLE_PRIVATE_KEY!,
							}),
						}),
					}
				: {}),
		},
		session: {
			expiresIn: 60 * 60 * 24 * 7,
			updateAge: 60 * 60 * 24,
			// Postgres is the session store. A 5-minute encrypted (JWE) cookie
			// cache absorbs repeat reads, so most authed requests skip the DB
			// entirely; a cache miss falls back to Postgres.
			cookieCache: {
				enabled: true,
				maxAge: 60 * 5,
				strategy: 'jwe',
			},
		},
		// Cookie transport for browser clients: host-only, SameSite=Lax
		// everywhere (non-secure on localhost so the Vite `/auth` proxy works).
		// The only cookie consumer is the same-origin dashboard; every
		// cross-origin app client is a bearer client, so no cookie ever needs to
		// travel cross-site, and there is no cross-subdomain option by design
		// (ADR-0079). See createCookieAdvancedConfig for the full rationale.
		//
		// NOTE: We intentionally omit `partitioned: true` (CHIPS).
		// Partitioned cookies are keyed by the top-level site at creation
		// time. During OAuth the top-level site changes mid-flow (client to
		// Google to API callback), so the cookie becomes invisible at the
		// callback step. Partitioned is for iframes, not redirect OAuth.
		advanced: createCookieAdvancedConfig(baseURL),
		// Apple posts its OAuth callback from appleid.apple.com (response_mode=
		// form_post), so that origin must be trusted for the flow to complete.
		// Only added when Apple is configured, to avoid widening the allow-list.
		trustedOrigins: appleConfigured
			? [...trustedOrigins, APPLE_AUDIENCE]
			: trustedOrigins,
		// Postgres is the only auth store: sessions and OAuth verification
		// records persist to the DB adapter by default (no secondaryStorage), and
		// the JWE cookie cache above handles read performance. This makes auth
		// construction byte-identical on Workers and a Node host (Road 1: depend
		// on the portable Postgres path, delete the KV-cache divergence).
		//
		// Rate limiting consequently runs in-process, not in a shared store:
		// dropping KV flips Better Auth's default from "secondary-storage" to
		// "memory", so on the Worker each isolate keeps its own counters.
		// Acceptable here because email/password is disabled and Google is the
		// only sign-in (see BASE_AUTH_CONFIG), so there is no password
		// brute-force surface a shared counter would protect; a single self-host
		// process gets exact in-memory limiting for free. Upgrade trigger: add a
		// `rateLimit` table to the schema and set `storage: 'database'` if
		// durable, shared limiting is ever needed.
		rateLimit: { storage: 'memory' },
		plugins: authPlugins(baseURL),
	} satisfies BetterAuthOptions);
}
