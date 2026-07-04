import { describe, expect, test } from 'bun:test';
import { asPrincipalId, INSTANCE_PRINCIPAL_ID } from '@epicenter/identity';
import { BEARER_SUBPROTOCOL_PREFIX } from '@epicenter/sync';
import type { AuthConnectionState, AuthFetch } from './auth-contract.js';
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
		// match: no `null -> instance` flip, so `reloadOnPrincipalChange` never
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

	test('boots signed-out when /api/session rejects the token (401)', async () => {
		const fetch: AuthFetch = async () => json({}, 401);
		const auth = createInstanceTokenAuth({ baseURL, token, fetch });
		await flush();
		expect(auth.state.status).toBe('signed-out');
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

	test('a 401 on a resource call moves a signed-in client to signed-out', async () => {
		const fetch: AuthFetch = async (input) =>
			String(input).endsWith('/api/session')
				? json(sessionBody())
				: json({}, 401);
		const auth = createInstanceTokenAuth({ baseURL, token, fetch });
		await flush();
		expect(auth.state.status).toBe('signed-in');

		await auth.fetch('/api/blobs');
		expect(auth.state.status).toBe('signed-out');
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
		// An unreachable star leaves the optimistic identity: the self-hoster keeps
		// their principal-scoped local workspace offline (the `connection` channel,
		// not `state`, carries the "unreachable" signal).
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

	test('connection reports pending at boot then connected on a 200', async () => {
		const fetch: AuthFetch = async () => json(sessionBody());
		const auth = createInstanceTokenAuth({ baseURL, token, fetch });
		expect(auth.connection?.state).toEqual({ status: 'pending' });
		await flush();
		expect(auth.connection?.state).toEqual({ status: 'connected' });
	});

	test('connection fails as rejected when the token is refused (401)', async () => {
		const fetch: AuthFetch = async () => json({}, 401);
		const auth = createInstanceTokenAuth({ baseURL, token, fetch });
		await flush();
		expect(auth.state.status).toBe('signed-out');
		expect(auth.connection?.state).toEqual({
			status: 'failed',
			reason: 'rejected',
		});
	});

	test('connection fails as unreachable when the star is offline', async () => {
		const fetch: AuthFetch = async () => {
			throw new Error('offline');
		};
		const auth = createInstanceTokenAuth({ baseURL, token, fetch });
		await flush();
		expect(auth.connection?.state).toEqual({
			status: 'failed',
			reason: 'unreachable',
		});
	});

	test('connection notifies subscribers and recovers on a retry', async () => {
		let reachable = false;
		const fetch: AuthFetch = async () => {
			if (!reachable) throw new Error('offline');
			return json(sessionBody());
		};
		const auth = createInstanceTokenAuth({ baseURL, token, fetch });
		const seen: AuthConnectionState['status'][] = [];
		auth.connection?.onChange((s) => seen.push(s.status));
		await flush();
		expect(auth.connection?.state).toEqual({
			status: 'failed',
			reason: 'unreachable',
		});

		reachable = true;
		await auth.startSignIn();
		expect(auth.connection?.state).toEqual({ status: 'connected' });
		// The retry moves pending -> connected, both observed after subscribing.
		expect(seen).toContain('pending');
		expect(seen).toContain('connected');
	});

	test('a 401 on a resource call marks the connection rejected', async () => {
		const fetch: AuthFetch = async (input) =>
			String(input).endsWith('/api/session')
				? json(sessionBody())
				: json({}, 401);
		const auth = createInstanceTokenAuth({ baseURL, token, fetch });
		await flush();
		expect(auth.connection?.state).toEqual({ status: 'connected' });

		await auth.fetch('/api/blobs');
		expect(auth.connection?.state).toEqual({
			status: 'failed',
			reason: 'rejected',
		});
	});
});
