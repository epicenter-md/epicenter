import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import {
	BEARER_SUBPROTOCOL_PREFIX,
	type OpenWebSocketDenial,
} from '@epicenter/sync/auth-subprotocol';
import type { Logger } from 'wellcrafted/logger';
import type {
	AuthClient,
	AuthFetch,
	CallbackAuthClient,
} from './auth-contract.js';
import { OpenWebSocketDenied } from './auth-errors.js';
import {
	type AuthFetchInput,
	fetchWithBearer,
	resolveTargetUrl,
} from './bearer-fetch.js';
import type { BearerAuthorization } from './credential-authority.js';
import { createOAuthCredentialAuthority } from './oauth-credential-authority.js';
import type {
	CallbackOAuthLauncher,
	OAuthLauncher,
} from './oauth-launchers/contract.js';
import type { PersistedAuthStorage } from './persisted-auth-storage.js';
import { getProfileVia } from './read-api-session.js';

/** Construction inputs for the framework-agnostic hosted OAuth client. */
export type CreateOAuthAppAuthConfig = {
	/**
	 * Epicenter API origin. Defaults to the production API and is used for
	 * relative API paths, OAuth refresh/revoke routes, and session verification.
	 */
	baseURL?: string;
	/** Public OAuth client id registered for this runtime. */
	clientId: string;
	/** Durable storage for the single persisted auth cell. */
	persistedAuthStorage: PersistedAuthStorage;
	/**
	 * Runtime-specific sign-in transport. It either returns a token grant or
	 * reports that control moved to a later redirect or deep-link callback.
	 *
	 * A launcher that can consume that callback ({@link CallbackOAuthLauncher})
	 * is what makes the composed client a {@link CallbackAuthClient}. The
	 * overloads below read exactly this.
	 */
	launcher: OAuthLauncher;
	/**
	 * Fetch implementation for session verification, refresh, revoke, and local
	 * authenticated resource calls.
	 */
	fetch?: AuthFetch;
	/**
	 * WebSocket constructor. Tests and non-browser runtimes inject this because
	 * browsers do not allow request headers during WebSocket upgrades.
	 */
	WebSocket?: typeof WebSocket;
	/** Clock used for refresh-skew checks and grant parsing. */
	now?: () => number;
	/** Library logger for subscriber and refresh failures. */
	log?: Logger;
};

export function createOAuthAppAuth(
	config: CreateOAuthAppAuthConfig & { launcher: CallbackOAuthLauncher },
): CallbackAuthClient;
export function createOAuthAppAuth(
	config: CreateOAuthAppAuthConfig,
): AuthClient;
/**
 * Compose one hosted OAuth credential authority with local HTTP and WebSocket
 * transports. Application bytes stay in the injected browser-compatible
 * implementations; the authority supplies only transient bearer grants. The
 * cached principal remains available for offline workspace boot, while server
 * access fails closed until `/api/session` verifies the current credential.
 *
 * The launcher decides whether the result can finish an OAuth callback, and the
 * overloads above say so statically. A launcher that completes inline (the
 * extension web-auth flow) yields a plain `AuthClient` with no `completeSignIn`
 * on it at all, rather than one that would have to refuse the call.
 */
export function createOAuthAppAuth({
	baseURL = EPICENTER_API_URL,
	clientId,
	persistedAuthStorage,
	launcher,
	fetch: fetchImpl = globalThis.fetch.bind(globalThis),
	WebSocket: WebSocketImpl = globalThis.WebSocket,
	now = Date.now,
	log,
}: CreateOAuthAppAuthConfig): AuthClient {
	const epicenterOrigin = new URL(baseURL).origin;
	const authority = createOAuthCredentialAuthority(
		{ persistedAuthStorage, launcher, fetch: fetchImpl, log },
		{ baseURL, clientId, now },
	);

	function targetsEpicenter(input: AuthFetchInput): boolean {
		return resolveTargetUrl(input, baseURL)?.origin === epicenterOrigin;
	}

	async function fetchWithAuth(
		input: AuthFetchInput,
		init: RequestInit | undefined,
		providedAuthorization?: BearerAuthorization,
	) {
		let authorization = providedAuthorization;
		const response = await fetchWithBearer({
			input,
			init,
			fetch: fetchImpl,
			baseURL,
			epicenterOrigin,
			resolveToken: async () => {
				authorization ??= await authority.authorize();
				return authorization.status === 'authorized'
					? authorization.accessToken
					: null;
			},
		});
		return { response, authorization };
	}

	async function authedFetch(input: AuthFetchInput, init?: RequestInit) {
		const first = await fetchWithAuth(input, init);
		if (first.response.status !== 401 || !targetsEpicenter(input)) {
			return first.response;
		}
		const refreshed = await authority.authorize({ forceRefresh: true });
		if (refreshed.status === 'denied') return first.response;
		const retry = await fetchWithAuth(input, init, refreshed);
		if (retry.response.status === 401) {
			authority.reportRejected(refreshed.tokenGeneration);
		}
		return retry.response;
	}

	return {
		get state() {
			return authority.snapshot.state;
		},
		connection: {
			baseURL,
			get status() {
				return 'connected' as const;
			},
			onChange() {
				return () => undefined;
			},
		},
		onStateChange(fn) {
			return authority.onStateChange(fn);
		},
		startSignIn() {
			return authority.startSignIn();
		},
		// Spread rather than declared, so the member is ABSENT on a client whose
		// launcher cannot complete a callback. `isCallbackAuthClient` is a
		// runtime read of exactly this, which is what lets one callback route
		// serve a browser build and a desktop build honestly.
		...(authority.completeSignIn === undefined
			? {}
			: { completeSignIn: authority.completeSignIn }),
		signOut() {
			return authority.signOut();
		},
		fetch: authedFetch,
		getProfile: () => getProfileVia(authedFetch, baseURL),
		async openWebSocket(url, protocols = []) {
			const authorization = await authority.authorize();
			if (authorization.status === 'denied') {
				const denial: OpenWebSocketDenial = OpenWebSocketDenied({
					permanence: authorization.permanence,
					code: authorization.code,
				}).error;
				throw denial;
			}
			return new WebSocketImpl(String(url), [
				...protocols,
				`${BEARER_SUBPROTOCOL_PREFIX}${authorization.accessToken}`,
			]);
		},
		[Symbol.dispose]() {
			authority[Symbol.dispose]();
		},
	};
}
