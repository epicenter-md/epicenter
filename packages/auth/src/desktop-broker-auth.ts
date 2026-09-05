import { Ok } from 'wellcrafted/result';
import type {
	AuthClient,
	AuthFetch,
	AuthState,
	ConnectionStatus,
} from './auth-contract.js';
import { AuthError, OpenWebSocketDenied } from './auth-errors.js';
import type { Principal } from './auth-types.js';

/**
 * Non-secret identity projection a desktop window boots with. The Bun
 * authority serializes this into each trusted SPA document at serve time; it
 * never contains a bearer, refresh grant, or instance token.
 */
export type DesktopAuthBootstrap = {
	state: AuthState;
	connection: {
		baseURL: string;
		status: ConnectionStatus;
	};
	networkEligible: boolean;
};

/** Where the Bun authority stamps the boot snapshot into a served document. */
const BOOTSTRAP_ELEMENT_ID = 'epicenter-auth-bootstrap';

/**
 * Read this window's boot snapshot out of the document the host served, and
 * take it out of the DOM.
 *
 * Every compiled application parses the same element, so the parse lives with
 * the client that consumes it rather than being copied per application. The
 * removal is the point of doing it once and eagerly: an identity snapshot has
 * no business sitting in the DOM after boot, and nothing may read it a second
 * time, because which replica a build opens is decided by which build the host
 * served and never by what survives in its `<head>`.
 *
 * A missing or unparseable element throws. A build that calls this is one the
 * desktop host serves, so the snapshot's absence is a broken host contract, not
 * a state to degrade into.
 */
export function readDesktopAuthBootstrap(): DesktopAuthBootstrap {
	const element = document.querySelector<HTMLScriptElement>(
		`#${BOOTSTRAP_ELEMENT_ID}`,
	);
	if (!element) {
		throw new Error('Epicenter did not provide the desktop auth bootstrap.');
	}
	try {
		return JSON.parse(element.textContent ?? '') as DesktopAuthBootstrap;
	} catch (cause) {
		throw new Error('Epicenter provided an invalid desktop auth bootstrap.', {
			cause,
		});
	} finally {
		element.remove();
	}
}

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
 * the authority reads from the selected server. `fetch` attaches nothing:
 * a desktop window has no server transport, and the loopback-only CSP
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
}): AuthClient {
	const baseURL = bootstrap.connection.baseURL;
	const broker = createDesktopBroker({ brokerBaseURL, fetch: fetchImpl });

	return {
		get state() {
			return bootstrap.state;
		},
		connection: {
			baseURL,
			// Identity is immutable per process generation, so the serve-time
			// status is the projection until relaunch.
			get status() {
				return bootstrap.connection.status;
			},
			onChange() {
				return () => undefined;
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
		// server-origin request from a window fails under the loopback-only
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
			throw OpenWebSocketDenied({ code: 'no-credential-model' }).error;
		},
		[Symbol.dispose]() {},
	};
}
