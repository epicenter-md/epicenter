import { INSTANCE_PRINCIPAL_ID } from '@epicenter/identity';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { Ok, type Result } from 'wellcrafted/result';
import type {
	AuthFetch,
	AuthState,
	ConnectionStatus,
} from './auth-contract.js';
import { AuthError } from './auth-errors.js';
import type { BearerAuthorization } from './credential-authority.js';
import { readApiSession } from './read-api-session.js';

const InstanceAuthorityError = defineErrors({
	SubscriberThrew: ({ cause }: { cause: unknown }) => ({
		message: `Instance credential subscriber threw: ${extractErrorMessage(cause)}`,
		cause,
	}),
});

export type InstanceCredentialAuthorityDependencies = {
	fetch?: AuthFetch;
	log?: Logger;
};

export type InstanceCredentialAuthorityOptions = {
	baseURL: string;
	token: string;
};

export type InstanceCredentialSnapshot = {
	state: AuthState;
	connectionStatus: ConnectionStatus;
	networkEligible: boolean;
	tokenGeneration: number;
};

/**
 * Own one static self-host credential without owning its application transport.
 *
 * The authority verifies the token through `/api/session`, keeps the instance
 * principal available during an outage, and compares rejection reports against
 * the generation that authorized the failed request. It deliberately owns no
 * persistence, OAuth launcher, refresh, or revocation behavior.
 */
export function createInstanceCredentialAuthority(
	{
		fetch: fetchImpl = globalThis.fetch.bind(globalThis),
		log = createLogger('auth/instance-credential-authority'),
	}: InstanceCredentialAuthorityDependencies,
	{ baseURL, token }: InstanceCredentialAuthorityOptions,
) {
	let state: AuthState = {
		status: 'signed-in',
		principalId: INSTANCE_PRINCIPAL_ID,
	};
	let connectionStatus: ConnectionStatus = 'connecting';
	let tokenGeneration = 1;
	let verificationFlight:
		| {
				tokenGeneration: number;
				promise: Promise<Result<undefined, AuthError>>;
		  }
		| undefined;
	let currentSnapshot = createSnapshot();
	const changeListeners = new Set<
		(snapshot: InstanceCredentialSnapshot) => void
	>();
	const stateListeners = new Set<(state: AuthState) => void>();
	const connectionListeners = new Set<(status: ConnectionStatus) => void>();

	function createSnapshot(): InstanceCredentialSnapshot {
		return {
			state,
			connectionStatus,
			networkEligible:
				state.status === 'signed-in' && connectionStatus === 'connected',
			tokenGeneration,
		};
	}

	function publish(previous: InstanceCredentialSnapshot) {
		const next = createSnapshot();
		if (snapshotsEqual(previous, next)) return;
		currentSnapshot = next;
		if (!authStatesEqual(previous.state, next.state)) {
			for (const listener of stateListeners) notify(listener, next.state);
		}
		if (previous.connectionStatus !== next.connectionStatus) {
			for (const listener of connectionListeners) {
				notify(listener, next.connectionStatus);
			}
		}
		for (const listener of changeListeners) notify(listener, next);
	}

	function notify<TValue>(listener: (value: TValue) => void, value: TValue) {
		try {
			listener(value);
		} catch (cause) {
			log.error(InstanceAuthorityError.SubscriberThrew({ cause }));
		}
	}

	function update(mutator: () => void) {
		const previous = currentSnapshot;
		mutator();
		publish(previous);
	}

	function deniedAuthorization(): BearerAuthorization {
		if (state.status === 'signed-out' || connectionStatus === 'rejected') {
			return {
				status: 'denied',
				permanence: 'permanent',
				code: 'signed-out',
			};
		}
		return {
			status: 'denied',
			permanence: 'transient',
			code: 'auth-unavailable',
		};
	}

	async function confirmSession(): Promise<Result<undefined, AuthError>> {
		const startedGeneration = tokenGeneration;
		if (verificationFlight?.tokenGeneration === startedGeneration) {
			return verificationFlight.promise;
		}
		update(() => {
			connectionStatus = 'connecting';
		});
		const promise = (async () => {
			const { data: session, error } = await readApiSession({
				baseURL,
				token,
				fetch: fetchImpl,
			});
			if (tokenGeneration !== startedGeneration) return Ok(undefined);
			if (error) {
				update(() => {
					if (error.name === 'Rejected') state = { status: 'signed-out' };
					connectionStatus =
						error.name === 'Rejected' ? 'rejected' : 'unreachable';
				});
				return AuthError.StartSignInFailed({ cause: error });
			}
			update(() => {
				const wasSignedOut = state.status === 'signed-out';
				state = { status: 'signed-in', principalId: session.principalId };
				connectionStatus = 'connected';
				if (wasSignedOut) tokenGeneration += 1;
			});
			return Ok(undefined);
		})().finally(() => {
			if (verificationFlight?.tokenGeneration === startedGeneration) {
				verificationFlight = undefined;
			}
		});
		verificationFlight = { tokenGeneration: startedGeneration, promise };
		return promise;
	}

	async function authorize(): Promise<BearerAuthorization> {
		if (state.status === 'signed-out' || connectionStatus === 'rejected') {
			return deniedAuthorization();
		}
		if (connectionStatus !== 'connected') {
			const verification = await confirmSession();
			if (verification.error) return deniedAuthorization();
		}
		if (state.status !== 'signed-in' || connectionStatus !== 'connected') {
			return deniedAuthorization();
		}
		return {
			status: 'authorized',
			accessToken: token,
			tokenGeneration,
		};
	}

	function snapshotsEqual(
		left: InstanceCredentialSnapshot,
		right: InstanceCredentialSnapshot,
	) {
		return (
			authStatesEqual(left.state, right.state) &&
			left.connectionStatus === right.connectionStatus &&
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

	void confirmSession();

	return {
		baseURL,
		get snapshot(): InstanceCredentialSnapshot {
			return currentSnapshot;
		},
		onChange(fn: (snapshot: InstanceCredentialSnapshot) => void) {
			changeListeners.add(fn);
			return () => {
				changeListeners.delete(fn);
			};
		},
		onStateChange(fn: (state: AuthState) => void) {
			stateListeners.add(fn);
			return () => {
				stateListeners.delete(fn);
			};
		},
		onConnectionChange(fn: (status: ConnectionStatus) => void) {
			connectionListeners.add(fn);
			return () => {
				connectionListeners.delete(fn);
			};
		},
		startSignIn: confirmSession,
		async signOut() {
			update(() => {
				state = { status: 'signed-out' };
				tokenGeneration += 1;
			});
			return Ok(undefined);
		},
		authorize,
		reportRejected(generation: number) {
			if (generation !== tokenGeneration) return;
			update(() => {
				state = { status: 'signed-out' };
				connectionStatus = 'rejected';
			});
		},
		[Symbol.dispose]() {
			changeListeners.clear();
			stateListeners.clear();
			connectionListeners.clear();
		},
	};
}

export type InstanceCredentialAuthority = ReturnType<
	typeof createInstanceCredentialAuthority
>;
