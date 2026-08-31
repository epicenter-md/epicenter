import {
	type AuthFetch,
	type AuthState,
	assertStrongToken,
	type ConnectionStatus,
	createInstanceCredentialAuthority,
	createOAuthCredentialAuthority,
	createSerializedPersistedAuthStorage,
	normalizeInstanceUrl,
} from '@epicenter/auth';
import { createOAuthClient } from '@epicenter/auth/oauth-launchers';
import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import {
	EPICENTER_DESKTOP_OAUTH_CLIENT_ID,
	EPICENTER_DESKTOP_TAURI_OAUTH_REDIRECT_URI,
} from '@epicenter/constants/oauth-clients';
import { Ok } from 'wellcrafted/result';
import type { NativeAuthPort } from './sidecar-runtime.ts';

const CALLBACK_TIMEOUT_MS = 10 * 60 * 1_000;

export type DesktopAuthBootSnapshot = {
	state: AuthState;
	connection: { baseURL: string; status: ConnectionStatus };
	networkEligible: boolean;
};

/**
 * Own the hosted desktop credential for one immutable process generation.
 * Windows receive only the boot snapshot and use same-origin account broker
 * operations that never expose a bearer. Account changes persist the next cell
 * and relaunch.
 */
export function createDesktopAuthAuthority({
	authCell,
	nativeAuthPort,
	fetch = globalThis.fetch.bind(globalThis),
}: {
	authCell: string | null;
	nativeAuthPort: NativeAuthPort;
	fetch?: AuthFetch;
}) {
	const record = readDesktopRecord(authCell);
	if ('token' in record) {
		return createSelfHostedDesktopAuthority({
			fetch,
			nativeAuthPort,
			record,
		});
	}
	const oauthTransaction = new Map<string, string>();
	let queuedCallback: string | null = null;
	let callbackWaiter: ((url: string) => void) | null = null;
	const stopCallbacks = nativeAuthPort.onOAuthCallback((url) => {
		if (callbackWaiter === null) queuedCallback = url;
		else {
			const resolve = callbackWaiter;
			callbackWaiter = null;
			resolve(url);
		}
	});
	const oauthClient = createOAuthClient({
		issuer: `${EPICENTER_API_URL}/auth`,
		clientId: EPICENTER_DESKTOP_OAUTH_CLIENT_ID,
		resource: EPICENTER_API_URL,
		fetch,
		storage: {
			getItem(key) {
				return oauthTransaction.get(key) ?? null;
			},
			setItem(key, value) {
				oauthTransaction.set(key, value);
			},
			removeItem(key) {
				oauthTransaction.delete(key);
			},
		},
	});
	const authority = createOAuthCredentialAuthority(
		{
			fetch,
			persistedAuthStorage: createSerializedPersistedAuthStorage({
				initial: record.persistedAuth,
				write: (serialized) =>
					nativeAuthPort.storeAuth(writeHostedRecord(serialized)),
			}),
			launcher: {
				async startSignIn() {
					const { data: url, error } = await oauthClient.createAuthorizationUrl(
						EPICENTER_DESKTOP_TAURI_OAUTH_REDIRECT_URI,
					);
					if (error) return { data: null, error };
					await nativeAuthPort.openAuthUrl(url.toString());
					const callback = await waitForCallback();
					const grant = await oauthClient.exchangeCallback(callback);
					if (grant.error) return grant;
					return Ok({ status: 'completed', grant: grant.data } as const);
				},
			},
		},
		{
			baseURL: EPICENTER_API_URL,
			clientId: EPICENTER_DESKTOP_OAUTH_CLIENT_ID,
		},
	);
	const bootSnapshot = {
		state: authority.snapshot.state,
		connection: { baseURL: EPICENTER_API_URL, status: 'connected' as const },
		networkEligible: authority.snapshot.networkEligible,
	} satisfies DesktopAuthBootSnapshot;

	function waitForCallback(): Promise<string> {
		if (queuedCallback !== null) {
			const callback = queuedCallback;
			queuedCallback = null;
			return Promise.resolve(callback);
		}
		return new Promise<string>((resolve, reject) => {
			const timeout = setTimeout(() => {
				if (callbackWaiter !== settle) return;
				callbackWaiter = null;
				reject(new Error('Timed out waiting for the desktop OAuth callback.'));
			}, CALLBACK_TIMEOUT_MS);
			const settle = (url: string) => {
				clearTimeout(timeout);
				resolve(url);
			};
			callbackWaiter = settle;
		});
	}

	return {
		baseURL: EPICENTER_API_URL,
		bootSnapshot,
		authorize(options?: { forceRefresh?: boolean }) {
			return authority.authorize(options);
		},
		reportRejected(tokenGeneration: number) {
			authority.reportRejected(tokenGeneration);
		},
		async startSignIn() {
			const result = await authority.startSignIn();
			if (!result.error && authority.snapshot.state.status === 'signed-in') {
				nativeAuthPort.relaunch();
			}
			return result;
		},
		async signOut() {
			const result = await authority.signOut();
			if (!result.error) nativeAuthPort.relaunch();
			return result;
		},
		selectInstance(input: { baseURL: string; token: string }) {
			return selectInstance(nativeAuthPort, input);
		},
		async selectHosted() {
			await nativeAuthPort.storeAuth(writeHostedRecord(null));
			nativeAuthPort.relaunch();
		},
		[Symbol.dispose]() {
			stopCallbacks();
			authority[Symbol.dispose]();
		},
	};
}

export type DesktopAuthAuthority = ReturnType<
	typeof createDesktopAuthAuthority
>;

type DesktopAuthRecord =
	| {
			deployment: { kind: 'hosted' };
			persistedAuth: string | null;
	  }
	| {
			deployment: { kind: 'self-hosted'; baseURL: string };
			token: string;
	  };

function readDesktopRecord(authCell: string | null): DesktopAuthRecord {
	if (authCell === null) {
		return { deployment: { kind: 'hosted' }, persistedAuth: null };
	}
	try {
		const value = JSON.parse(authCell) as unknown;
		if (
			typeof value === 'object' &&
			value !== null &&
			'deployment' in value &&
			'persistedAuth' in value
		) {
			const record = value as {
				deployment?: { kind?: unknown };
				persistedAuth?: unknown;
			};
			if (record.deployment?.kind === 'hosted') {
				return {
					deployment: { kind: 'hosted' },
					persistedAuth:
						record.persistedAuth === null
							? null
							: JSON.stringify(record.persistedAuth),
				};
			}
		}
		if (
			typeof value === 'object' &&
			value !== null &&
			'deployment' in value &&
			'token' in value
		) {
			const record = value as {
				deployment?: { kind?: unknown; baseURL?: unknown };
				token?: unknown;
			};
			if (
				record.deployment?.kind === 'self-hosted' &&
				typeof record.deployment.baseURL === 'string' &&
				typeof record.token === 'string'
			) {
				const normalized = normalizeInstanceUrl(record.deployment.baseURL);
				if (!normalized.error) {
					return {
						deployment: {
							kind: 'self-hosted',
							baseURL: normalized.data,
						},
						token: assertStrongToken(record.token),
					};
				}
			}
		}
		return { deployment: { kind: 'hosted' }, persistedAuth: authCell };
	} catch {
		return { deployment: { kind: 'hosted' }, persistedAuth: null };
	}
}

function writeHostedRecord(serialized: string | null): string {
	return JSON.stringify({
		deployment: { kind: 'hosted' },
		persistedAuth: serialized === null ? null : JSON.parse(serialized),
	});
}

function createSelfHostedDesktopAuthority({
	fetch,
	nativeAuthPort,
	record,
}: {
	fetch: AuthFetch;
	nativeAuthPort: NativeAuthPort;
	record: Extract<DesktopAuthRecord, { token: string }>;
}) {
	const authority = createInstanceCredentialAuthority(
		{ fetch },
		{ baseURL: record.deployment.baseURL, token: record.token },
	);
	const bootSnapshot = {
		state: authority.snapshot.state,
		connection: {
			baseURL: record.deployment.baseURL,
			status: authority.snapshot.connectionStatus,
		},
		networkEligible: authority.snapshot.networkEligible,
	} satisfies DesktopAuthBootSnapshot;
	return {
		baseURL: record.deployment.baseURL,
		bootSnapshot,
		authorize() {
			return authority.authorize();
		},
		reportRejected(tokenGeneration: number) {
			authority.reportRejected(tokenGeneration);
		},
		async startSignIn() {
			const result = await authority.startSignIn();
			if (!result.error) nativeAuthPort.relaunch();
			return result;
		},
		async signOut() {
			await nativeAuthPort.storeAuth(writeHostedRecord(null));
			nativeAuthPort.relaunch();
			return Ok(undefined);
		},
		selectInstance(input: { baseURL: string; token: string }) {
			return selectInstance(nativeAuthPort, input);
		},
		async selectHosted() {
			await nativeAuthPort.storeAuth(writeHostedRecord(null));
			nativeAuthPort.relaunch();
		},
		[Symbol.dispose]() {
			authority[Symbol.dispose]();
		},
	};
}

async function selectInstance(
	nativeAuthPort: NativeAuthPort,
	input: { baseURL: string; token: string },
) {
	const normalized = normalizeInstanceUrl(input.baseURL);
	if (normalized.error) throw new Error(normalized.error.message);
	const token = assertStrongToken(input.token);
	await nativeAuthPort.storeAuth(
		JSON.stringify({
			deployment: { kind: 'self-hosted', baseURL: normalized.data },
			token,
		}),
	);
	nativeAuthPort.relaunch();
}
