/**
 * Desktop Broker Auth Tests
 *
 * Verifies that the window-local client is a pure projection of the Bun
 * authority: identity comes from the boot snapshot, account commands are
 * same-origin broker calls, and no credential is attached to any window
 * transport.
 *
 * Key behaviors:
 * - Window fetch passes requests through without an Authorization header
 * - Account commands post to the same-origin broker routes with cookies
 * - The profile is read from the broker projection, never the deployment
 * - openWebSocket is denied permanently
 */

import { expect, test } from 'bun:test';
import { asPrincipalId } from '@epicenter/identity';
import type { AuthFetch } from './auth-contract.ts';
import {
	createDesktopBrokerAuth,
	createDesktopInstanceSetting,
} from './desktop-broker-auth.ts';

const bootstrap = {
	state: { status: 'signed-in', principalId: asPrincipalId('alice') },
	deployment: {
		kind: 'hosted',
		baseURL: 'https://api.epicenter.so',
	},
	networkEligible: true,
} as const;

function recordingFetch(
	respond: (url: string, init?: RequestInit) => Response,
) {
	const calls: { url: string; init?: RequestInit }[] = [];
	const fetch: AuthFetch = async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		calls.push({ url, init });
		return respond(url, init);
	};
	return { calls, fetch };
}

test('window fetch attaches no credential to any request', async () => {
	const { calls, fetch } = recordingFetch(() => new Response('ok'));
	const auth = createDesktopBrokerAuth({
		bootstrap,
		brokerBaseURL: 'http://127.0.0.1:39130',
		fetch,
	});

	await auth.fetch('https://api.epicenter.so/api/session');
	await auth.fetch('https://example.com/resource');

	expect(calls).toHaveLength(2);
	for (const call of calls) {
		const headers = new Headers(call.init?.headers);
		expect(headers.get('authorization')).toBeNull();
	}
});

test('account commands post to the same-origin broker with cookies', async () => {
	const { calls, fetch } = recordingFetch(
		() => new Response(null, { status: 202 }),
	);
	const auth = createDesktopBrokerAuth({
		bootstrap,
		brokerBaseURL: 'http://127.0.0.1:39130',
		fetch,
	});

	expect((await auth.startSignIn()).error).toBeNull();
	expect((await auth.signOut()).error).toBeNull();

	expect(calls.map((call) => call.url)).toEqual([
		'http://127.0.0.1:39130/_epicenter/account/sign-in',
		'http://127.0.0.1:39130/_epicenter/account/sign-out',
	]);
	for (const call of calls) {
		expect(call.init?.credentials).toBe('include');
		expect(call.init?.method).toBe('POST');
	}
});

test('a failed broker command returns a typed auth error', async () => {
	const { fetch } = recordingFetch(
		() => new Response('Unauthorized', { status: 401 }),
	);
	const auth = createDesktopBrokerAuth({
		bootstrap,
		brokerBaseURL: 'http://127.0.0.1:39130',
		fetch,
	});

	const { error } = await auth.startSignIn();
	expect(error?.name).toBe('StartSignInFailed');
});

test('getProfile reads the broker projection, never the deployment', async () => {
	const { calls, fetch } = recordingFetch((url) =>
		url.endsWith('/_epicenter/account/profile')
			? Response.json({ id: 'alice', email: 'alice@example.com' })
			: new Response('unexpected', { status: 500 }),
	);
	const auth = createDesktopBrokerAuth({
		bootstrap,
		brokerBaseURL: 'http://127.0.0.1:39130',
		fetch,
	});

	const profile = await auth.getProfile();
	expect(profile.error).toBeNull();
	expect(profile.data).toEqual({
		id: asPrincipalId('alice'),
		email: 'alice@example.com',
	});
	expect(calls).toHaveLength(1);
	expect(calls[0]?.url).toBe(
		'http://127.0.0.1:39130/_epicenter/account/profile',
	);
});

test('openWebSocket is denied permanently', async () => {
	const auth = createDesktopBrokerAuth({
		bootstrap,
		brokerBaseURL: 'http://127.0.0.1:39130',
		fetch: async () => new Response('ok'),
	});

	expect(
		auth.openWebSocket('wss://api.epicenter.so/rooms'),
	).rejects.toMatchObject({ permanence: 'permanent', code: 'auth-unavailable' });
});

test('the self-hosted deployment projects its boot connection status', () => {
	const auth = createDesktopBrokerAuth({
		bootstrap: {
			state: { status: 'signed-in', principalId: asPrincipalId('instance') },
			deployment: {
				kind: 'self-hosted',
				baseURL: 'https://epicenter.example.com',
				connectionStatus: 'connected',
			},
			networkEligible: true,
		},
		brokerBaseURL: 'http://127.0.0.1:39130',
		fetch: async () => new Response('ok'),
	});

	expect(auth.deployment.kind).toBe('self-hosted');
	if (auth.deployment.kind === 'self-hosted') {
		expect(auth.deployment.connection.status).toBe('connected');
	}
});

test('instance writes go to the broker and never touch window storage', async () => {
	const { calls, fetch } = recordingFetch(
		() => new Response(null, { status: 202 }),
	);
	const setting = createDesktopInstanceSetting({
		bootstrap,
		brokerBaseURL: 'http://127.0.0.1:39130',
		fetch,
	});

	expect(setting.read()).toEqual({ baseURL: 'https://api.epicenter.so' });
	expect(setting.isDefault()).toBe(true);
	await setting.write({
		baseURL: 'https://epicenter.example.com',
		token: 'instance_token_1234567890abcdef1234567890abcdef',
	});
	await setting.clear();

	expect(calls.map((call) => call.url)).toEqual([
		'http://127.0.0.1:39130/_epicenter/account/instance',
		'http://127.0.0.1:39130/_epicenter/account/instance',
	]);
	expect(calls[1]?.init?.method).toBe('DELETE');
});
