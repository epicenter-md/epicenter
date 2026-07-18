import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import {
	BEARER_SUBPROTOCOL_PREFIX,
	type OpenWebSocketDenial,
} from '@epicenter/sync/auth-subprotocol';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { AuthFetch, AuthState, SyncAuthClient } from './auth-contract.js';
import { AuthError, OpenWebSocketDenied } from './auth-errors.js';
import type {
	ApiSessionResponse,
	OAuthTokenGrant,
	PersistedAuth,
} from './auth-types.js';
import {
	type AuthFetchInput,
	fetchWithBearer,
	resolveTargetUrl,
} from './bearer-fetch.js';
import type { OAuthLauncher } from './oauth-launchers/contract.js';
import {
	refreshOAuthTokenWithEndpoint,
	revokeOAuthRefreshTokenWithEndpoint,
} from './oauth-token-endpoints.js';
import type { PersistedAuthStorage } from './persisted-auth-storage.js';
import {
	type ApiSessionReadError,
	getProfileVia,
	readApiSession,
} from './read-api-session.js';

/**
 * Construction inputs for the framework-agnostic auth runtime.
 *
 * The caller supplies storage and a launcher. Auth core then owns the durable
 * session cell, refresh, `/api/session` verification, and bearer-bearing
 * transports. Launchers never write persisted identity, and app code never
 * reads raw tokens.
 */
export type CreateOAuthAppAuthConfig = {
	/**
	 * Epicenter API origin. Defaults to the production API and is used for
	 * relative API paths, OAuth refresh/revoke routes, and session verification.
	 */
	baseURL?: string;
	/**
	 * Public OAuth client id registered for this runtime.
	 */
	clientId: string;
	/**
	 * Durable storage for the single persisted auth cell.
	 */
	persistedAuthStorage: PersistedAuthStorage;
	/**
	 * Runtime-specific sign-in transport. It either returns a token grant or
	 * reports that control has moved to a later redirect/deep-link callback.
	 */
	launcher: OAuthLauncher;
	/**
	 * Fetch implementation for API session, refresh, revoke, and authenticated
	 * resource calls.
	 */
	fetch?: AuthFetch;
	/**
	 * WebSocket constructor. Tests and non-browser runtimes inject this because
	 * browsers do not allow request headers during WebSocket upgrades.
	 */
	WebSocket?: typeof WebSocket;
	/**
	 * Clock used for refresh-skew checks and refresh-token grant parsing.
	 */
	now?: () => number;
	/**
	 * Library logger for subscriber and refresh failures.
	 */
	log?: Logger;
};

const REFRESH_SKEW_MS = 60_000;

const AuthStateChangeError = defineErrors({
	SubscriberThrew: ({ cause }: { cause: unknown }) => ({
		message: `Auth state subscriber threw: ${extractErrorMessage(cause)}`,
		cause,
	}),
});

type NetworkAccess = 'unverified' | 'verified' | 'paused';

type RuntimeAuthState =
	| { status: 'signed-out' }
	| {
			status: 'signed-in';
			persistedAuth: PersistedAuth;
			networkAccess: NetworkAccess;
	  };

type RefreshFlight = {
	persistedAuth: PersistedAuth;
	promise: Promise<boolean>;
};

type IdentityVerificationFlight = {
	persistedAuth: PersistedAuth;
	promise: Promise<ApiSessionReadResult>;
};

type ApiSessionReadResult = Result<ApiSessionResponse, ApiSessionReadError>;

/**
 * Create the app-side auth boundary for browser, extension, and machine clients.
 *
 * Use this once per runtime around one persisted auth record. The returned
 * client exposes capabilities (`fetch`, `openWebSocket`) instead of raw tokens:
 * it refreshes grants, verifies `/api/session` before attaching a bearer, and
 * keeps the cached principal id available when network auth pauses. That
 * preserves the local-first invariant: offline workspace boot can continue,
 * but server access fails closed until the current persisted auth has been
 * verified by the API.
 */
export function createOAuthAppAuth({
	baseURL = EPICENTER_API_URL,
	clientId,
	persistedAuthStorage,
	launcher,
	fetch: fetchImpl = globalThis.fetch.bind(globalThis),
	WebSocket: WebSocketImpl = globalThis.WebSocket,
	now = Date.now,
	log = createLogger('auth/oauth-app'),
}: CreateOAuthAppAuthConfig): SyncAuthClient {
	const epicenterOrigin = new URL(baseURL).origin;
	const authSession = createAuthSessionRuntime({
		initialPersistedAuth: persistedAuthStorage.initial,
		persistedAuthStorage,
		log,
	});
	let refreshFlight: RefreshFlight | null = null;
	let identityVerificationFlight: IdentityVerificationFlight | null = null;
	let signInFlight: Promise<Result<undefined, AuthError>> | null = null;
	let signInGeneration = 0;

	function beginSignInGeneration() {
		signInGeneration += 1;
		return signInGeneration;
	}

	function isCurrentSignIn(generation: number) {
		return signInGeneration === generation;
	}

	function cancelInFlightSignIn() {
		signInGeneration += 1;
		signInFlight = null;
	}

	async function clearAuthSession() {
		refreshFlight = null;
		identityVerificationFlight = null;
		await authSession.clear();
	}

	async function clearPersistedAuth() {
		cancelInFlightSignIn();
		await clearAuthSession();
	}

	async function refreshGrant(force: boolean): Promise<boolean> {
		const startedFrom = authSession.persistedAuth;
		if (startedFrom === null || authSession.networkAuthPaused) return false;
		if (
			!force &&
			startedFrom.grant.accessTokenExpiresAt > now() + REFRESH_SKEW_MS
		) {
			return true;
		}
		if (refreshFlight?.persistedAuth === startedFrom) {
			return refreshFlight.promise;
		}

		const promise = (async () => {
			try {
				const grant = await refreshOAuthTokenWithEndpoint({
					baseURL,
					clientId,
					grant: startedFrom.grant,
					fetch: fetchImpl,
					now,
				});
				if (authSession.persistedAuth !== startedFrom) return false;
				const next = {
					grant,
					principalId: startedFrom.principalId,
				} satisfies PersistedAuth;
				await authSession.write(next);
				if (authSession.persistedAuth !== startedFrom) return false;
				authSession.installUnverified(next);
				return true;
			} catch (cause) {
				if (authSession.persistedAuth === startedFrom) {
					authSession.pauseNetworkAuth();
					log.error(AuthError.RefreshGrantFailed({ cause }));
				}
				return false;
			} finally {
				if (refreshFlight?.persistedAuth === startedFrom) {
					refreshFlight = null;
				}
			}
		})();
		refreshFlight = { persistedAuth: startedFrom, promise };

		return promise;
	}

	/**
	 * Verify `/api/session` against the current persisted auth. Marks it
	 * verified and wipes storage when the server resolves a different principal.
	 * Single-flight: concurrent callers for the same persisted auth share the
	 * in-flight promise.
	 */
	async function verifyPersistedAuthForNetwork(
		startedFrom: PersistedAuth,
	): Promise<ApiSessionReadResult> {
		if (identityVerificationFlight?.persistedAuth === startedFrom) {
			return identityVerificationFlight.promise;
		}
		const promise = (async (): Promise<ApiSessionReadResult> => {
			const { data: session, error } = await readApiSession({
				baseURL,
				fetch: fetchImpl,
				token: startedFrom.grant.accessToken,
			});
			if (error) {
				if (
					error.name === 'Rejected' &&
					authSession.persistedAuth === startedFrom
				) {
					authSession.pauseNetworkAuth();
				}
				return Err(error);
			}
			const current = authSession.persistedAuth;
			if (current !== startedFrom) return Ok(session);

			if (current.principalId !== session.principalId) {
				await clearPersistedAuth();
				return Ok(session);
			}

			authSession.installVerified(current);
			return Ok(session);
		})().finally(() => {
			if (identityVerificationFlight?.persistedAuth === startedFrom) {
				identityVerificationFlight = null;
			}
		});
		identityVerificationFlight = { persistedAuth: startedFrom, promise };

		return promise;
	}

	/**
	 * Network gate. Returns the access token to attach to a bearer-bearing
	 * request, or `null` if no bearer should be attached.
	 *
	 * Refuses to attach unless `/api/session` has confirmed the current persisted
	 * auth in this runtime. Cold boot online: refresh grant if
	 * stale, call `/api/session`, then attach. Offline: fails closed; local
	 * workspace boot continues via the cached principal id.
	 */
	async function bearerForNetwork(force: boolean): Promise<string | null> {
		if (authSession.persistedAuth === null || authSession.networkAuthPaused) {
			return null;
		}
		const refreshed = await refreshGrant(force);
		const refreshedPersistedAuth = authSession.persistedAuth;
		if (
			!refreshed ||
			refreshedPersistedAuth === null ||
			authSession.networkAuthPaused
		) {
			return null;
		}
		let verifiedPersistedAuth = authSession.verifiedPersistedAuth;
		if (verifiedPersistedAuth === null) {
			const verification = await verifyPersistedAuthForNetwork(
				refreshedPersistedAuth,
			);
			if (verification.error) return null;
			verifiedPersistedAuth = authSession.verifiedPersistedAuth;
			if (verifiedPersistedAuth === null) return null;
		}
		return verifiedPersistedAuth.grant.accessToken;
	}

	/**
	 * The Epicenter bearer is audience-scoped (ADR-0053): it is attached only to
	 * the origin this client signed into. A request to any other origin is sent
	 * with no Epicenter credential, so handing this fetch to a custom inference
	 * backend or any third party can never leak the token.
	 */
	function targetsEpicenter(input: AuthFetchInput): boolean {
		return resolveTargetUrl(input, baseURL)?.origin === epicenterOrigin;
	}

	function fetchWithAuth(input: AuthFetchInput, init: RequestInit | undefined) {
		return fetchWithBearer({
			input,
			init,
			fetch: fetchImpl,
			baseURL,
			epicenterOrigin,
			resolveToken: () => bearerForNetwork(false),
		});
	}

	/**
	 * Fetch an Epicenter resource through the bearer boundary, with the API's own
	 * 401 dance: one forced refresh, one retry, and a pause if it still rejects. A
	 * non-Epicenter 401 is not ours to react to. This is the client's `fetch`;
	 * `getProfile` reuses it so a profile read refreshes a stale token too.
	 */
	async function authedFetch(input: AuthFetchInput, init?: RequestInit) {
		const response = await fetchWithAuth(input, init);
		if (response.status !== 401 || !targetsEpicenter(input)) return response;
		const refreshed = await refreshGrant(true);
		if (!refreshed) return response;
		const retryResponse = await fetchWithAuth(input, init);
		if (retryResponse.status === 401) {
			authSession.pauseNetworkAuth();
		}
		return retryResponse;
	}

	async function completeSignInWithGrant(
		grant: OAuthTokenGrant,
		generation: number,
	): Promise<Result<undefined, AuthError>> {
		if (!isCurrentSignIn(generation)) return Ok(undefined);
		const previous = authSession.persistedAuth;
		const { data: session, error } = await readApiSession({
			baseURL,
			fetch: fetchImpl,
			token: grant.accessToken,
		});
		if (error) {
			return AuthError.StartSignInFailed({ cause: error });
		}
		if (!isCurrentSignIn(generation)) return Ok(undefined);
		if (previous !== null && previous.principalId !== session.principalId) {
			await clearAuthSession();
			if (!isCurrentSignIn(generation)) return Ok(undefined);
		}
		const next = {
			grant,
			principalId: session.principalId,
		} satisfies PersistedAuth;
		await authSession.write(next);
		if (!isCurrentSignIn(generation)) return Ok(undefined);
		authSession.installVerified(next);
		return Ok(undefined);
	}

	return {
		get state() {
			return authSession.state;
		},
		// OAuth runs only against the hosted star (ADR-0071), so this client is
		// hosted by construction.
		deployment: { kind: 'hosted', baseURL },
		onStateChange(fn) {
			return authSession.onStateChange(fn);
		},
		async startSignIn() {
			if (signInFlight !== null) return signInFlight;
			const generation = beginSignInGeneration();
			const promise = (async () => {
				try {
					const result = await launcher.startSignIn();
					if (!isCurrentSignIn(generation)) {
						return Ok(undefined);
					}
					if (result.error) {
						return AuthError.StartSignInFailed({ cause: result.error });
					}
					const launchResult = result.data;
					switch (launchResult?.status) {
						case 'launched':
							return Ok(undefined);
						case 'completed':
							return completeSignInWithGrant(launchResult.grant, generation);
					}
					return AuthError.StartSignInFailed({
						cause: { message: 'OAuth launcher returned no launch result.' },
					});
				} catch (cause) {
					if (!isCurrentSignIn(generation)) {
						return Ok(undefined);
					}
					return AuthError.StartSignInFailed({ cause });
				}
			})().finally(() => {
				if (signInFlight === promise) signInFlight = null;
			});
			signInFlight = promise;
			return promise;
		},
		async signOut() {
			try {
				const refreshTokenToRevoke =
					authSession.persistedAuth?.grant.refreshToken;
				await clearPersistedAuth();
				if (refreshTokenToRevoke) {
					void revokeOAuthRefreshTokenWithEndpoint({
						baseURL,
						clientId,
						refreshToken: refreshTokenToRevoke,
						fetch: fetchImpl,
					}).catch(() => undefined);
				}
				return Ok(undefined);
			} catch (cause) {
				return AuthError.SignOutFailed({ cause });
			}
		},
		fetch: authedFetch,
		getProfile: () => getProfileVia(authedFetch, baseURL),
		async openWebSocket(url, protocols = []) {
			const accessToken = await bearerForNetwork(false);
			if (!accessToken) {
				// Never open credential-less: the socket would only eat a doomed
				// round trip and a server 4401. Reject with the typed denial the
				// sync supervisor classifies. `bearerForNetwork` already paused
				// network auth on every definitive rejection (refresh refused,
				// /api/session 401), so any still-signed-in null here means
				// verification was unreachable: the grant may be fine, retry.
				const permanent =
					authSession.persistedAuth === null || authSession.networkAuthPaused;
				const denial: OpenWebSocketDenial = OpenWebSocketDenied({
					permanence: permanent ? 'permanent' : 'transient',
					code:
						authSession.persistedAuth === null
							? 'signed-out'
							: permanent
								? 'reauth-required'
								: 'auth-unavailable',
				}).error;
				throw denial;
			}
			return new WebSocketImpl(String(url), [
				...protocols,
				`${BEARER_SUBPROTOCOL_PREFIX}${accessToken}`,
			]);
		},
		[Symbol.dispose]() {
			authSession.dispose();
		},
	};
}

/**
 * Owns the in-memory projection of the persisted auth cell.
 *
 * This is a one-caller helper, but it earns the boundary by keeping the storage
 * write queue, listener fan-out, and public state projection in one small
 * runtime object. OAuth flow code mutates the runtime through verbs instead of
 * rewriting state shapes directly.
 */
function createAuthSessionRuntime({
	initialPersistedAuth,
	persistedAuthStorage,
	log,
}: {
	initialPersistedAuth: PersistedAuth | null;
	persistedAuthStorage: PersistedAuthStorage;
	log: Logger;
}) {
	let runtimeState: RuntimeAuthState =
		initialPersistedAuth === null
			? { status: 'signed-out' }
			: {
					status: 'signed-in',
					persistedAuth: initialPersistedAuth,
					networkAccess: 'unverified',
				};
	let publicState = publicStateFromRuntime(runtimeState);
	let storageWriteQueue: Promise<void> = Promise.resolve();
	const stateChangeListeners = new Set<(state: AuthState) => void>();

	function publishState() {
		const next = publicStateFromRuntime(runtimeState);
		if (authStatesEqual(publicState, next)) return;
		publicState = next;
		for (const listener of stateChangeListeners) {
			try {
				listener(next);
			} catch (error) {
				log.error(AuthStateChangeError.SubscriberThrew({ cause: error }));
			}
		}
	}

	async function write(value: PersistedAuth | null) {
		const pendingWrite = storageWriteQueue.then(() =>
			persistedAuthStorage.set(value),
		);
		storageWriteQueue = pendingWrite.catch(() => undefined);
		await pendingWrite;
	}

	return {
		get state() {
			return publicState;
		},
		get persistedAuth(): PersistedAuth | null {
			return runtimeState.status === 'signed-out'
				? null
				: runtimeState.persistedAuth;
		},
		get networkAuthPaused() {
			return (
				runtimeState.status === 'signed-in' &&
				runtimeState.networkAccess === 'paused'
			);
		},
		get verifiedPersistedAuth(): PersistedAuth | null {
			if (runtimeState.status === 'signed-out') return null;
			if (runtimeState.networkAccess !== 'verified') return null;
			return runtimeState.persistedAuth;
		},
		onStateChange(fn: (state: AuthState) => void) {
			stateChangeListeners.add(fn);
			return () => {
				stateChangeListeners.delete(fn);
			};
		},
		installUnverified(persistedAuth: PersistedAuth) {
			runtimeState = {
				status: 'signed-in',
				persistedAuth,
				networkAccess: 'unverified',
			};
			publishState();
		},
		installVerified(persistedAuth: PersistedAuth) {
			runtimeState = {
				status: 'signed-in',
				persistedAuth,
				networkAccess: 'verified',
			};
			publishState();
		},
		pauseNetworkAuth() {
			if (runtimeState.status === 'signed-out') return;
			runtimeState = {
				...runtimeState,
				networkAccess: 'paused',
			};
			publishState();
		},
		async write(value: PersistedAuth | null) {
			await write(value);
		},
		async clear() {
			runtimeState = { status: 'signed-out' };
			publishState();
			await write(null);
		},
		dispose() {
			stateChangeListeners.clear();
		},
	};
}

function publicStateFromRuntime(runtimeState: RuntimeAuthState): AuthState {
	if (runtimeState.status === 'signed-out') return { status: 'signed-out' };
	if (runtimeState.networkAccess === 'paused') {
		return {
			status: 'reauth-required',
			principalId: runtimeState.persistedAuth.principalId,
		};
	}
	return {
		status: 'signed-in',
		principalId: runtimeState.persistedAuth.principalId,
	};
}

function authStatesEqual(left: AuthState, right: AuthState) {
	if (left.status !== right.status) return false;
	if (left.status === 'signed-out') return true;
	if (right.status === 'signed-out') return false;
	return left.principalId === right.principalId;
}
