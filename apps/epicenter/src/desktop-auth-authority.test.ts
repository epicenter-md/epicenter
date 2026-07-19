/**
 * Desktop Auth Authority Tests
 *
 * Verifies the Bun singleton's process-generation boundary without involving
 * WebViews or Tauri. The legacy keyring cell remains readable during the clean
 * break, while every new write uses the deployment-owned desktop record.
 *
 * Key behaviors:
 * - Legacy persisted auth boots the hosted principal offline
 * - Host-owned authorization verifies once and stays outside every WebView
 * - Sign-out persists the next signed-out cell before requesting relaunch
 */

import { expect, test } from 'bun:test';
import { createDesktopAuthAuthority } from './desktop-auth-authority.ts';

const LEGACY_CELL = JSON.stringify({
	grant: {
		accessToken: 'access-1',
		refreshToken: 'refresh-1',
		accessTokenExpiresAt: Date.now() + 3_600_000,
	},
	principalId: 'alice',
});

function setup(authCell: string | null = LEGACY_CELL) {
	const writes: Array<string | null> = [];
	let relaunches = 0;
	const authority = createDesktopAuthAuthority({
		authCell,
		nativeAuthPort: {
			completed: new Promise(() => undefined),
			async storeAuth(serialized) {
				writes.push(serialized);
			},
			async openAuthUrl() {},
			relaunch() {
				relaunches += 1;
			},
			onOAuthCallback() {
				return () => false;
			},
		},
		fetch: async (input) => {
			const url = String(input);
			if (url.endsWith('/api/session')) {
				return Response.json({ principalId: 'alice' });
			}
			if (url.endsWith('/auth/oauth2/revoke')) return new Response(null);
			throw new Error(`Unexpected auth request: ${url}`);
		},
	});
	return {
		authority,
		writes,
		get relaunches() {
			return relaunches;
		},
	};
}

test('legacy keyring cell boots the hosted principal and authorizes after verification', async () => {
	const { authority } = setup();
	expect(authority.bootSnapshot.state.status).toBe('signed-in');
	if (authority.bootSnapshot.state.status !== 'signed-in') {
		throw new Error('Expected signed-in boot snapshot.');
	}
	expect(String(authority.bootSnapshot.state.principalId)).toBe('alice');
	expect(authority.bootSnapshot.deployment).toEqual({
		kind: 'hosted',
		baseURL: 'https://api.epicenter.so',
	});
	expect(authority.bootSnapshot.networkEligible).toBe(false);
	expect(await authority.authorize()).toEqual({
		status: 'authorized',
		accessToken: 'access-1',
		tokenGeneration: 1,
	});
});

test('sign-out stores the next hosted cell before requesting relaunch', async () => {
	const runtime = setup();
	const result = await runtime.authority.signOut();
	expect(result.error).toBeNull();
	expect(runtime.writes).toEqual([
		JSON.stringify({
			deployment: { kind: 'hosted' },
			persistedAuth: null,
		}),
	]);
	expect(runtime.relaunches).toBe(1);
});

test('invalid or non-hosted cells boot hosted signed-out', () => {
	for (const authCell of [
		'not-json',
		JSON.stringify({
			deployment: { kind: 'self-hosted' },
			token: 'operator-token',
		}),
	]) {
		const { authority } = setup(authCell);
		expect(authority.bootSnapshot.state).toEqual({ status: 'signed-out' });
	}
});

test('self-hosted boot keeps the token in Bun and grants it after verification', async () => {
	const token = 'a'.repeat(43);
	const writes: Array<string | null> = [];
	let relaunches = 0;
	const authority = createDesktopAuthAuthority({
		authCell: JSON.stringify({
			deployment: {
				kind: 'self-hosted',
				baseURL: 'https://box.example/',
			},
			token,
		}),
		nativeAuthPort: {
			completed: new Promise(() => undefined),
			async storeAuth(serialized) {
				writes.push(serialized);
			},
			async openAuthUrl() {},
			relaunch() {
				relaunches += 1;
			},
			onOAuthCallback() {
				return () => false;
			},
		},
		fetch: async (input, init) => {
			expect(String(input)).toBe('https://box.example/api/session');
			expect(new Headers(init?.headers).get('authorization')).toBe(
				`Bearer ${token}`,
			);
			return Response.json({ principalId: 'instance' });
		},
	});

	expect(authority.bootSnapshot.state.status).toBe('signed-in');
	if (authority.bootSnapshot.state.status !== 'signed-in') {
		throw new Error('Expected the self-hosted boot snapshot to be signed in.');
	}
	expect(String(authority.bootSnapshot.state.principalId)).toBe('instance');
	expect({
		deployment: authority.bootSnapshot.deployment,
		networkEligible: authority.bootSnapshot.networkEligible,
	}).toEqual({
		deployment: {
			kind: 'self-hosted',
			baseURL: 'https://box.example',
			connectionStatus: 'connecting',
		},
		networkEligible: false,
	});
	expect(await authority.authorize()).toEqual({
		status: 'authorized',
		accessToken: token,
		tokenGeneration: 1,
	});
	await authority.selectInstance({
		baseURL: 'next.example/',
		token: 'b'.repeat(43),
	});
	expect(writes).toEqual([
		JSON.stringify({
			deployment: {
				kind: 'self-hosted',
				baseURL: 'https://next.example',
			},
			token: 'b'.repeat(43),
		}),
	]);
	expect(relaunches).toBe(1);
});
