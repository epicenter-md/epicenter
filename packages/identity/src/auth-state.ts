import type { PrincipalId } from './identity.js';

/**
 * Current auth state for local-first workspace clients.
 *
 * `principalId` is present in `signed-in` and `reauth-required` because it is
 * the local partition key. Even when an OAuth grant needs reauth, the cached
 * principal id still picks the right local storage partition.
 *
 * This is capability state, not credential state. It lives here for a reason
 * that has expired twice: a license firewall that no longer exists, and a
 * `packages/workspace` that no longer exists either. Every consumer is
 * `@epicenter/auth` or downstream of it, so this belongs in that package and
 * should move when the arms are next touched.
 */
export type AuthState =
	| { status: 'signed-out' }
	| { status: 'signed-in'; principalId: PrincipalId }
	| { status: 'reauth-required'; principalId: PrincipalId };
