/**
 * Where one partition's store lives, as a durable name.
 *
 * The URL and its grammar are `@epicenter/sync`'s, because a browser replica
 * builds the same URL and has no business importing a server to learn it. What
 * is server-only is this: the Durable Object name, which is derived from a
 * principal a client never supplies.
 */

import type { PrincipalId } from '@epicenter/identity';

/**
 * Durable Object name for one partition's store of one application.
 *
 * `principals/<principalId>/stores/<namespace>`, the same shape every durable
 * identifier this server writes follows. The principal segment is the
 * partition, so a client that names another application's namespace still lands
 * inside its OWN partition.
 *
 * One Durable Object per (principal, application) rather than per principal,
 * because ADR-0215 makes an application ONE document and the authority's log is
 * that document's: two applications sharing a log would interleave positions
 * neither could read past.
 */
export function storeAuthorityName(
	principalId: PrincipalId,
	namespace: string,
): `principals/${string}/stores/${string}` {
	return `principals/${principalId}/stores/${namespace}`;
}

