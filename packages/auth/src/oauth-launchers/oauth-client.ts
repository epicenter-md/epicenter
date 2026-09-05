import { EPICENTER_OAUTH_SCOPE } from '@epicenter/constants/oauth-clients';
import * as oauth from 'oauth4webapi';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import type { AuthFetch } from '../auth-contract.js';
import type { OAuthTokenGrant } from '../auth-types.js';
import { parseOAuthTokenGrant } from '../oauth-token-endpoints.js';

/**
 * Failures before auth core receives a token grant.
 *
 * These errors stay on the launcher side of the boundary. Auth core only sees
 * either a completed `OAuthTokenGrant`, a launched transport, or a failed
 * launcher result that it wraps as `StartSignInFailed`.
 */
export const OAuthClientError = defineErrors({
	MissingCallbackTransaction: () => ({
		message:
			'OAuth sign-in could not finish because callback state was missing.',
	}),
	/**
	 * The URL handed to `exchangeCallback` is not an authorization response:
	 * neither `code` nor `error` is on it.
	 *
	 * Refused BEFORE the stored transaction is read, and that ordering is the
	 * whole point. The transaction is consumed as soon as it is read, so
	 * treating a bare visit to the callback route as a callback would destroy a
	 * live PKCE verifier and strand a sign-in that was still in progress in
	 * another tab.
	 */
	MissingCallbackParameters: () => ({
		message: 'This URL carries no OAuth authorization response.',
	}),
	StateMismatch: () => ({
		message: 'OAuth sign-in state did not match.',
	}),
	AuthorizationFailed: ({
		error,
		description,
	}: {
		error: string;
		description: string | null;
	}) => ({
		message: description
			? `OAuth authorization failed: ${description}`
			: `OAuth authorization failed: ${error}`,
		error,
		description,
	}),
	TokenExchangeFailed: ({ cause }: { cause: unknown }) => ({
		message: `OAuth token exchange failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
	LaunchFailed: ({ cause }: { cause: unknown }) => ({
		message: `OAuth sign-in launch failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
});

export type OAuthClientError = InferErrors<typeof OAuthClientError>;

/**
 * Temporary storage for one in-progress OAuth authorization request.
 *
 * Launchers use this for PKCE verifier and state data only. Durable app
 * sessions belong to `createOAuthAppAuth` after the token exchange succeeds.
 * Browser redirect flows can use `sessionStorage`; native app flows usually
 * need storage that survives leaving the app and returning through a deep link.
 */
type OAuthTemporaryStorage = {
	/**
	 * Read the serialized PKCE transaction for this OAuth client.
	 *
	 * Browser launchers usually pass `sessionStorage`; native launchers can use
	 * any small async store that survives the browser round trip.
	 */
	getItem(key: string): MaybePromise<string | null>;
	/**
	 * Store the serialized transaction before opening the authorize URL.
	 *
	 * The transaction must be written before redirecting, otherwise the callback
	 * cannot prove that the returned `state` and verifier came from this client.
	 */
	setItem(key: string, value: string): MaybePromise<void>;
	/**
	 * Clear the transaction once a callback is being exchanged.
	 *
	 * Called as soon as the stored transaction has been read, regardless of
	 * whether the exchange then succeeds: the verifier is single-use, so a failed
	 * or abandoned attempt must not leave it behind in durable storage.
	 */
	removeItem(key: string): MaybePromise<void>;
};

/**
 * Stable OAuth client identity and transient transaction storage.
 *
 * `redirectUri` is intentionally not part of this config. Browser, extension,
 * and native launchers own the callback endpoint for each authorization launch.
 * The client stores that per-launch value in the temporary transaction so token
 * exchange uses the same redirect URI that created the authorization URL.
 */
export type OAuthClientConfig = {
	/**
	 * OAuth issuer URL. For Epicenter deployments this is `${baseURL}/auth`.
	 */
	issuer: string;
	/**
	 * Public OAuth client id registered with the Epicenter API.
	 */
	clientId: string;
	/**
	 * Resource server URL. Sent as the OAuth resource indicator and used by the
	 * API when issuing audience-bound access tokens.
	 */
	resource: string;
	/**
	 * Space-delimited OAuth scopes. Defaults to the app-client scope.
	 */
	scope?: string;
	/**
	 * Temporary PKCE transaction storage. This is not durable auth storage.
	 */
	storage: OAuthTemporaryStorage;
	/**
	 * Fetch implementation used for discovery and token exchange.
	 */
	fetch?: AuthFetch;
};

export type MaybePromise<T> = T | Promise<T>;

type OAuthTransaction = {
	state: string;
	codeVerifier: string;
	redirectUri: string;
};

const DEFAULT_SCOPE = EPICENTER_OAUTH_SCOPE;

/**
 * Create the shared OAuth authorization-code client used by browser launchers.
 *
 * Use this when a runtime needs explicit control over authorization URL
 * creation and callback handling. The client stores only transient PKCE state
 * and code verifier data; durable session storage belongs to
 * `createOAuthAppAuth` after the token exchange succeeds.
 */
export function createOAuthClient({
	issuer,
	clientId,
	resource,
	scope = DEFAULT_SCOPE,
	storage,
	fetch: fetchImpl,
}: OAuthClientConfig) {
	const storageKey = `epicenter.oauth.${clientId}`;
	const client = {
		client_id: clientId,
		token_endpoint_auth_method: 'none',
	} satisfies oauth.Client;

	const httpOptions = {
		[oauth.allowInsecureRequests]: new URL(issuer).protocol === 'http:',
		...(fetchImpl ? { [oauth.customFetch]: fetchImpl } : {}),
	};

	async function discover() {
		const issuerUrl = new URL(issuer);
		const response = await oauth.discoveryRequest(issuerUrl, {
			algorithm: 'oauth2',
			...httpOptions,
		});
		return await oauth.processDiscoveryResponse(issuerUrl, response);
	}

	/**
	 * Create the hosted authorization URL and persist its matching transaction.
	 *
	 * Call this immediately before opening the browser. The same `redirectUri`
	 * is stored with the verifier so `exchangeCallback` can use the exact value
	 * that produced the authorization code.
	 */
	async function createAuthorizationUrl(
		redirectUri: string,
	): Promise<Result<URL, OAuthClientError>> {
		try {
			const as = await discover();
			const state = oauth.generateRandomState();
			const codeVerifier = oauth.generateRandomCodeVerifier();
			const codeChallenge =
				await oauth.calculatePKCECodeChallenge(codeVerifier);
			await storage.setItem(
				storageKey,
				JSON.stringify({
					state,
					codeVerifier,
					redirectUri,
				} satisfies OAuthTransaction),
			);

			const authorizationEndpoint = as.authorization_endpoint;
			if (!authorizationEndpoint) {
				throw new Error('Authorization endpoint is missing.');
			}

			const url = new URL(authorizationEndpoint);
			url.searchParams.set('response_type', 'code');
			url.searchParams.set('client_id', clientId);
			url.searchParams.set('redirect_uri', redirectUri);
			url.searchParams.set('scope', scope);
			url.searchParams.set('state', state);
			url.searchParams.set('code_challenge', codeChallenge);
			url.searchParams.set('code_challenge_method', 'S256');
			url.searchParams.set('resource', resource);
			return Ok(url);
		} catch (cause) {
			return OAuthClientError.LaunchFailed({ cause });
		}
	}

	/**
	 * Exchange a callback URL for a token grant.
	 *
	 * Call only after a runtime signal says a real callback arrived: a redirect
	 * to the registered redirect URI, a deep link, or the response URL from a
	 * web-auth flow. A missing transaction here means a callback was received
	 * without the PKCE verifier that created it; a URL carrying neither `code`
	 * nor `error` is refused before the transaction is read at all, so a bare
	 * visit to the callback route cannot spend a verifier another tab is still
	 * using.
	 */
	async function exchangeCallback(
		url: string | URL,
	): Promise<Result<OAuthTokenGrant, OAuthClientError>> {
		const callbackUrl = new URL(url);
		if (
			!callbackUrl.searchParams.has('code') &&
			!callbackUrl.searchParams.has('error')
		) {
			return OAuthClientError.MissingCallbackParameters();
		}
		const callbackError = callbackUrl.searchParams.get('error');
		if (callbackError) {
			return OAuthClientError.AuthorizationFailed({
				error: callbackError,
				description: callbackUrl.searchParams.get('error_description'),
			});
		}

		const transaction = await readTransaction();
		if (!transaction) return OAuthClientError.MissingCallbackTransaction();

		// Consume the transaction now, before the exchange can fail. It is
		// single-use (every sign-in mints a fresh verifier via
		// createAuthorizationUrl), so leaving it on a failed or abandoned
		// exchange only strands a code_verifier in durable storage. On Tauri that
		// store is window.localStorage, which never self-clears.
		await storage.removeItem(storageKey);

		try {
			const as = await discover();
			if (callbackUrl.searchParams.get('state') !== transaction.state) {
				return OAuthClientError.StateMismatch();
			}
			const params = oauth.validateAuthResponse(
				as,
				client,
				callbackUrl,
				transaction.state,
			);
			const response = await oauth.authorizationCodeGrantRequest(
				as,
				client,
				oauth.None(),
				params,
				transaction.redirectUri,
				transaction.codeVerifier,
				{
					additionalParameters: { resource },
					...httpOptions,
				},
			);
			const tokenResponse = await oauth.processAuthorizationCodeResponse(
				as,
				client,
				response,
			);
			const { data: grant, error: grantError } = parseOAuthTokenGrant(
				tokenResponse,
				{ now: Date.now },
			);
			if (grantError) {
				return OAuthClientError.TokenExchangeFailed({ cause: grantError });
			}

			return Ok(grant);
		} catch (cause) {
			return OAuthClientError.TokenExchangeFailed({ cause });
		}
	}

	/**
	 * Read and validate the stored transaction before token exchange.
	 *
	 * A corrupt cell is treated like a missing transaction: the callback really
	 * arrived, but the client no longer has the verifier needed to exchange it.
	 */
	async function readTransaction(): Promise<OAuthTransaction | null> {
		const raw = await storage.getItem(storageKey);
		if (!raw) return null;
		try {
			const parsed = JSON.parse(raw) as Partial<OAuthTransaction>;
			if (
				typeof parsed.state !== 'string' ||
				typeof parsed.codeVerifier !== 'string' ||
				typeof parsed.redirectUri !== 'string'
			) {
				return null;
			}
			return {
				state: parsed.state,
				codeVerifier: parsed.codeVerifier,
				redirectUri: parsed.redirectUri,
			};
		} catch {
			return null;
		}
	}

	return {
		createAuthorizationUrl,
		exchangeCallback,
	};
}
