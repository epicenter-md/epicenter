/**
 * Signed-out Whispering Workspace Tests
 *
 * Verifies the boot invariant that authentication does not own the product
 * runtime. A signed-out auth snapshot selects the bare local-first connection,
 * which the always-available Whispering workspace consumes.
 */

import { expect, test } from 'bun:test';
import type { SyncAuthClient } from '@epicenter/auth';
import { toConnection } from '@epicenter/svelte/auth';
import { asNodeId } from '@epicenter/workspace';
import { Ok } from 'wellcrafted/result';

test('signed-out auth selects the bare local-first workspace connection', () => {
	const auth: SyncAuthClient = {
		state: { status: 'signed-out' },
		deployment: { kind: 'hosted', baseURL: 'https://api.example.com' },
		onStateChange: () => () => {},
		startSignIn: async () => Ok(undefined),
		signOut: async () => Ok(undefined),
		fetch: async () => {
			throw new Error('not used');
		},
		getProfile: async () => {
			throw new Error('not used');
		},
		openWebSocket: async () => {
			throw new Error('not used');
		},
		[Symbol.dispose]: () => {},
	};

	expect(toConnection(auth, asNodeId('signed-out-test'))).toBeNull();
});
