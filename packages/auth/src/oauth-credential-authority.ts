import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { AuthFetch, AuthState } from './auth-contract.js';
import { AuthError } from './auth-errors.js';
import type {
	ApiSessionResponse,
	OAuthTokenGrant,
	PersistedAuth,
} from './auth-types.js';
import type { BearerAuthorization } from './credential-authority.js';
import type { OAuthLauncher } from './oauth-launchers/contract.js';
import {
	refreshOAuthTokenWithEndpoint,
	revokeOAuthRefreshTokenWithEndpoint,
} from './oauth-token-endpoints.js';
import type { PersistedAuthStorage } from './persisted-auth-storage.js';
import {
	type ApiSessionReadError,
	readApiSession,
} from './read-api-session.js';

const REFRESH_SKEW_MS = 60_000;

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

const AuthStateChangeError = defineErrors({
	SubscriberThrew: ({ cause }: { cause: unknown }) => ({
		message: `Auth state subscriber threw: ${extractErrorMessage(cause)}`,
		cause,
	}),
});

export type OAuthCredentialAuthorityDependencies = {
	persistedAuthStorage: PersistedAuthStorage;
	launcher: OAuthLauncher;
	fetch?: AuthFetch;
	log?: Logger;
};

export type OAuthCredentialAuthorityOptions = {
	baseURL?: string;
	clientId: string;
	now?: () => number;
};

export type OAuthCredentialSnapshot = {
	state: AuthState;
	networkEligible: boolean;
	tokenGeneration: number;
};

/**
 * Own one hosted OAuth credential cell without owning an application transport.
 *
 * The authority serializes persistence, refresh, session verification,
 * sign-in, sign-out, and stale-rejection handling. Callers ask for a scoped
 * bearer grant, then perform their own HTTP or WebSocket operation. This lets a
 * browser client and the Epicenter Bun host share credential semantics without
 * proxying application bytes through the authority.
 */
export function createOAuthCredentialAuthority(
	{
		persistedAuthStorage,
		launcher,
		fetch: fetchImpl = globalThis.fetch.bind(globalThis),
		log = createLogger('auth/oauth-credential-authority'),
	}: OAuthCredentialAuthorityDependencies,
	{
		baseURL = EPICENTER_API_URL,
		clientId,
		now = Date.now,
	}: OAuthCredentialAuthorityOptions,
) {
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
				authSession.replaceUnverified(next);
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

			authSession.markVerified();
			return Ok(session);
		})().finally(() => {
			if (identityVerificationFlight?.persistedAuth === startedFrom) {
				identityVerificationFlight = null;
			}
		});
		identityVerificationFlight = { persistedAuth: startedFrom, promise };

		return promise;
	}

	function deniedAuthorization(): BearerAuthorization {
		if (authSession.persistedAuth === null) {
			return {
				status: 'denied',
				permanence: 'permanent',
				code: 'signed-out',
			};
		}
		if (authSession.networkAuthPaused) {
			return {
				status: 'denied',
				permanence: 'permanent',
				code: 'reauth-required',
			};
		}
		return {
			status: 'denied',
			permanence: 'transient',
			code: 'auth-unavailable',
		};
	}

	async function authorize(
		forceRefresh: boolean,
	): Promise<BearerAuthorization> {
		if (authSession.persistedAuth === null || authSession.networkAuthPaused) {
			return deniedAuthorization();
		}
		const refreshed = await refreshGrant(forceRefresh);
		const refreshedPersistedAuth = authSession.persistedAuth;
		if (
			!refreshed ||
			refreshedPersistedAuth === null ||
			authSession.networkAuthPaused
		) {
			return deniedAuthorization();
		}
		let verifiedPersistedAuth = authSession.verifiedPersistedAuth;
		if (verifiedPersistedAuth === null) {
			const verification = await verifyPersistedAuthForNetwork(
				refreshedPersistedAuth,
			);
			if (verification.error) return deniedAuthorization();
			verifiedPersistedAuth = authSession.verifiedPersistedAuth;
			if (verifiedPersistedAuth === null) return deniedAuthorization();
		}
		return {
			status: 'authorized',
			accessToken: verifiedPersistedAuth.grant.accessToken,
			tokenGeneration: authSession.tokenGeneration,
		};
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
		authSession.replaceVerified(next);
		return Ok(undefined);
	}

	return {
		baseURL,
		get snapshot(): OAuthCredentialSnapshot {
			return authSession.snapshot;
		},
		onChange(fn: (snapshot: OAuthCredentialSnapshot) => void) {
			return authSession.onChange(fn);
		},
		onStateChange(fn: (state: AuthState) => void) {
			return authSession.onStateChange(fn);
		},
		async startSignIn() {
			if (signInFlight !== null) return signInFlight;
			const generation = beginSignInGeneration();
			const promise = (async () => {
				try {
					const result = await launcher.startSignIn();
					if (!isCurrentSignIn(generation)) return Ok(undefined);
					if (result.error) {
						return AuthError.StartSignInFailed({ cause: result.error });
					}
					switch (result.data?.status) {
						case 'launched':
							return Ok(undefined);
						case 'completed':
							return completeSignInWithGrant(result.data.grant, generation);
					}
					return AuthError.StartSignInFailed({
						cause: { message: 'OAuth launcher returned no launch result.' },
					});
				} catch (cause) {
					if (!isCurrentSignIn(generation)) return Ok(undefined);
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
		authorize({ forceRefresh = false }: { forceRefresh?: boolean } = {}) {
			return authorize(forceRefresh);
		},
		reportRejected(tokenGeneration: number) {
			if (authSession.tokenGeneration !== tokenGeneration) return;
			authSession.pauseNetworkAuth();
		},
		[Symbol.dispose]() {
			authSession.dispose();
		},
	};
}

export type OAuthCredentialAuthority = ReturnType<
	typeof createOAuthCredentialAuthority
>;

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
	let tokenGeneration = initialPersistedAuth === null ? 0 : 1;
	let currentSnapshot = snapshotFromRuntime(runtimeState, tokenGeneration);
	let storageWriteQueue: Promise<void> = Promise.resolve();
	const changeListeners = new Set<
		(snapshot: OAuthCredentialSnapshot) => void
	>();
	const stateChangeListeners = new Set<(state: AuthState) => void>();

	function publish() {
		const next = snapshotFromRuntime(runtimeState, tokenGeneration);
		if (credentialSnapshotsEqual(currentSnapshot, next)) return;
		const stateChanged = !authStatesEqual(currentSnapshot.state, next.state);
		currentSnapshot = next;
		if (stateChanged) {
			for (const listener of stateChangeListeners) {
				try {
					listener(next.state);
				} catch (error) {
					log.error(AuthStateChangeError.SubscriberThrew({ cause: error }));
				}
			}
		}
		for (const listener of changeListeners) {
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

	function replace(persistedAuth: PersistedAuth, networkAccess: NetworkAccess) {
		runtimeState = { status: 'signed-in', persistedAuth, networkAccess };
		tokenGeneration += 1;
		publish();
	}

	return {
		get snapshot() {
			return currentSnapshot;
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
		get tokenGeneration() {
			return tokenGeneration;
		},
		onChange(fn: (snapshot: OAuthCredentialSnapshot) => void) {
			changeListeners.add(fn);
			return () => {
				changeListeners.delete(fn);
			};
		},
		onStateChange(fn: (state: AuthState) => void) {
			stateChangeListeners.add(fn);
			return () => {
				stateChangeListeners.delete(fn);
			};
		},
		replaceUnverified(persistedAuth: PersistedAuth) {
			replace(persistedAuth, 'unverified');
		},
		replaceVerified(persistedAuth: PersistedAuth) {
			replace(persistedAuth, 'verified');
		},
		markVerified() {
			if (
				runtimeState.status === 'signed-out' ||
				runtimeState.networkAccess === 'verified'
			) {
				return;
			}
			runtimeState = { ...runtimeState, networkAccess: 'verified' };
			publish();
		},
		pauseNetworkAuth() {
			if (
				runtimeState.status === 'signed-out' ||
				runtimeState.networkAccess === 'paused'
			) {
				return;
			}
			runtimeState = { ...runtimeState, networkAccess: 'paused' };
			publish();
		},
		async write(value: PersistedAuth | null) {
			await write(value);
		},
		async clear() {
			if (runtimeState.status !== 'signed-out') {
				runtimeState = { status: 'signed-out' };
				tokenGeneration += 1;
				publish();
			}
			await write(null);
		},
		dispose() {
			changeListeners.clear();
			stateChangeListeners.clear();
		},
	};
}

function snapshotFromRuntime(
	runtimeState: RuntimeAuthState,
	tokenGeneration: number,
): OAuthCredentialSnapshot {
	return {
		state: publicStateFromRuntime(runtimeState),
		networkEligible:
			runtimeState.status === 'signed-in' &&
			runtimeState.networkAccess === 'verified',
		tokenGeneration,
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

function credentialSnapshotsEqual(
	left: OAuthCredentialSnapshot,
	right: OAuthCredentialSnapshot,
) {
	return (
		authStatesEqual(left.state, right.state) &&
		left.networkEligible === right.networkEligible &&
		left.tokenGeneration === right.tokenGeneration
	);
}

function authStatesEqual(left: AuthState, right: AuthState) {
	if (left.status !== right.status) return false;
	if (left.status === 'signed-out') return true;
	if (right.status === 'signed-out') return false;
	return left.principalId === right.principalId;
}
