/**
 * One instant of a client, as the thing that opens a replica needs it.
 *
 * A client is live: `state` moves when a person signs in, signs out, or has a
 * credential refused. What opens a replica must not be, because the address it
 * opens carries a principal, and a session has to answer for the principal that
 * created it even when the client moves underneath. So this reads the three
 * facts once and hands back a value.
 *
 * The translation lives here rather than beside the opener, because this is the
 * side that knows a client keeps its principal under `state`. `@epicenter/data`
 * declares the shape it wants and never imports this package: a store opens
 * with no account at all on a server, and a Durable Object is one of its
 * callers.
 *
 * **A signed-out client states no principal, and that fact travels rather than
 * throwing here.** The address builder refuses an account naming no principal
 * before anything is claimed or created, so the refusal a caller sees comes
 * from the one place that decides it.
 */

import type { PrincipalId } from '@epicenter/principal';
import type { AuthClient } from './auth-contract.js';

/**
 * What a replica opener needs from an account, structurally.
 *
 * Declared here rather than imported from `@epicenter/data`, so the dependency
 * runs one way only. `DatabaseAccount` is the same four members; a mismatch is
 * a type error at the one call site that passes one to the other.
 */
export type AccountSnapshot = {
	readonly baseURL: string;
	readonly principalId: PrincipalId;
	fetch(input: string | URL, init?: RequestInit): Promise<Response>;
	openWebSocket: AuthClient['openWebSocket'];
};

/** Read one instant of `client`: who it is, where, and how it reaches there. */
export function accountOf(client: AuthClient): AccountSnapshot {
	return {
		baseURL: client.connection.baseURL,
		// A signed-out client names no principal, and the address builder is what
		// refuses that, before anything is claimed or created.
		principalId:
			client.state.status === 'signed-out'
				? ('' as PrincipalId)
				: client.state.principalId,
		fetch: (input, init) => client.fetch(input, init),
		openWebSocket: (address) => client.openWebSocket(address),
	};
}
