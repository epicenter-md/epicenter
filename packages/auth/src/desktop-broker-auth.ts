import { Ok } from 'wellcrafted/result';
import type { AuthFetch, AuthState, SyncAuthClient } from './auth-contract.js';
import { AuthError, OpenWebSocketDenied } from './auth-errors.js';
import type { Principal } from './auth-types.js';
import type { InstanceSetting } from './instance-setting.js';

/**
 * Non-secret identity projection a desktop window boots with. The Bun
 * authority serializes this into each trusted SPA document at serve time; it
 * never contains a bearer, refresh grant, or instance token.
 */
export type DesktopAuthBootstrap = {
	state: AuthState;
	deployment:
		| { kind: 'hosted'; baseURL: string }
		| {
				kind: 'self-hosted';
				baseURL: string;
				connectionStatus:
					| 'connecting'
					| 'connected'
					| 'unreachable'
					| 'rejected';
		  };
	networkEligible: boolean;
};

function createDesktopBroker({
	brokerBaseURL,
	fetch,
}: {
	brokerBaseURL: string;
	fetch: AuthFetch;
}) {
	return async function broker<T>(path: string, body?: unknown): Promise<T> {
		const response = await fetch(new URL(path, brokerBaseURL), {
			method: body === undefined ? 'GET' : 'POST',
			credentials: 'include',
			headers:
				body === undefined ? undefined : { 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		if (!response.ok) {
			throw new Error(`Desktop auth broker failed (${response.status}).`);
		}
		if (!response.headers.get('content-type')?.includes('application/json')) {
			return undefined as T;
		}
		return (await response.json()) as T;
	};
}

/**
 * Construct one window-local projection of the process-wide Bun credential
 * authority.
 *
 * No credential crosses this boundary in either direction: identity is the
 * serve-time boot snapshot, account commands (sign-in, sign-out, instance
 * selection) are same-origin broker POSTs the authority acts on before
 * relaunching the process, and the profile email is a same-origin projection
 * the authority reads from the deployment itself. `fetch` attaches nothing:
 * a desktop window has no deployment transport, and the loopback-only CSP
 * refuses cloud origins exactly as it did before this client existed.
 * `openWebSocket` is denied for the same reason: desktop sync belongs to the
 * host process, not a window.
 */
export function createDesktopBrokerAuth({
	bootstrap,
	brokerBaseURL,
	fetch: fetchImpl = globalThis.fetch.bind(globalThis),
}: {
	bootstrap: DesktopAuthBootstrap;
	brokerBaseURL: string;
	fetch?: AuthFetch;
}): SyncAuthClient {
	const baseURL = bootstrap.deployment.baseURL;
	const broker = createDesktopBroker({ brokerBaseURL, fetch: fetchImpl });

	return {
		get state() {
			return bootstrap.state;
		},
		deployment:
			bootstrap.deployment.kind === 'hosted'
				? bootstrap.deployment
				: {
						kind: 'self-hosted',
						baseURL,
						connection: {
							// Identity is immutable per process generation, so the
							// serve-time status is the projection until relaunch.
							status: bootstrap.deployment.connectionStatus,
							onChange() {
								return () => undefined;
							},
						},
					},
		onStateChange() {
			return () => undefined;
		},
		async startSignIn() {
			try {
				await broker('/_epicenter/account/sign-in', {});
				return Ok(undefined);
			} catch (cause) {
				return AuthError.StartSignInFailed({ cause });
			}
		},
		async signOut() {
			try {
				await broker('/_epicenter/account/sign-out', {});
				return Ok(undefined);
			} catch (cause) {
				return AuthError.SignOutFailed({ cause });
			}
		},
		// Pass-through on purpose: nothing here may attach a credential. A
		// deployment-origin request from a window fails under the loopback-only
		// CSP, which is the boundary this client exists to preserve.
		fetch: (input, init) => fetchImpl(input, init),
		async getProfile() {
			try {
				return Ok(await broker<Principal>('/_epicenter/account/profile'));
			} catch (cause) {
				return AuthError.ProfileUnavailable({ cause });
			}
		},
		async openWebSocket() {
			throw OpenWebSocketDenied({
				permanence: 'permanent',
				code: 'auth-unavailable',
			}).error;
		},
		[Symbol.dispose]() {},
	};
}

/**
 * Project the immutable desktop deployment into the shared account UI.
 * Reads expose only the selected URL. Writes ask Bun to persist the next
 * process generation, so the self-hosted bearer never enters a WebView boot
 * snapshot or localStorage.
 */
export function createDesktopInstanceSetting({
	bootstrap,
	brokerBaseURL,
	fetch: fetchImpl = globalThis.fetch.bind(globalThis),
}: {
	bootstrap: DesktopAuthBootstrap;
	brokerBaseURL: string;
	fetch?: AuthFetch;
}): InstanceSetting {
	const broker = createDesktopBroker({ brokerBaseURL, fetch: fetchImpl });
	const selected = { baseURL: bootstrap.deployment.baseURL };
	return {
		read: () => selected,
		isDefault: () => bootstrap.deployment.kind === 'hosted',
		write(next) {
			if (next.token === undefined) {
				throw new Error('A self-hosted Epicenter instance requires a token.');
			}
			return broker('/_epicenter/account/instance', {
				baseURL: next.baseURL,
				token: next.token,
			});
		},
		clear() {
			return fetchImpl(new URL('/_epicenter/account/instance', brokerBaseURL), {
				method: 'DELETE',
				credentials: 'include',
			}).then((response) => {
				if (!response.ok) {
					throw new Error(`Desktop auth broker failed (${response.status}).`);
				}
			});
		},
	};
}
