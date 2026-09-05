import { describe, expect, test } from 'bun:test';
import { asPrincipalId, INSTANCE_PRINCIPAL_ID } from '@epicenter/principal';
import { BEARER_SUBPROTOCOL_PREFIX } from '@epicenter/sync';
import {
	type AuthClient,
	type AuthFetch,
	type ConnectionStatus,
	isCallbackAuthClient,
} from './auth-contract.js';
import { createInstanceTokenAuth } from './instance-token-auth.js';

const baseURL = 'http://localhost:8788';
const token = 'dev:principal-1';

function sessionBody(principalId = 'principal-1') {
	return {
		principalId,
		email: `${principalId}@example.com`,
	};
}

function json(value: unknown, status = 200) {
	return new Response(JSON.stringify(value), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

/** Let the construction-time `/api/session` check settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Read the selected server's connection channel. */
function connection(auth: AuthClient) {
	return auth.connection;
}

describe('createInstanceTokenAuth', () => {
	test('boots signed-in from /api/session 200 with the instance bearer', async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const fetch: AuthFetch = async (input, init) => {
			calls.push({ url: String(input), init });
			return json(sessionBody());
		};
		const auth = createInstanceTokenAuth({ baseURL, token, fetch });

		// Optimistic boot: signed-in as the instance principal before the async
		// check resolves, so the workspace opens principal-scoped synchronously.
		expect(auth.state).toEqual({
			status: 'signed-in',
			principalId: INSTANCE_PRINCIPAL_ID,
		});
		await flush();

		expect(auth.state).toEqual({
			status: 'signed-in',
			principalId: asPrincipalId('principal-1'),
		});
		expect(calls[0]?.url).toBe(`${baseURL}/api/session`);
		expect(calls[0]?.init?.credentials).toBe('omit');
		expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe(
			`Bearer ${token}`,
		);
	});

	test('a real instance (instance principal) sees no principal change across boot', async () => {
		// The self-host box resolves every valid bearer to INSTANCE_PRINCIPAL_ID
		// (ADR-0075), so the optimistic boot identity and the verified identity
		// match: no `null -> instance` flip, so `reloadOnAuthChange` never
		// reloads the page mid-session. This is the IndexedDB-race fix.
		const seen: string[] = [];
		const fetch: AuthFetch = async () => json(sessionBody('instance'));
		const auth = createInstanceTokenAuth({ baseURL, token, fetch });
		auth.onStateChange((s) =>
			seen.push(s.status === 'signed-out' ? 'signed-out' : s.principalId),
		);

		expect(auth.state).toEqual({
			status: 'signed-in',
			principalId: INSTANCE_PRINCIPAL_ID,
		});
		await flush();
		expect(auth.state).toEqual({
			status: 'signed-in',
			principalId: INSTANCE_PRINCIPAL_ID,
		});
		// The principal id never left `instance`, so nothing a reload key watches changed.
		expect(seen.every((p) => p === INSTANCE_PRINCIPAL_ID)).toBe(true);
	});

	test('a refused token at boot rejects the CONNECTION and leaves the state alone', async () => {
		// This asserted `signed-out` and that was a boot loop. The authority boots
		// optimistically signed-in as the instance principal, so signed-in ->
		// signed-out is a principal change, `reloadOnAuthChange` reloads, and the
		// next boot is optimistic again: a self-hosted box whose token was rotated
		// span at one `/api/session` round trip forever.
		const fetch: AuthFetch = async () => json({}, 401);
		const auth = createInstanceTokenAuth({ baseURL, token, fetch });
		await flush();
		expect(auth.state.status).toBe('signed-in');
		expect(connection(auth).status).toBe('rejected');
	});

	test('fetch attaches the bearer to the instance origin and resolves relative paths', async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const fetch: AuthFetch = async (input, init) => {
			calls.push({ url: String(input), init });
			return json(sessionBody());
		};
		const auth = createInstanceTokenAuth({ baseURL, token, fetch });
		await flush();

		await auth.fetch('/api/blobs');
		const blobs = calls.at(-1);
		expect(blobs?.url).toBe(`${baseURL}/api/blobs`);
		expect(blobs?.init?.credentials).toBe('omit');
		expect(new Headers(blobs?.init?.headers).get('authorization')).toBe(
			`Bearer ${token}`,
		);
	});

	test('fetch never attaches the bearer to a different origin (audience scoping)', async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const fetch: AuthFetch = async (input, init) => {
			calls.push({ url: String(input), init });
			return json(sessionBody());
		};
		const auth = createInstanceTokenAuth({ baseURL, token, fetch });
		await flush();

		await auth.fetch('https://someone-elses-inference.example.com/v1/models');
		const cross = calls.at(-1);
		expect(cross?.url).toBe(
			'https://someone-elses-inference.example.com/v1/models',
		);
		expect(new Headers(cross?.init?.headers).has('authorization')).toBe(false);
	});

	test('a 401 on a resource call rejects the connection and keeps the principal', async () => {
		const fetch: AuthFetch = async (input) =>
			String(input).endsWith('/api/session')
				? json(sessionBody())
				: json({}, 401);
		const auth = createInstanceTokenAuth({ baseURL, token, fetch });
		await flush();
		expect(auth.state.status).toBe('signed-in');

		await auth.fetch('/api/blobs');
		// The token was refused, not the person. Keeping the principal is what
		// keeps the local partition addressable and the reload gate quiet.
		expect(auth.state.status).toBe('signed-in');
		expect(connection(auth).status).toBe('rejected');
	});

	test('openWebSocket carries the bearer as an Epicenter subprotocol', async () => {
		const wsCalls: Array<{ url: string; protocols: string[] }> = [];
		class FakeWebSocket {
			constructor(url: string, protocols: string[]) {
				wsCalls.push({ url, protocols });
			}
		}
		const fetch: AuthFetch = async () => json(sessionBody());
		const auth = createInstanceTokenAuth({
			baseURL,
			token,
			fetch,
			WebSocket: FakeWebSocket as unknown as typeof WebSocket,
		});
		await flush();

		await auth.openWebSocket('ws://localhost:8788/api/rooms/r', [
			'existing-protocol',
		]);
		expect(wsCalls.at(-1)).toEqual({
			url: 'ws://localhost:8788/api/rooms/r',
			protocols: ['existing-protocol', `${BEARER_SUBPROTOCOL_PREFIX}${token}`],
		});
	});

	test('signOut drops to signed-out locally without a server call', async () => {
		const calls: string[] = [];
		const fetch: AuthFetch = async (input) => {
			calls.push(String(input));
			return json(sessionBody());
		};
		const auth = createInstanceTokenAuth({ baseURL, token, fetch });
		await flush();
		expect(auth.state.status).toBe('signed-in');
		const callsBefore = calls.length;

		await auth.signOut();
		expect(auth.state.status).toBe('signed-out');
		expect(calls.length).toBe(callsBefore); // no revoke request
	});

	test('startSignIn re-verifies the token (retry after an offline boot)', async () => {
		let reachable = false;
		const fetch: AuthFetch = async () => {
			if (!reachable) throw new Error('offline');
			return json(sessionBody());
		};
		const auth = createInstanceTokenAuth({ baseURL, token, fetch });
		await flush();
		// An unreachable instance leaves the optimistic identity: the self-hoster
		// keeps their principal-scoped local workspace offline (the connection
		// channel, not `state`, carries the "unreachable" signal).
		expect(auth.state).toEqual({
			status: 'signed-in',
			principalId: INSTANCE_PRINCIPAL_ID,
		});

		reachable = true;
		const { error } = await auth.startSignIn();
		expect(error).toBeNull();
		expect(auth.state).toEqual({
			status: 'signed-in',
			principalId: asPrincipalId('principal-1'),
		});
	});

	test('getProfile reads the user from /api/session with the bearer', async () => {
		const fetch: AuthFetch = async () => json(sessionBody());
		const auth = createInstanceTokenAuth({ baseURL, token, fetch });
		await flush();

		const { data, error } = await auth.getProfile();
		expect(error).toBeNull();
		expect(data).toEqual({
			id: asPrincipalId('principal-1'),
			email: 'principal-1@example.com',
		});
	});

	test('connection names the self-hosted instance', async () => {
		const fetch: AuthFetch = async () => json(sessionBody());
		const auth = createInstanceTokenAuth({ baseURL, token, fetch });
		expect(auth.connection.baseURL).toBe(baseURL);
	});

	test('connection reports connecting at boot then connected on a 200', async () => {
		const fetch: AuthFetch = async () => json(sessionBody());
		const auth = createInstanceTokenAuth({ baseURL, token, fetch });
		expect(connection(auth).status).toBe('connecting');
		await flush();
		expect(connection(auth).status).toBe('connected');
	});

	test('connection is rejected when the token is refused (401)', async () => {
		const fetch: AuthFetch = async () => json({}, 401);
		const auth = createInstanceTokenAuth({ baseURL, token, fetch });
		await flush();
		expect(connection(auth).status).toBe('rejected');
		expect(auth.state.status).toBe('signed-in');
	});

	test('connection is unreachable when the instance is offline', async () => {
		const fetch: AuthFetch = async () => {
			throw new Error('offline');
		};
		const auth = createInstanceTokenAuth({ baseURL, token, fetch });
		await flush();
		expect(connection(auth).status).toBe('unreachable');
	});

	test('connection notifies subscribers and recovers on a retry', async () => {
		let reachable = false;
		const fetch: AuthFetch = async () => {
			if (!reachable) throw new Error('offline');
			return json(sessionBody());
		};
		const auth = createInstanceTokenAuth({ baseURL, token, fetch });
		const seen: ConnectionStatus[] = [];
		connection(auth).onChange((s) => seen.push(s));
		await flush();
		expect(connection(auth).status).toBe('unreachable');

		reachable = true;
		await auth.startSignIn();
		expect(connection(auth).status).toBe('connected');
		// The retry moves connecting -> connected, both observed after subscribing.
		expect(seen).toContain('connecting');
		expect(seen).toContain('connected');
	});

	test('a 401 on a resource call marks the connection rejected', async () => {
		const fetch: AuthFetch = async (input) =>
			String(input).endsWith('/api/session')
				? json(sessionBody())
				: json({}, 401);
		const auth = createInstanceTokenAuth({ baseURL, token, fetch });
		await flush();
		expect(connection(auth).status).toBe('connected');

		await auth.fetch('/api/blobs');
		// The coupling this used to assert (a rejected token also drops `state`)
		// was the boot loop. The rejected-token copy moves to the signed-in panel,
		// beside the `unreachable` notice that already lives there.
		expect(auth.state.status).toBe('signed-in');
		expect(connection(auth).status).toBe('rejected');
	});
});

test('an instance-token client is not a callback client', () => {
	// The operator brought the bearer. `startSignIn` re-verifies it and there is
	// no interactive OAuth flow at all, so there is no callback to complete.
	const auth = createInstanceTokenAuth({
		baseURL: 'https://instance.epicenter.test',
		token: 'a'.repeat(64),
		fetch: async () => new Response(null, { status: 204 }),
	});

	expect(isCallbackAuthClient(auth)).toBe(false);
	auth[Symbol.dispose]();
});
