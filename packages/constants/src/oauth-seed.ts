import type { SchemaClient } from '@better-auth/oauth-provider';
import { APPS, appOrigins } from '#apps';
import {
	EPICENTER_CLI_OAUTH_CLIENT_ID,
	EPICENTER_FUJI_OAUTH_CLIENT_ID,
	EPICENTER_FUJI_TAURI_OAUTH_REDIRECT_URI,
	EPICENTER_HONEYCRISP_OAUTH_CLIENT_ID,
	EPICENTER_OAUTH_SCOPES,
	EPICENTER_OPENSIDIAN_OAUTH_CLIENT_ID,
	EPICENTER_TAB_MANAGER_OAUTH_CLIENT_ID,
	EPICENTER_VOCAB_OAUTH_CLIENT_ID,
	EPICENTER_WHISPERING_OAUTH_CLIENT_ID,
	EPICENTER_WHISPERING_TAURI_OAUTH_REDIRECT_URI,
} from './oauth-clients.js';
import { OAUTH_ROUTES } from './oauth-routes.js';

/**
 * Shape of one checked-in first-party public OAuth client.
 *
 * These are public PKCE clients (`tokenEndpointAuthMethod: 'none'`,
 * `public: true`, no client secret). They deliberately carry no OIDC client
 * `type`: the seed writes these rows directly (never through dynamic
 * registration), and Better Auth reads `type` only on the `/oauth2/register`
 * path and in a null-safe public-client check, so the field is inert for a
 * directly-seeded row. Setting it would only force an unanswerable
 * native-vs-user-agent-based question for the dual-form-factor clients:
 * Whispering and Fuji ship one client id across a web build (browser) and a
 * custom-scheme desktop build (native), and no single `type` is honest for a
 * row whose redirect set spans both. Public-client and PKCE behavior are fixed
 * by `public` + `tokenEndpointAuthMethod` + `requirePKCE`, not by this label.
 * See ADR-0087.
 *
 * `redirectUris` is the final resolved list for a specific deployment,
 * built by {@link buildTrustedOAuthClients} from `APPS` plus the
 * deployment's API base URL.
 *
 * Field names stay spelled out instead of using `Pick` or a mapped type so
 * this file reads as config.
 */
export type TrustedOAuthClient = {
	clientId: NonNullable<SchemaClient['clientId']>;
	name: NonNullable<SchemaClient['name']>;
	redirectUris: readonly string[];
};

/**
 * Path every first-party app receives the OAuth callback at, on each of its
 * origins. A convention shared by all origin-owning apps, not a per-app
 * choice, so it lives here rather than as an {@link appCallbacks} argument.
 */
const AUTH_CALLBACK_PATH = '/auth/callback';

/**
 * Every redirect URI for an app that owns its origin: each origin the app
 * answers on ({@link appOrigins}, i.e. dev plus prod) joined to
 * {@link AUTH_CALLBACK_PATH}. Used by Fuji, Honeycrisp, Opensidian, and
 * Vocab.
 */
function appCallbacks(app: {
	port: number;
	url: string;
	aliases?: readonly string[];
}): string[] {
	return appOrigins(app).map((origin) => `${origin}${AUTH_CALLBACK_PATH}`);
}

/**
 * Build the checked-in trusted public OAuth clients for a specific
 * deployment. Each client's `redirectUris` resolve against either the app's
 * own origins (Fuji, Honeycrisp, etc.) or the deployment's API base URL
 * (the CLI, which lives on the API origin). A self-host at
 * `https://api.acme.com` and `wrangler dev` on a custom port each register
 * their own callbacks without anyone editing this file.
 *
 * The API `oauth:seed` deploy script calls this to upsert the client rows;
 * `authPlugins` calls it to derive the trusted-client-id set.
 */
export function buildTrustedOAuthClients(apiBaseURL: string) {
	// The same-origin dashboard SPA is not an OAuth client: it authenticates
	// with the first-party session cookie (see createSameOriginCookieAuth), so
	// it is deliberately absent from this trusted-client set.
	return [
		{
			clientId: EPICENTER_FUJI_OAUTH_CLIENT_ID,
			name: 'Fuji',
			redirectUris: [
				...appCallbacks(APPS.FUJI),
				EPICENTER_FUJI_TAURI_OAUTH_REDIRECT_URI,
			],
		},
		{
			clientId: EPICENTER_WHISPERING_OAUTH_CLIENT_ID,
			name: 'Whispering',
			redirectUris: [
				...appCallbacks(APPS.WHISPERING),
				EPICENTER_WHISPERING_TAURI_OAUTH_REDIRECT_URI,
			],
		},
		{
			clientId: EPICENTER_HONEYCRISP_OAUTH_CLIENT_ID,
			name: 'Honeycrisp',
			redirectUris: appCallbacks(APPS.HONEYCRISP),
		},
		{
			clientId: EPICENTER_OPENSIDIAN_OAUTH_CLIENT_ID,
			name: 'Opensidian',
			redirectUris: appCallbacks(APPS.OPENSIDIAN),
		},
		{
			clientId: EPICENTER_TAB_MANAGER_OAUTH_CLIENT_ID,
			name: 'Tab Manager extension',
			redirectUris: ['chrome-extension://mkbnicfhpacdofmoocppnjjmdfmkkgda/'],
		},
		{
			clientId: EPICENTER_VOCAB_OAUTH_CLIENT_ID,
			name: 'Vocab',
			redirectUris: appCallbacks(APPS.VOCAB),
		},
		{
			clientId: EPICENTER_CLI_OAUTH_CLIENT_ID,
			name: 'Epicenter CLI',
			redirectUris: [OAUTH_ROUTES.cliCallback.url(apiBaseURL)],
		},
	] as const satisfies readonly TrustedOAuthClient[];
}

/**
 * Project a checked-in trusted client into Better Auth's `oauth_client` row.
 *
 * Used by the `apps/api` `oauth:seed` deploy script and by the auth tests that
 * need the exact row Better Auth stores. It owns the trusted-client invariant:
 * first-party apps are public PKCE clients (PKCE required, consent skipped,
 * authorization-code grant, the common Epicenter scopes).
 *
 * This lives beside {@link buildTrustedOAuthClients} (its input) rather than in
 * `@epicenter/server`, so the seed script reaches it without importing the
 * request-path auth barrel. The returned shape mirrors the `oauth_client`
 * table; the seed's parameterized `INSERT` is the write-time contract, so the
 * column list there must stay in sync with these fields.
 */
export function projectTrustedOAuthClientToRow(
	client: TrustedOAuthClient,
	now = new Date(),
) {
	return {
		id: client.clientId,
		clientId: client.clientId,
		disabled: false,
		skipConsent: true,
		scopes: [...EPICENTER_OAUTH_SCOPES],
		createdAt: now,
		updatedAt: now,
		name: client.name,
		redirectUris: [...client.redirectUris],
		tokenEndpointAuthMethod: 'none',
		grantTypes: ['authorization_code'],
		responseTypes: ['code'],
		public: true,
		// First-party seeded rows declare no OIDC client type; the column is
		// NULL. NULL is null-safe in Better Auth's public-client checks, and
		// keeping `type = EXCLUDED.type` in the seed upsert re-asserts NULL on
		// every run, so a re-seed also clears any legacy value. See ADR-0087 and
		// the {@link TrustedOAuthClient} doc.
		type: null,
		requirePKCE: true,
	};
}
