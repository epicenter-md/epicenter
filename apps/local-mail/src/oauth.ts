import * as oauth from 'oauth4webapi';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import type { AppConfig } from './config.ts';
import { createGmailClient } from './gmail-client.ts';
import {
	type GmailCredentials,
	gmailCredentialSource,
	persistGmailProviderCredentials,
	resolveGmailCredentials,
} from './gmail-credentials.ts';
import {
	type TokenGrantError,
	type TokenSet,
	tokenSetFromGrant,
} from './tokens.ts';

/**
 * Google OAuth2 built on `oauth4webapi` (the same client `@epicenter/auth` and
 * `apps/local-books` use). `connect` runs an authorization-code + PKCE loopback
 * flow once, stores the resulting refresh token, and the refresh grant keeps it
 * alive after that.
 */

export const OAuthError = defineErrors({
	MissingCredentials: ({ reason }: { reason: string }) => ({
		message: reason,
		reason,
	}),
	TokenExchangeFailed: ({ cause }: { cause: unknown }) => {
		const message =
			cause instanceof oauth.ResponseBodyError
				? `${extractErrorMessage(cause)} (${
						cause.error_description
							? `${cause.error}: ${cause.error_description}`
							: cause.error
					}, HTTP ${cause.status})`
				: extractErrorMessage(cause);
		return {
			message: `Gmail token exchange failed: ${message}`,
			cause,
		};
	},
	AuthorizationDenied: ({
		error,
		description,
	}: {
		error: string;
		description: string;
	}) => ({
		message: `Gmail denied authorization: ${error}${description ? ` (${description})` : ''}`,
		error,
		description,
	}),
	Timeout: ({ ms }: { ms: number }) => ({
		message: `Timed out after ${ms}ms waiting for the OAuth callback.`,
		ms,
	}),
	ProfileLookupFailed: ({ cause }: { cause: unknown }) => ({
		message: `Could not read the connected Gmail profile: ${extractErrorMessage(cause)}`,
		cause,
	}),
	ReauthRequired: ({ reason }: { reason: string }) => ({
		message: `Re-authentication required: ${reason}.`,
		reason,
	}),
	ClientIdMismatch: ({
		stored,
		configured,
	}: {
		stored: string;
		configured: string;
	}) => ({
		message:
			`The stored token was minted by OAuth client ${stored}, but the configured OAuth client is now ${configured}. ` +
			'Refreshing through a different client fails as invalid_grant; restore the original client id or run "local-mail connect" again.',
		stored,
		configured,
	}),
});
export type OAuthError = InferErrors<typeof OAuthError>;

type GrantResult = Promise<Result<TokenSet, OAuthError | TokenGrantError>>;

type AuthorizationFlowOptions = {
	now: () => number;
	openBrowser?: (url: string) => void;
	log?: (message: string) => void;
	timeoutMs?: number;
};

const GMAIL_MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';

/** Hand-built server metadata; Google's OAuth endpoints are known constants. */
function authServer(config: AppConfig): oauth.AuthorizationServer {
	return {
		// Google hosts the authorization issuer at accounts.google.com while the
		// token endpoint lives at oauth2.googleapis.com. The callback may include
		// `iss=https://accounts.google.com`; oauth4webapi validates it against
		// this field before the token exchange.
		issuer: new URL(config.authorizeUrl).origin,
		authorization_endpoint: config.authorizeUrl,
		token_endpoint: config.tokenUrl,
	};
}

/** Allow http for a mock token endpoint in tests. */
function httpOptions(config: AppConfig) {
	return {
		[oauth.allowInsecureRequests]:
			new URL(config.tokenUrl).protocol === 'http:',
	};
}

/**
 * Resolve the Gmail OAuth client lazily at the connect/refresh site rather than
 * eagerly in `loadConfig`, so credential-free verbs never read app identity.
 */
function loadGmailCredentials(
	config: AppConfig,
): Result<GmailCredentials, OAuthError> {
	try {
		return Ok(resolveGmailCredentials(gmailCredentialSource(config.dataDir)));
	} catch (cause) {
		return OAuthError.MissingCredentials({
			reason: extractErrorMessage(cause),
		});
	}
}

function buildAuthorizeUrl(
	config: AppConfig,
	{
		state,
		codeChallenge,
		redirectUri,
		clientId,
	}: {
		state: string;
		codeChallenge: string;
		redirectUri: string;
		clientId: string;
	},
): string {
	const url = new URL(config.authorizeUrl);
	url.searchParams.set('client_id', clientId);
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('scope', GMAIL_MODIFY_SCOPE);
	url.searchParams.set('redirect_uri', redirectUri);
	url.searchParams.set('state', state);
	url.searchParams.set('code_challenge', codeChallenge);
	url.searchParams.set('code_challenge_method', 'S256');
	url.searchParams.set('access_type', 'offline');
	url.searchParams.set('prompt', 'consent');
	return url.toString();
}

function defaultOpenBrowser(url: string): void {
	if (process.platform !== 'darwin') return;
	try {
		Bun.spawn(['open', url], { stdout: 'ignore', stderr: 'ignore' });
	} catch {
		// Non-fatal: the consent URL is printed for manual paste.
	}
}

async function fetchAccountEmail(
	config: AppConfig,
	grant: oauth.TokenEndpointResponse,
): Promise<Result<string, OAuthError>> {
	const accessToken =
		typeof grant.access_token === 'string' ? grant.access_token : null;
	if (!accessToken) {
		return OAuthError.ProfileLookupFailed({
			cause: new Error('token response did not include access_token'),
		});
	}
	const client = createGmailClient({
		config,
		tokens: {
			getValidAccessToken: async () => Ok(accessToken),
			forceRefresh: async () => Ok(accessToken),
		},
	});
	const { data, error } = await client.getProfile();
	if (error) return OAuthError.ProfileLookupFailed({ cause: error });
	if (!data.emailAddress) {
		return OAuthError.ProfileLookupFailed({
			cause: new Error('profile response did not include emailAddress'),
		});
	}
	return Ok(data.emailAddress);
}

/**
 * A consent flow that has started but not finished: where to send the person,
 * and what to await once they come back.
 *
 * Split from {@link runAuthorizationFlow} because a GUI needs the URL *before*
 * the wait, and cannot rely on a browser opening. `defaultOpenBrowser` is macOS
 * only and silently does nothing elsewhere, which is fine for a CLI that prints
 * the URL beside it and useless for a window that showed a spinner. A caller
 * that can render the URL is a caller that works on every platform.
 */
export type AuthorizationFlowHandle = {
	/** Send the person here. Safe to render, open, or copy. */
	authorizeUrl: string;
	/** Resolves when Google redirects back, or when the flow times out. */
	completed: GrantResult;
	/** Stop listening and release the loopback port. Idempotent; a flow that
	 * already completed is unaffected. */
	cancel(): void;
};

/**
 * Start a consent flow: bind the loopback listener Google will redirect to,
 * build the authorization URL, and hand both back without waiting.
 *
 * The listener holds an ephemeral port for the flow's lifetime, which is the
 * loopback-any-port exemption Google reserves for Desktop clients (ADR-0188).
 * Every caller must either await `completed` or `cancel()`, or the port and its
 * timeout leak.
 */
export async function beginAuthorizationFlow(
	config: AppConfig,
	options: AuthorizationFlowOptions,
): Promise<Result<AuthorizationFlowHandle, OAuthError>> {
	// Resolve the OAuth keyset lazily; this is the connect path's only
	// app-identity read. Destructured so the narrowing survives the awaits.
	const { data: credentials, error: credentialsError } =
		loadGmailCredentials(config);
	if (credentialsError) return { data: null, error: credentialsError };
	const { clientId, clientSecret } = credentials;

	const state = oauth.generateRandomState();
	const codeVerifier = oauth.generateRandomCodeVerifier();
	const codeChallenge = await oauth.calculatePKCECodeChallenge(codeVerifier);
	const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
	const { promise: callback, resolve } = Promise.withResolvers<URL | null>();

	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch(request) {
			const url = new URL(request.url);
			if (url.pathname !== '/oauth/callback') {
				return new Response('Not found', { status: 404 });
			}
			setTimeout(() => resolve(url), 0);
			return new Response(
				'<html><body><h2>Gmail connected.</h2><p>You can close this window and return to Epicenter.</p></body></html>',
				{ headers: { 'content-type': 'text/html' } },
			);
		},
	});
	const redirectUri = `http://127.0.0.1:${server.port}/oauth/callback`;
	const authorizeUrl = buildAuthorizeUrl(config, {
		state,
		codeChallenge,
		redirectUri,
		clientId,
	});

	const timer = setTimeout(() => resolve(null), timeoutMs);

	const exchange = async (callbackUrl: URL): GrantResult => {
		const as = authServer(config);
		const client: oauth.Client = { client_id: clientId };
		try {
			const params = oauth.validateAuthResponse(as, client, callbackUrl, state);
			const response = await oauth.authorizationCodeGrantRequest(
				as,
				client,
				oauth.ClientSecretPost(clientSecret),
				params,
				redirectUri,
				codeVerifier,
				httpOptions(config),
			);
			const grant = await oauth.processAuthorizationCodeResponse(
				as,
				client,
				response,
			);
			const { data: accountEmail, error } = await fetchAccountEmail(
				config,
				grant,
			);
			if (error) return { data: null, error };
			const { data: token, error: tokenError } = tokenSetFromGrant(grant, {
				accountEmail,
				clientIdUsed: clientId,
				now: options.now(),
			});
			if (tokenError) return { data: null, error: tokenError };
			persistGmailProviderCredentials(config.dataDir, credentials);
			return Ok(token);
		} catch (cause) {
			if (cause instanceof oauth.AuthorizationResponseError) {
				return OAuthError.AuthorizationDenied({
					error: cause.error,
					description: cause.error_description ?? '',
				});
			}
			return OAuthError.TokenExchangeFailed({ cause });
		}
	};

	return Ok({
		authorizeUrl,
		completed: (async (): GrantResult => {
			const callbackUrl = await callback;
			clearTimeout(timer);
			server.stop(true);
			if (!callbackUrl) return OAuthError.Timeout({ ms: timeoutMs });
			return exchange(callbackUrl);
		})(),
		cancel: () => {
			clearTimeout(timer);
			resolve(null);
		},
	});
}

/**
 * The CLI's consent flow: begin, open a browser, and wait.
 *
 * A thin wrapper over {@link beginAuthorizationFlow} for the caller that has a
 * terminal to print into and nothing to render. A GUI should call `begin`
 * directly so it can show the URL instead of trusting a browser to open.
 */
export async function runAuthorizationFlow(
	config: AppConfig,
	options: AuthorizationFlowOptions,
): GrantResult {
	const log = options.log ?? (() => {});
	const { data: flow, error } = await beginAuthorizationFlow(config, options);
	if (error) return { data: null, error };
	log('Opening your browser to authorize Gmail access.');
	log(`If it does not open, visit:\n  ${flow.authorizeUrl}`);
	(options.openBrowser ?? defaultOpenBrowser)(flow.authorizeUrl);
	return flow.completed;
}

async function requestRefreshGrant({
	config,
	clientId,
	clientSecret,
	refreshToken,
}: {
	config: AppConfig;
	clientId: string;
	clientSecret: string;
	refreshToken: string;
}): Promise<Result<oauth.TokenEndpointResponse, OAuthError>> {
	const as = authServer(config);
	const client: oauth.Client = { client_id: clientId };
	try {
		const response = await oauth.refreshTokenGrantRequest(
			as,
			client,
			oauth.ClientSecretPost(clientSecret),
			refreshToken,
			httpOptions(config),
		);
		return Ok(await oauth.processRefreshTokenResponse(as, client, response));
	} catch (cause) {
		// Google's OAuth-style error responses (a dead grant: revoked, or a
		// Testing-mode client's 7-day test-user refresh token expired) throw
		// `ResponseBodyError` rather than returning an error value; `invalid_grant`
		// is the one case worth distinguishing (needs re-consent, not a retry).
		if (
			cause instanceof oauth.ResponseBodyError &&
			cause.error === 'invalid_grant'
		) {
			return OAuthError.ReauthRequired({ reason: cause.error });
		}
		return OAuthError.TokenExchangeFailed({ cause });
	}
}

export async function refreshAccessToken(
	config: AppConfig,
	token: TokenSet,
	now: () => number,
): GrantResult {
	const { data: credentials, error: credentialsError } =
		loadGmailCredentials(config);
	if (credentialsError) return { data: null, error: credentialsError };
	// A refresh token is bound to the client that minted it; refreshing through a
	// different client id (the environment's key was rotated) dies as a bare
	// invalid_grant, so name the drift here instead of letting it masquerade as a
	// revoked token.
	if (token.clientIdUsed !== credentials.clientId) {
		return OAuthError.ClientIdMismatch({
			stored: token.clientIdUsed,
			configured: credentials.clientId,
		});
	}
	const { data: grant, error } = await requestRefreshGrant({
		config,
		clientId: credentials.clientId,
		clientSecret: credentials.clientSecret,
		refreshToken: token.refreshToken,
	});
	if (error) return { data: null, error };
	persistGmailProviderCredentials(config.dataDir, credentials);
	// Rotation: Google may omit refresh_token when the old one stays valid.
	return tokenSetFromGrant(grant, {
		accountEmail: token.accountEmail,
		clientIdUsed: token.clientIdUsed,
		now: now(),
		fallbackRefreshToken: token.refreshToken,
	});
}

/**
 * Headless bootstrap: turn a bare refresh token into a full, verified
 * `TokenSet` by performing the refresh grant right away and reading the
 * account email off the Gmail profile. Seeding used to store a fabricated
 * placeholder token under an operator-typed email; a typo minted a mirror
 * under a wrong identity and a dead refresh token was only discovered on the
 * first sync. Redeeming at seed time makes both impossible.
 */
export async function redeemRefreshToken(
	config: AppConfig,
	refreshToken: string,
	now: () => number,
): GrantResult {
	const { data: credentials, error: credentialsError } =
		loadGmailCredentials(config);
	if (credentialsError) return { data: null, error: credentialsError };
	const { data: grant, error } = await requestRefreshGrant({
		config,
		clientId: credentials.clientId,
		clientSecret: credentials.clientSecret,
		refreshToken,
	});
	if (error) return { data: null, error };
	const { data: accountEmail, error: profileError } = await fetchAccountEmail(
		config,
		grant,
	);
	if (profileError) return { data: null, error: profileError };
	const { data: token, error: tokenError } = tokenSetFromGrant(grant, {
		accountEmail,
		clientIdUsed: credentials.clientId,
		now: now(),
		fallbackRefreshToken: refreshToken,
	});
	if (tokenError) return { data: null, error: tokenError };
	persistGmailProviderCredentials(config.dataDir, credentials);
	return Ok(token);
}
