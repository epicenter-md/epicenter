/**
 * Which auth transitions end a page's auth generation.
 *
 * The subtle pair is reauth: degrading to `reauth-required` must NOT reload
 * (it can fire spontaneously, mid-keystroke), while repairing it currently
 * does, because everything downstream of the boot read is built once.
 */

import { beforeEach, expect, mock, test } from 'bun:test';
import type { AuthClient, AuthState } from '../index.js';
import { reloadOnAuthChange } from './reload-on-auth-change.js';

const signedOut = { status: 'signed-out' } as AuthState;
const signedIn = (principalId: string) =>
	({ status: 'signed-in', principalId }) as AuthState;
const reauthRequired = (principalId: string) =>
	({ status: 'reauth-required', principalId }) as AuthState;

function createFakeAuth(initial: AuthState) {
	let state = initial;
	const listeners = new Set<(next: AuthState) => void>();
	const client = {
		get state() {
			return state;
		},
		onStateChange(listener: (next: AuthState) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	} as unknown as AuthClient;
	return {
		client,
		emit(next: AuthState) {
			state = next;
			for (const listener of [...listeners]) listener(next);
		},
	};
}

const location = {
	pathname: '/',
	reload: mock(),
	replace: mock(),
};

beforeEach(() => {
	location.pathname = '/';
	location.reload.mockClear();
	location.replace.mockClear();
	(globalThis as { window?: unknown }).window = { location };
});

test('signing in is a new generation', () => {
	const auth = createFakeAuth(signedOut);
	reloadOnAuthChange(auth.client);
	auth.emit(signedIn('p1'));
	expect(location.reload).toHaveBeenCalledTimes(1);
});

test('signing out is a new generation', () => {
	const auth = createFakeAuth(signedIn('p1'));
	reloadOnAuthChange(auth.client);
	auth.emit(signedOut);
	expect(location.reload).toHaveBeenCalledTimes(1);
});

test('an account switch pair reloads exactly once', () => {
	const auth = createFakeAuth(signedIn('p1'));
	reloadOnAuthChange(auth.client);
	auth.emit(signedOut);
	auth.emit(signedIn('p2'));
	expect(location.reload).toHaveBeenCalledTimes(1);
});

test('degrading to reauth-required does NOT reload', () => {
	// The one transition that can happen spontaneously (a refresh token
	// expiring in the background). The degraded generation keeps working
	// locally; sync reports the refusal on its status and keeps dialling.
	const auth = createFakeAuth(signedIn('p1'));
	reloadOnAuthChange(auth.client);
	auth.emit(reauthRequired('p1'));
	expect(location.reload).not.toHaveBeenCalled();
	expect(location.replace).not.toHaveBeenCalled();
});

test('reloading on the degrade would be a boot loop, which is why it does not', () => {
	// The structural reason, pinned, because the UX reason ("do not interrupt
	// someone mid-keystroke") reads as negotiable and this does not.
	//
	// A reload cannot repair this transition. The pause is runtime-only, so the
	// next generation boots optimistically `signed-in` from the same persisted
	// grant, and a revoked token degrades again one token-endpoint round trip
	// later. This test plays that generation twice: if the degrade ever
	// reloaded, the second boot is the first boot and the app spins forever.
	for (const generation of [1, 2]) {
		const auth = createFakeAuth(signedIn('p1'));
		reloadOnAuthChange(auth.client);
		// Boot is optimistic; a persisted grant can only ever come back as
		// signed-in, whatever the last generation learned about it.
		expect(auth.client.state.status).toBe('signed-in');
		auth.emit(reauthRequired('p1'));
		expect(location.reload).not.toHaveBeenCalled();
		void generation;
	}
});

test('repairing reauth into signed-in reloads, same principal', () => {
	// Sync no longer needs this: the driver kept dialling through the refusal
	// and its next dial succeeds (ADR-0350). What still rides on it is
	// everything else built from the one boot read.
	const auth = createFakeAuth(reauthRequired('p1'));
	reloadOnAuthChange(auth.client);
	auth.emit(signedIn('p1'));
	expect(location.reload).toHaveBeenCalledTimes(1);
});

test('a degrade-then-repair round trip within one generation reloads once', () => {
	const auth = createFakeAuth(signedIn('p1'));
	reloadOnAuthChange(auth.client);
	auth.emit(reauthRequired('p1'));
	expect(location.reload).not.toHaveBeenCalled();
	auth.emit(signedIn('p1'));
	expect(location.reload).toHaveBeenCalledTimes(1);
});

test('a sign-in completing on the callback route replaces instead of reloading', () => {
	// A bare reload would land back on the callback URL and replay the
	// already-consumed authorization code.
	const auth = createFakeAuth(signedOut);
	location.pathname = '/auth/callback';
	reloadOnAuthChange(auth.client);
	auth.emit(signedIn('p1'));
	expect(location.replace).toHaveBeenCalledWith('/');
	expect(location.reload).not.toHaveBeenCalled();
});

test('the app can choose the callback destination', () => {
	const auth = createFakeAuth(signedOut);
	location.pathname = '/auth/callback';
	reloadOnAuthChange(auth.client, { callbackDestination: '/account' });
	auth.emit(signedIn('p1'));
	expect(location.replace).toHaveBeenCalledWith('/account');
});

test('unsubscribing stops future reloads', () => {
	const auth = createFakeAuth(signedOut);
	const unsubscribe = reloadOnAuthChange(auth.client);
	unsubscribe();
	auth.emit(signedIn('p1'));
	expect(location.reload).not.toHaveBeenCalled();
});
