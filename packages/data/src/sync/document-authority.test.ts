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

describe('folding is asked for, not done on the way past', () => {
	/** Twenty edits, each one a separate update the authority takes. */
	function fill(target: DocumentAuthority, count: number): Y.Doc {
		const editor = peer();
		for (let index = 0; index < count; index += 1) {
			write(editor, `key${index}`, index);
			expectOk(target.receive(stepTwo(editor, target)));
		}
		return editor;
	}

	test('receiving never folds, however much arrives', () => {
		// The decision, asserted where it can be seen. Inline folding spends CPU
		// while someone is typing and cannot be cancelled; `7452f8d47b` moved the
		// superseded rooms off it for exactly that reason.
		const authority = open(new Database(':memory:'), 0);
		fill(authority, 1);
		const afterOne = authority.storedBytes();
		fill(authority, 20);
		expect(authority.storedBytes()).toBeGreaterThan(afterOne * 10);
	});

	test('the tail outgrowing the state is what shouldFold reports', () => {
		const authority = open(new Database(':memory:'), 0);
		expect(authority.shouldFold()).toBe(false);
		fill(authority, 5);
		expect(authority.shouldFold()).toBe(true);
		expectOk(authority.fold());
		expect(authority.shouldFold()).toBe(false);
	});

	test('shouldFold is read out of storage, so a reopened authority agrees', () => {
		// The threshold `7452f8d47b` deferred, because "a threshold needs a
		// persistent counter that resets on hibernation". This one is derived
		// from the record, so a woken object answers what the hibernating one
		// would have.
		const file2 = new Database(':memory:');
		const first = open(file2, 0);
		fill(first, 5);
		expect(first.shouldFold()).toBe(true);
		first.dispose();
		expect(open(file2, 0).shouldFold()).toBe(true);
	});

	test('folding shrinks the record and keeps every edit', () => {
		const authority = open(new Database(':memory:'), 0);
		fill(authority, 30);
		const before = authority.storedBytes();
		expectOk(authority.fold());

		expect(authority.storedBytes()).toBeLessThan(before);
		const fresh = peer();
		Y.applyUpdateV2(fresh, authority.since(Y.encodeStateVector(fresh)));
		expect(Object.keys(attrs(fresh))).toHaveLength(30);
	});

	test('a fold does not lose a deletion, across a reopen', () => {
		const file2 = new Database(':memory:');
		const folding = open(file2, 0);
		const editor = fill(folding, 20);
		editor.transact(() => editor.get('notes').deleteAttr('key3'));
		expectOk(folding.receive(stepTwo(editor, folding)));
		expectOk(folding.fold());
		folding.dispose();

		const fresh = peer();
		Y.applyUpdateV2(fresh, open(file2, 0).since(Y.encodeStateVector(fresh)));
		expect(Object.keys(attrs(fresh))).toHaveLength(19);
		expect(attrs(fresh).key3).toBeUndefined();
	});

	test('folding when there is nothing to fold is wasteful, never wrong', () => {
		const authority = open(new Database(':memory:'), 0);
		expectOk(authority.fold());
		expectOk(authority.fold());
		const fresh = peer();
		Y.applyUpdateV2(fresh, authority.since(Y.encodeStateVector(fresh)));
		expect(attrs(fresh)).toEqual({});
	});
});
