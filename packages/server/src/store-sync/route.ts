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

/**
 * Every application namespace a deletion has to reach.
 *
 * A store authority is per (principal, namespace), so "delete this account's
 * data" is a loop rather than one call, and a Durable Object namespace cannot
 * be enumerated. That leaves a list, and a list is only as complete as whoever
 * edits it.
 *
 * The gap is real and worth stating rather than hiding: an application whose
 * namespace is not here keeps its rows after an account is deleted. Every
 * namespace Epicenter ships is here, so the gap opens the moment a namespace
 * exists that Epicenter does not ship, which is the same moment third-party
 * apps come back (ADR-0227 refused them, so it is not today).
 *
 * The alternative shapes were worse. One authority per principal is what the
 * superseded stack did, and it makes two applications share a log whose
 * positions neither can read past (ADR-0225). A registry row per namespace is a
 * second source of truth that can disagree with what exists.
 */
export const DELETABLE_NAMESPACES: readonly string[] = [
	'so.epicenter.honeycrisp',
	'so.epicenter.whispering',
];
