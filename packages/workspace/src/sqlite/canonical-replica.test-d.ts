/**
 * Canonical Replica Type Tests
 *
 * Locks the owner-only synchronization boundary. Applications cannot select
 * actor identity, issue protocol operations, inspect retired recovery state,
 * or access replica SQLite.
 */

import type { CanonicalReplica } from './canonical-replica.js';

declare const replica: CanonicalReplica;

replica.admit({
	kind: 'patchRow',
	table: 'skills',
	rowId: 'skill-id',
	set: { title: 'Updated' },
	unset: [],
});
void replica.synchronize();
void replica.status();

// @ts-expect-error: actor identity belongs to the physical replica file.
void replica.actorId;
// @ts-expect-error: raw protocol push is not a replica capability.
void replica.push;
// @ts-expect-error: raw protocol pull is not a replica capability.
void replica.pull;
// @ts-expect-error: quarantine inspection was removed with command refusal.
void replica.inspectQuarantine;
// @ts-expect-error: the private SQLite owner is not returned.
void replica.sqlite;
