/**
 * What an authority still holds after you delete something, and for how long.
 *
 * This file used to prove a different system. Its claim was that "a device
 * joining for the FIRST time replays the log from position zero, so it
 * downloads everything anyone has ever deleted", which was true of the
 * positional log ADR-0277 removed. The new authority answers a state vector
 * from a document it holds, so a fresh device receives current state and not
 * history, and the file kept passing while describing a leak the shipped
 * design no longer has.
 *
 * What survives is narrower, real, and now the thing being measured: an
 * authority's CHAIN holds the update that created a row, so between the
 * deletion and the next fold, the deleted content is still in storage and
 * still reachable by anyone who asks for everything. Folding is what removes
 * it, because a fold encodes a garbage-collected document rather than merging
 * bytes (ADR-0282).
 *
 * Evidence for the fold, for `pressure()`, and for ADR-0286's compaction. Not
 * a product workflow.
 */

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import * as Y from '@y/y';
import { expectOk } from 'wellcrafted/testing';

import {
	type DocumentAuthority,
	openDocumentAuthority,
} from '../src/sync/document-authority.js';

const CANARY = 'a sentence somebody deleted on purpose';

function authority() {
	const sqlite = createBunSqliteAdapter(new Database(':memory:'));
	return {
		held: openDocumentAuthority({
			sqlite,
			// Every fold here is asked for explicitly, so the floor must not
			// decline one on a document this small.
			foldFloorBytes: 0,
		}),
		/** Everything in the chain, as text. Evidence reaches past the surface. */
		storage: () =>
			sqlite
				.all<{ bytes: Uint8Array | ArrayBuffer }>(
					'SELECT bytes FROM updates ORDER BY seq, chunk',
				)
				.map((row) =>
					new TextDecoder('utf-8', { fatal: false }).decode(
						new Uint8Array(row.bytes as ArrayBuffer),
					),
				)
				.join(''),
	};
}

/** What a device with nothing would be sent, as text. */
function everythingSentToANewDevice(held: DocumentAuthority): string {
	return new TextDecoder('utf-8', { fatal: false }).decode(held.since());
}

function write(mutate: (root: Y.Type) => void): Uint8Array {
	const doc = new Y.Doc({ gc: true });
	doc.transact(() => mutate(doc.get('notes')));
	const update = new Uint8Array(Y.encodeStateAsUpdateV2(doc));
	doc.destroy();
	return update;
}

describe('what a deletion leaves behind', () => {
	test('storage carries deleted content until a fold, and the wire never does', () => {
		const { held, storage } = authority();
		const doc = new Y.Doc({ gc: true });

		doc.transact(() =>
			doc.get('notes').setAttr('body' as never, CANARY as never),
		);
		expectOk(held.receive(new Uint8Array(Y.encodeStateAsUpdateV2(doc))));

		doc.transact(() => doc.get('notes').deleteAttr('body'));
		expectOk(
			held.receive(new Uint8Array(Y.encodeStateAsUpdateV2(doc, undefined))),
		);

		// The correction this file exists to record. The update that CREATED the
		// row is still a record in the chain, so the sentence is on the server's
		// disk after it was deleted.
		expect(storage()).toContain(CANARY);

		// And it is not on the wire, not even before a fold. `since` encodes
		// from the hydrated, garbage-collected document rather than from the
		// stored bytes, so a device joining now is sent current state and never
		// sees this. That is the difference ADR-0282 measured from the other
		// side: merging bytes deduplicates and never collects, so a byte-only
		// authority WOULD have handed this over.
		expect(everythingSentToANewDevice(held)).not.toContain(CANARY);

		expectOk(held.fold());

		// The fold writes what the wire was already saying, so storage catches
		// up with it. This is the operation that actually reclaims the bytes.
		expect(storage()).not.toContain(CANARY);
		expect(held.storedBytes()).toBeGreaterThan(0);
		doc.destroy();
		held.dispose();
	});

	test('a fresh device is sent current state, not the history that reached it', () => {
		const { held } = authority();
		// Ten separate updates, so a positional log would have ten entries to
		// replay and this has one document to describe.
		for (let index = 0; index < 10; index += 1) {
			expectOk(
				held.receive(
					write((root) => root.setAttr(`k${index}` as never, index as never)),
				),
			);
		}
		expectOk(held.fold());

		const fresh = new Y.Doc({ gc: true });
		Y.applyUpdateV2(fresh, held.since());
		expect(Object.keys(fresh.get('notes').getAttrs() ?? {})).toHaveLength(10);
		fresh.destroy();
		held.dispose();
	});

	test('a caught-up device is sent almost nothing', () => {
		const { held } = authority();
		expectOk(
			held.receive(write((root) => root.setAttr('a' as never, 1 as never))),
		);

		// The whole of what a replica owes when it owes nothing. There is no
		// cursor to compare and no position to be at: it says what it has.
		expect(held.since(held.stateVector()).byteLength).toBeLessThan(20);
		held.dispose();
	});
});
