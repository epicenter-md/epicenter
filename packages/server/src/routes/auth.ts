/**
 * Auth surface sub-app.
 *
 * Mounts every URL the auth flows live behind:
 *
 *   /sign-in          server-rendered sign-in page (Hono JSX)
 *   /consent          server-rendered OAuth consent page
 *   /auth/cli-callback CLI OOB landing page
 *   /auth/.well-known/openid-configuration   OIDC discovery
 *   /auth/.well-known/oauth-authorization-server   OAuth metadata
 *   /.well-known/oauth-protected-resource   resource server metadata
 *   /auth/*           Better Auth catch-all (all sign-up, sign-in, OAuth,
 *                     consent endpoints Better Auth itself owns)
 *
 * Deployments mount this whole sub-app at root; nothing in here depends on
 * the principal partition because authentication is identity, not workspace.
 */

import {
	oauthProviderAuthServerMetadata,
	oauthProviderOpenIdConfigMetadata,
} from '@better-auth/oauth-provider';
import { oauthProviderResourceClient } from '@better-auth/oauth-provider/resource-client';
import { OAUTH_ROUTES } from '@epicenter/constants/oauth-routes';
import { sValidator } from '@hono/standard-validator';
import { type } from 'arktype';
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { describeRoute } from 'hono-openapi';
import {
	createOAuthIssuerURL,
	OAUTH_AUTHORIZATION_SERVER_METADATA_PATH,
	OAUTH_METADATA_CACHE_CONTROL,
	OAUTH_OPENID_CONFIGURATION_PATH,
	OAUTH_PROTECTED_RESOURCE_METADATA_PATH,
} from '../auth/oauth-metadata.js';
import {
	renderCliCallbackPage,
	renderConsentPage,
	renderSignedInPage,
	renderSignInPage,
} from '../auth-pages/index.js';
import type { CloudEnv } from '../types.js';

/**
 * Auth sub-app. Registration order matters: OAuth discovery routes must
 * register before the `/auth/*` Better Auth catch-all, or the catch-all
 * swallows discovery requests.
 */
export const authApp = new Hono<CloudEnv>()
	// Server-rendered sign-in page. Re-entry into OAuth happens when the
	// caller arrives with `?sig=` (signed authorize params).
	.get('/sign-in', async (c) => {
		const session = await c.var.auth.api.getSession({
			headers: c.req.raw.headers,
		});
		if (session) {
			const url = new URL(c.req.url);
			if (url.searchParams.has('sig')) {
				return c.redirect(`${OAUTH_ROUTES.authorize.pattern}${url.search}`);
			}
			const callbackURL = url.searchParams.get('callbackURL');
			if (callbackURL?.startsWith('/')) {
				return c.redirect(callbackURL);
			}
			return c.html(
				renderSignedInPage({
					name: session.user.name,
					email: session.user.email,
				}),
			);
		}
		return c.html(
			renderSignInPage({
				githubEnabled: Boolean(
					c.var.authSecrets.GITHUB_CLIENT_ID &&
						c.var.authSecrets.GITHUB_CLIENT_SECRET,
				),
				microsoftEnabled: Boolean(
					c.var.authSecrets.MICROSOFT_CLIENT_ID &&
						c.var.authSecrets.MICROSOFT_CLIENT_SECRET,
				),
				appleEnabled: Boolean(
					c.var.authSecrets.APPLE_CLIENT_ID &&
						c.var.authSecrets.APPLE_TEAM_ID &&
						c.var.authSecrets.APPLE_KEY_ID &&
						c.var.authSecrets.APPLE_PRIVATE_KEY,
				),
			}),
		);
	})
	// Server-rendered consent page. Requires a session; redirects to sign-in
	// (with a callbackURL pointing back) when missing.
	.get(
		'/consent',
		sValidator('query', type({ 'client_id?': 'string', 'scope?': 'string' })),
		async (c) => {
			const session = await c.var.auth.api.getSession({
				headers: c.req.raw.headers,
			});
			if (!session) {
				const consentUrl = `/consent${new URL(c.req.url).search}`;
				return c.redirect(
					`/sign-in?callbackURL=${encodeURIComponent(consentUrl)}`,
				);
			}
			const { client_id: clientId, scope } = c.req.valid('query');
			return c.html(renderConsentPage({ clientId, scope }));
		},
	)
	// CLI OOB callback. The code is useless without the CLI's PKCE verifier,
	// but `Cache-Control: no-store` keeps the edge from caching it anyway.
	.get(
		OAUTH_ROUTES.cliCallback.pattern,
		describeRoute({
			description: 'CLI OAuth out-of-band callback page',
			tags: ['auth', 'oauth'],
		}),
		secureHeaders(),
		(c) => {
			c.header('Cache-Control', 'no-store, no-transform');
			return c.html(
				renderCliCallbackPage({
					code: c.req.query('code'),
					state: c.req.query('state'),
					error: c.req.query('error'),
					errorDescription: c.req.query('error_description'),
				}),
			);
		},
	)
	// OAuth discovery. MUST register before /auth/* below; Hono matches in
	// registration order and the catch-all otherwise wins.
	.get(
		OAUTH_OPENID_CONFIGURATION_PATH,
		describeRoute({
			description: 'OpenID Connect discovery metadata',
			tags: ['auth', 'oauth'],
		}),
		(c) =>
			oauthProviderOpenIdConfigMetadata(
				c.var.auth as Parameters<typeof oauthProviderOpenIdConfigMetadata>[0],
			)(c.req.raw),
	)
	.get(
		OAUTH_AUTHORIZATION_SERVER_METADATA_PATH,
		describeRoute({
			description: 'OAuth authorization server metadata',
			tags: ['auth', 'oauth'],
		}),
		(c) =>
			oauthProviderAuthServerMetadata(
				c.var.auth as Parameters<typeof oauthProviderAuthServerMetadata>[0],
			)(c.req.raw),
	)
	.get(
		OAUTH_PROTECTED_RESOURCE_METADATA_PATH,
		describeRoute({
			description: 'OAuth protected resource metadata',
			tags: ['auth', 'oauth'],
		}),
		async (c) => {
			const resource = oauthProviderResourceClient();
			const metadata = await resource
				.getActions()
				.getProtectedResourceMetadata({
					resource: c.var.authBaseURL,
					authorization_servers: [createOAuthIssuerURL(c.var.authBaseURL)],
				});
			c.header('Cache-Control', OAUTH_METADATA_CACHE_CONTROL);
			return c.json(metadata);
		},
	)
	// Better Auth catch-all.
	.on(
		['GET', 'POST'],
		'/auth/*',
		describeRoute({
			description: 'Better Auth handler',
			tags: ['auth'],
		}),
		(c) => c.var.auth.handler(c.req.raw),
	);
