import type { PrincipalId } from '@epicenter/principal';

/**
 * Current auth state for local-first workspace clients.
 *
 * `principalId` is present in `signed-in` and `reauth-required` because it is
 * the local partition key. Even when an OAuth grant needs reauth, the cached
 * principal id still picks the right local storage partition.
 *
 * This is capability state, not credential state, which is why it is a
 * separate file from the client that produces it rather than a separate
 * package. It spent a while in `@epicenter/principal` under a docstring
 * explaining that it lived there so an MIT toolkit and the AGPL auth client
 * could share one definition across a license firewall. Every consumer was
 * this package or downstream of it, the firewall is gone, and the
 * `packages/data`, the store package that owns the shared data definition.
 */
export type AuthState =
	| { status: 'signed-out' }
	| { status: 'signed-in'; principalId: PrincipalId }
	| { status: 'reauth-required'; principalId: PrincipalId };
