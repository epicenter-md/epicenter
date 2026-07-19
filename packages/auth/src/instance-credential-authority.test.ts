/**
 * Instance Credential Authority Tests
 *
 * Verifies the private static-token grant boundary used by the self-host client
 * and the future desktop authority.
 *
 * Key behaviors:
 * - An unreachable boot preserves local identity but denies a bearer grant
 * - The offline denial is transient
 * - A rejection from an old generation cannot sign out a re-verified session
 */

import { expect, test } from 'bun:test';
import { asPrincipalId } from '@epicenter/identity';
import { createInstanceCredentialAuthority } from './instance-credential-authority.js';

const baseURL = 'http://localhost:8788';

function sessionResponse() {
	return new Response(JSON.stringify({ principalId: 'instance' }), {
		headers: { 'content-type': 'application/json' },
	});
}

test('offline verification denies a transient bearer grant without losing local identity', async () => {
	const authority = createInstanceCredentialAuthority(
		{
			fetch: async () => {
				throw new Error('instance offline');
			},
		},
		{ baseURL, token: 'instance-token' },
	);

	expect(await authority.authorize()).toEqual({
		status: 'denied',
		permanence: 'transient',
		code: 'auth-unavailable',
	});
	expect(authority.snapshot).toEqual({
		state: {
			status: 'signed-in',
			principalId: asPrincipalId('instance'),
		},
		connectionStatus: 'unreachable',
		networkEligible: false,
		tokenGeneration: 1,
	});
	authority[Symbol.dispose]();
});

test('stale rejection cannot sign out a re-verified static token generation', async () => {
	const authority = createInstanceCredentialAuthority(
		{ fetch: async () => sessionResponse() },
		{ baseURL, token: 'instance-token' },
	);

	const initial = await authority.authorize();
	expect(initial.status).toBe('authorized');
	if (initial.status !== 'authorized') {
		throw new Error('Expected initial instance authorization to succeed.');
	}

	await authority.signOut();
	await authority.startSignIn();
	const reverified = await authority.authorize();
	expect(reverified).toMatchObject({
		status: 'authorized',
		tokenGeneration: 3,
	});
	if (reverified.status !== 'authorized') {
		throw new Error('Expected re-verified instance authorization to succeed.');
	}

	authority.reportRejected(initial.tokenGeneration);
	expect(authority.snapshot.state.status).toBe('signed-in');
	authority.reportRejected(reverified.tokenGeneration);
	expect(authority.snapshot.state).toEqual({ status: 'signed-out' });
	authority[Symbol.dispose]();
});
