/**
 * The authority's side of the boundary, pinned from outside: every verb moves
 * bytes it cannot read.
 *
 * The structural half of the claim is the file itself: `authority.ts` imports
 * no Yjs and no `@epicenter/database`, and there is no verb that could
 * interpret an update. This suite pins the behavioral half by driving every
 * verb with bytes no Yjs decode would survive. If sequencing, catch-up,
 * snapshot replacement, or document replacement ever grew a peek at the
 * payload, the garbage here would surface it as a refusal or a throw.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';

import { openSyncAuthority } from './authority.js';

/** Deterministic garbage: bytes that are not a Yjs update by any decoding. */
function opaque(seed: number, length = 32): Uint8Array {
	return Uint8Array.from({ length }, (_, i) => (seed * 31 + i * 7 + 255) % 256);
}

function openAuthority() {
	const database = createBunSqliteAdapter(new Database(':memory:'));
	// A floor of one byte so the snapshot policy is reachable from tiny bytes.
	return openSyncAuthority({ database, snapshotFloorBytes: 1 });
}

describe('an authority needs no workspace: every verb moves unread bytes', () => {
	test('append assigns positions and since returns the bytes untouched', () => {
		const authority = openAuthority();
		const first = authority.append(opaque(1));
		if (first.error !== null) throw first.error;
		expect(first.data).toBe(1);
		const second = authority.append(opaque(2));
		if (second.error !== null) throw second.error;
		expect(second.data).toBe(2);

		const entries = authority.since(0);
		if (entries.error !== null) throw entries.error;
		expect(entries.data.map((entry) => entry.seq)).toEqual([1, 2]);
		expect(entries.data[0]?.bytes).toEqual(opaque(1));
		expect(entries.data[1]?.bytes).toEqual(opaque(2));
	});

	test('a snapshot of garbage replaces covered history and is served back whole', () => {
		const authority = openAuthority();
		authority.append(opaque(1));
		authority.append(opaque(2));
		authority.append(opaque(3));

		// The tail outgrew the (absent) snapshot, so the policy asks for one;
		// the policy is arithmetic over stored sizes, never over content.
		const wanted = authority.shouldSnapshot();
		if (wanted.error !== null) throw wanted.error;
		expect(wanted.data).toBe(true);

		const replaced = authority.replaceSnapshot(2, opaque(9, 128));
		if (replaced.error !== null) throw replaced.error;

		// Everything the snapshot covers is gone; the tail after it survives.
		const after = authority.since(0);
		if (after.error !== null) throw after.error;
		expect(after.data.map((entry) => entry.seq)).toEqual([3]);
		const held = authority.snapshot();
		if (held.error !== null) throw held.error;
		expect(held.data?.position).toBe(2);
		expect(held.data?.bytes).toEqual(opaque(9, 128));
	});

	test('replace publishes caller-supplied state as the next document, unread', () => {
		const authority = openAuthority();
		authority.append(opaque(1));
		const named = authority.document();
		if (named.error !== null) throw named.error;

		const published = authority.replace({
			fromDocument: named.data,
			bytes: opaque(7, 64),
		});
		if (published.error !== null) throw published.error;
		expect(published.data).not.toBe(named.data);

		// The old history went whole; the new document's state is its snapshot
		// at position 1, byte-identical to what the caller posted.
		const log = authority.since(0);
		if (log.error !== null) throw log.error;
		expect(log.data).toEqual([]);
		const held = authority.snapshot();
		if (held.error !== null) throw held.error;
		expect(held.data?.position).toBe(1);
		expect(held.data?.bytes).toEqual(opaque(7, 64));

		// And the lease still guards it: a replace built from the retired
		// document is refused by identity, which is a fact about ids, not bytes.
		const stale = authority.replace({
			fromDocument: named.data,
			bytes: opaque(8),
		});
		expect(stale.error?.name).toBe('DocumentMoved');
	});
});
