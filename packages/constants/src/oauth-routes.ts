/**
 * OAuth endpoint URLs Epicenter CALLS as a Better Auth client.
 *
 * Distinct from `oauth-metadata.ts`, which computes the discovery paths
 * (`/.well-known/*`) the SERVER advertises. This file captures the
 * authorization-server endpoints Epicenter clients (browser, Tauri, hosted
 * UI) hit during OAuth flows.
 *
 * These values mirror Better Auth's default issuer path layout under
 * `/auth/*`; changing them requires a coordinated Better Auth configuration
 * change. This module is the single place every caller imports from so the
 * change lands once.
 *
 * @example
 * ```ts
 * import { OAUTH_ROUTES } from '@epicenter/constants/oauth-routes';
 * const tokenUrl = OAUTH_ROUTES.token.url(authBaseURL);
 * const res = await fetch(tokenUrl, { method: 'POST', body });
 * ```
 */

const stripTrailing = (s: string) => s.replace(/\/+$/, '');

export const OAUTH_ROUTES = {
	token: {
		pattern: '/auth/oauth2/token',
		url: (baseURL: string) => `${stripTrailing(baseURL)}/auth/oauth2/token`,
	},
	authorize: {
		pattern: '/auth/oauth2/authorize',
		url: (baseURL: string) => `${stripTrailing(baseURL)}/auth/oauth2/authorize`,
	},
	revoke: {
		pattern: '/auth/oauth2/revoke',
		url: (baseURL: string) => `${stripTrailing(baseURL)}/auth/oauth2/revoke`,
	},
} as const;
