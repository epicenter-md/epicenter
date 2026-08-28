/**
 * The outbox, computed rather than remembered.
 *
 * These are the properties the durable outbox has today, asserted about a
 * vector instead of about rows, because that swap is the last thing keeping a
 * document's record a chain. The one that matters is the third: the failure
 * mode of getting this wrong is silent, so it is pinned rather than reasoned
 * about.
 */
import { describe, expect, test } from 'bun:test';
import * as Y from '@y/y';

import {
	emptySentVector,
	mergeSentVectors,
	owedSince,
	vectorOf,
	vectorOfUpdate,
} from './owed.js';

/** The 13-byte no-op every replica walks straight past (`sync/authority.ts`). */
const EMPTY_UPDATE_BYTES = 13;

function doc(): Y.Doc {
	return new Y.Doc({ gc: true });
}

function attrs(document: Y.Doc): Record<string, unknown> {
	return document.get('notes').getAttrs() as Record<string, unknown>;
}

describe('what a replica owes', () => {
	test('a fresh replica owes everything it holds', () => {
		const replica = doc();
		replica.transact(() =>
			replica.get('notes').setAttr('a' as never, 1 as never),
		);

		const authority = doc();
		Y.applyUpdateV2(authority, owedSince(replica, emptySentVector()));
		expect(attrs(authority)).toEqual({ a: 1 });
	});

	test('a replica that has handed everything over owes the empty update', () => {
		const replica = doc();
		replica.transact(() =>
			replica.get('notes').setAttr('a' as never, 1 as never),
		);
		const sent = vectorOf(replica);

		expect(owedSince(replica, sent).length).toBe(EMPTY_UPDATE_BYTES);
	});

	test('a deletion made after the last acknowledgement is owed and carried', () => {
		// The half worth stating outright, because `ClientLog` refuses state
		// vectors on the grounds that they cannot express deletion. They cannot
		// express it as an INFERENCE; the diff carries it as DATA.
		const replica = doc();
		replica.transact(() => {
			replica.get('notes').setAttr('a' as never, 1 as never);
			replica.get('notes').setAttr('b' as never, 2 as never);
		});
		const authority = doc();
		Y.applyUpdateV2(authority, owedSince(replica, emptySentVector()));
		const sent = vectorOf(replica);

		replica.transact(() => replica.get('notes').deleteAttr('b'));

		// No clock moved, so the vectors are equal and a size-zero diff would be
		// defensible. It is not what happens.
		expect(vectorOf(replica)).toEqual(sent);
		Y.applyUpdateV2(authority, owedSince(replica, sent));
		expect(attrs(authority)).toEqual({ a: 1 });
	});
});

describe('bytes that arrived are never offered back', () => {
	test('a vector that ignores what arrived re-offers another device work', () => {
		// The hazard, stated as a failing shape rather than a warning. `log.ts`
		// names the cost: re-offering received bytes "would grow the log with
		// nothing new in it".
		const here = doc();
		here.transact(() => here.get('notes').setAttr('mine' as never, 1 as never));
		const sent = vectorOf(here);

		const elsewhere = doc();
		Y.applyUpdateV2(elsewhere, owedSince(here, emptySentVector()));
		elsewhere.transact(() =>
			elsewhere.get('notes').setAttr('theirs' as never, 2 as never),
		);
		const relayed = owedSince(elsewhere, sent);
		Y.applyUpdateV2(here, relayed);

		// This replica authored nothing since its acknowledgement, and still owes
		// a copy of the other device's work.
		expect(owedSince(here, sent).length).toBeGreaterThan(EMPTY_UPDATE_BYTES);
	});

	test('folding what arrived into the vector leaves nothing owed', () => {
		const here = doc();
		here.transact(() => here.get('notes').setAttr('mine' as never, 1 as never));
		let sent = vectorOf(here);

		const elsewhere = doc();
		Y.applyUpdateV2(elsewhere, owedSince(here, emptySentVector()));
		elsewhere.transact(() =>
			elsewhere.get('notes').setAttr('theirs' as never, 2 as never),
		);
		const relayed = owedSince(elsewhere, sent);
		Y.applyUpdateV2(here, relayed);
		sent = mergeSentVectors(sent, vectorOfUpdate(relayed));

		expect(owedSince(here, sent).length).toBe(EMPTY_UPDATE_BYTES);
		// And the replica did receive the work; it simply does not owe it.
		expect(attrs(here)).toEqual({ mine: 1, theirs: 2 });
	});

	test('folding never discards a client the other vector knew about', () => {
		const a = doc();
		a.transact(() => a.get('notes').setAttr('a' as never, 1 as never));
		const b = doc();
		b.transact(() => b.get('notes').setAttr('b' as never, 2 as never));

		const merged = mergeSentVectors(vectorOf(a), vectorOf(b));
		expect([...Y.decodeStateVector(merged).keys()].sort()).toEqual(
			[
				...Y.decodeStateVector(vectorOf(a)).keys(),
				...Y.decodeStateVector(vectorOf(b)).keys(),
			].sort(),
		);
	});
});

describe('the direction a mistake is allowed to fall', () => {
	test('a vector that lags re-sends, and the authority converges anyway', () => {
		const replica = doc();
		replica.transact(() =>
			replica.get('notes').setAttr('a' as never, 1 as never),
		);
		const stale = emptySentVector();
		const authority = doc();

		// Sent once, then again from a vector that never advanced.
		Y.applyUpdateV2(authority, owedSince(replica, stale));
		Y.applyUpdateV2(authority, owedSince(replica, stale));
		expect(attrs(authority)).toEqual({ a: 1 });
	});

	test('a vector that leads loses the work it skipped, with nothing to notice', () => {
		// Asserted so the ordering rule has a reason on the page rather than in
		// a comment: write the bytes, then record what was sent, never the other
		// way round.
		const replica = doc();
		replica.transact(() =>
			replica.get('notes').setAttr('a' as never, 1 as never),
		);
		const premature = vectorOf(replica);
		replica.transact(() =>
			replica.get('notes').setAttr('b' as never, 2 as never),
		);

		// Pretend the record of what was sent ran ahead of the send by one edit.
		const authority = doc();
		Y.applyUpdateV2(authority, owedSince(replica, emptySentVector()));
		const skipped = doc();
		Y.applyUpdateV2(skipped, owedSince(replica, premature));

		expect(attrs(authority)).toEqual({ a: 1, b: 2 });
		// Nothing throws, nothing reports, and the edit is simply not there.
		expect(attrs(skipped)).toEqual({ b: 2 });
	});
});
