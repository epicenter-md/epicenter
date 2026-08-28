/**
 * The authority that reads, driven the way the protocol drives it.
 *
 * Every test here is a sentence about a peer: what it is told it lacks, what
 * happens when it sends something back, and what survives the authority being
 * dropped and rebuilt. The old authority's suite could not ask any of these,
 * because a log of opaque bytes has no answer to "what am I missing" — it only
 * had positions.
 */
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import * as Y from '@y/y';
import { expectOk } from 'wellcrafted/testing';

import {
	type DocumentAuthority,
	openDocumentAuthority,
} from './document-authority.js';

/** One authority over one in-memory file, reopenable. */
function open(file: Database, foldFloorBytes?: number): DocumentAuthority {
	return openDocumentAuthority({
		sqlite: createBunSqliteAdapter(file),
		...(foldFloorBytes === undefined ? {} : { foldFloorBytes }),
	});
}

/** A peer, which is just a document plus the two protocol calls. */
function peer(): Y.Doc {
	return new Y.Doc({ gc: true });
}

function attrs(doc: Y.Doc): Record<string, unknown> {
	return doc.get('notes').getAttrs() as Record<string, unknown>;
}

function write(doc: Y.Doc, key: string, value: unknown): void {
	doc.transact(() => doc.get('notes').setAttr(key as never, value as never));
}

/** What a peer owes the authority: sync step 2, from the peer's side. */
function stepTwo(from: Y.Doc, authority: DocumentAuthority): Uint8Array {
	return new Uint8Array(Y.encodeStateAsUpdateV2(from, authority.stateVector()));
}

let file: Database;
let authority: DocumentAuthority;

beforeEach(() => {
	file = new Database(':memory:');
	authority = open(file);
});

describe('the question a byte-blind authority could not answer', () => {
	test('an empty authority tells a fresh peer it lacks nothing', () => {
		const fresh = peer();
		Y.applyUpdateV2(fresh, authority.since(Y.encodeStateVector(fresh)));
		expect(attrs(fresh)).toEqual({});
	});

	test('a peer is told exactly what it lacks, and nothing it already has', () => {
		const first = peer();
		write(first, 'a', 1);
		expectOk(authority.receive(stepTwo(first, authority)));

		// A second peer that already has `a` is told about `b` alone.
		const second = peer();
		Y.applyUpdateV2(second, authority.since(Y.encodeStateVector(second)));
		write(first, 'b', 2);
		expectOk(authority.receive(stepTwo(first, authority)));

		const owed = authority.since(Y.encodeStateVector(second));
		Y.applyUpdateV2(second, owed);
		expect(attrs(second)).toEqual({ a: 1, b: 2 });
	});

	test('two peers converge through the authority without either seeing the other', () => {
		const phone = peer();
		const laptop = peer();
		write(phone, 'fromPhone', 1);
		write(laptop, 'fromLaptop', 2);
		expectOk(authority.receive(stepTwo(phone, authority)));
		expectOk(authority.receive(stepTwo(laptop, authority)));

		Y.applyUpdateV2(phone, authority.since(Y.encodeStateVector(phone)));
		Y.applyUpdateV2(laptop, authority.since(Y.encodeStateVector(laptop)));
		expect(attrs(phone)).toEqual({ fromPhone: 1, fromLaptop: 2 });
		expect(attrs(laptop)).toEqual(attrs(phone));
	});

	test('a deletion reaches a peer whose state vector did not move', () => {
		// The property `evidence/invariants.test.ts` pins about Yjs, asserted
		// here about the authority: a delete moves no clock, so the vectors match
		// and a size-zero answer would be defensible. It is not what happens.
		const editor = peer();
		write(editor, 'a', 1);
		write(editor, 'b', 2);
		expectOk(authority.receive(stepTwo(editor, authority)));

		const watcher = peer();
		Y.applyUpdateV2(watcher, authority.since(Y.encodeStateVector(watcher)));
		const before = Y.encodeStateVector(watcher);

		editor.transact(() => editor.get('notes').deleteAttr('b'));
		expectOk(authority.receive(stepTwo(editor, authority)));

		expect(authority.stateVector()).toEqual(before);
		Y.applyUpdateV2(watcher, authority.since(before));
		expect(attrs(watcher)).toEqual({ a: 1 });
	});
});

describe('the door', () => {
	test('bytes that are not an update are refused rather than stored', () => {
		const refused = authority.receive(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
		expect(refused.error?.name).toBe('Unapplyable');
		expect(authority.storedBytes()).toBe(0);
	});

	test('a refusal leaves the document exactly as it was', () => {
		const editor = peer();
		write(editor, 'a', 1);
		expectOk(authority.receive(stepTwo(editor, authority)));
		const before = authority.stateVector();

		authority.receive(new Uint8Array([255, 255, 255, 255]));
		expect(authority.stateVector()).toEqual(before);
	});

	test('an ordinary update leaves no unresolved dependencies', () => {
		const editor = peer();
		write(editor, 'a', 1);
		expectOk(authority.receive(stepTwo(editor, authority)));
		expect(authority.hasUnresolvedDependencies()).toBe(false);
	});
});

describe('what survives being dropped', () => {
	test('a reopened authority answers the same question the same way', () => {
		const editor = peer();
		write(editor, 'a', 1);
		write(editor, 'b', 2);
		expectOk(authority.receive(stepTwo(editor, authority)));
		const expected = authority.stateVector();
		authority.dispose();

		const reopened = open(file);
		expect(reopened.stateVector()).toEqual(expected);
		const fresh = peer();
		Y.applyUpdateV2(fresh, reopened.since(Y.encodeStateVector(fresh)));
		expect(attrs(fresh)).toEqual({ a: 1, b: 2 });
	});

	test('a reopened authority still knows what was deleted', () => {
		const editor = peer();
		write(editor, 'a', 1);
		write(editor, 'b', 2);
		expectOk(authority.receive(stepTwo(editor, authority)));
		editor.transact(() => editor.get('notes').deleteAttr('b'));
		expectOk(authority.receive(stepTwo(editor, authority)));
		authority.dispose();

		const fresh = peer();
		Y.applyUpdateV2(fresh, open(file).since(Y.encodeStateVector(fresh)));
		expect(attrs(fresh)).toEqual({ a: 1 });
	});
});

describe('folding, which needs nobody to offer anything', () => {
	test('the tail collapses into the state once it outgrows it', () => {
		// A floor of zero so ordinary test traffic reaches the fold. The old
		// authority had to ASK a client for a snapshot and check the offer
		// covered a position it had sent that connection; this one holds the
		// state it is replacing, so it just does it.
		const folding = open(new Database(':memory:'), 0);
		const editor = peer();
		write(editor, 'key0', 0);
		expectOk(folding.receive(stepTwo(editor, folding)));
		const afterOne = folding.storedBytes();

		for (let index = 1; index < 40; index += 1) {
			write(editor, `key${index}`, index);
			expectOk(folding.receive(stepTwo(editor, folding)));
		}

		const fresh = peer();
		Y.applyUpdateV2(fresh, folding.since(Y.encodeStateVector(fresh)));
		expect(Object.keys(attrs(fresh))).toHaveLength(40);
		// The property, rather than only that the data survived: storage tracks
		// the DOCUMENT, not the number of updates that built it. Forty updates
		// past the first cost well under forty times its bytes.
		expect(folding.storedBytes()).toBeLessThan(afterOne * 40);
	});

	test('a fold does not lose what it folded, across a reopen', () => {
		const file2 = new Database(':memory:');
		const folding = open(file2, 0);
		const editor = peer();
		for (let index = 0; index < 20; index += 1) {
			write(editor, `key${index}`, index);
			expectOk(folding.receive(stepTwo(editor, folding)));
		}
		editor.transact(() => editor.get('notes').deleteAttr('key3'));
		expectOk(folding.receive(stepTwo(editor, folding)));
		folding.dispose();

		const fresh = peer();
		Y.applyUpdateV2(fresh, open(file2, 0).since(Y.encodeStateVector(fresh)));
		expect(Object.keys(attrs(fresh))).toHaveLength(19);
		expect(attrs(fresh).key3).toBeUndefined();
	});
});
