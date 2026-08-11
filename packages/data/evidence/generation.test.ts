/**
 * What actually happens when an application's log is replaced.
 *
 * The question is whether starting a new log is a NEW IDENTITY SPACE or the
 * SAME identity space in a new place. It sounds like a distinction without a
 * difference and it is the entire difference: one destroys a device's offline
 * work and the other merges it.
 *
 * ADR-0214 already refused rebuilding a document for this reason. These tests
 * exist because the reason is easy to state and easy to get backwards, and
 * because a design that gets it backwards looks identical until someone has
 * been offline.
 */

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { defineLens } from '@epicenter/lens';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import type { Result } from 'wellcrafted/result';

import { createStore } from '../src/store/store.js';

const lens = defineLens({
	namespace: 'so.epicenter.honeycrisp',
	tables: { notes: { title: 'string' } },
});

function expectOk<TValue, TError>(result: Result<TValue, TError>): TValue {
	if (result.error !== null) throw result.error;
	return result.data as TValue;
}

function open() {
	const store = createStore({
		database: createBunSqliteAdapter(new Database(':memory:')),
	});
	return { store, db: expectOk(store.bind(lens)) };
}

function titles(replica: ReturnType<typeof open>): string[] {
	return expectOk(replica.db.tables.notes.list())
		.rows.map((row) => row.title)
		.sort();
}

/** Two replicas that have already synchronised, and one note's id. */
function synchronisedPair() {
	const laptop = open();
	const phone = open();
	const note = expectOk(laptop.db.tables.notes.create({ title: 'Groceries' }));
	expectOk(laptop.db.tables.notes.create({ title: 'Reading list' }));
	expectOk(phone.store.applyRemote(laptop.store.encodeStateSince()));
	return { laptop, phone, noteId: note.id };
}

describe('a new generation seeded by SNAPSHOT keeps every identity', () => {
	test("a device's offline edit survives the rollover and lands on the right row", () => {
		const { laptop, phone, noteId } = synchronisedPair();

		// The phone goes offline and edits a row it already holds.
		expectOk(
			phone.db.tables.notes.update(noteId, { title: 'edited on a plane' }),
		);

		// The laptop starts generation 2 by snapshotting itself. This is the whole
		// rollover: no rewrite, no transformation, no interpretation of what a row
		// means. `encodeStateAsUpdateV2` re-encodes the SAME structs.
		const seed = laptop.store.encodeStateSince();

		// A fresh replica reads generation 2 from its first entry.
		const arriving = open();
		expectOk(arriving.store.applyRemote(seed));
		expect(titles(arriving)).toEqual(['Groceries', 'Reading list']);

		// The phone arrives at generation 2 holding work generation 1 never saw.
		// The rollover rule is that its cursor resets to zero AND its whole state
		// becomes unsent, so it pushes everything it has.
		expectOk(arriving.store.applyRemote(phone.store.encodeStateSince()));

		// The offline edit is not merely present, it landed on the SAME row rather
		// than creating a second one. That is what identity preservation buys.
		expect(titles(arriving)).toEqual(['Reading list', 'edited on a plane']);
		expect(expectOk(arriving.db.tables.notes.get(noteId))?.title).toBe(
			'edited on a plane',
		);
		expect(arriving.store.hasUnresolvedDependencies()).toBe(false);
	});

	test('CONTROL: a REBUILT generation destroys exactly that edit', () => {
		// The same scenario, with the rollover done the other way: the laptop
		// rebuilds the application from its own values instead of re-encoding its
		// structs. Every row is a new struct at a new id, so the phone's edit
		// refers to a row the new generation has never heard of.
		//
		// If this test ever passes as a merge, snapshotting stopped being
		// necessary and the test above proves nothing.
		const { laptop, phone, noteId } = synchronisedPair();
		expectOk(
			phone.db.tables.notes.update(noteId, { title: 'edited on a plane' }),
		);

		const rebuilt = open();
		for (const row of expectOk(laptop.db.tables.notes.list()).rows) {
			expectOk(rebuilt.db.tables.notes.create({ title: row.title }));
		}
		const seed = rebuilt.store.encodeStateSince();

		const arriving = open();
		expectOk(arriving.store.applyRemote(seed));
		expectOk(arriving.store.applyRemote(phone.store.encodeStateSince()));

		// The phone's row did not merge with anything. It arrived as a THIRD row
		// beside two rebuilt strangers, so the note now exists twice: once as the
		// rebuilt copy carrying the stale title, once as the phone's original.
		expect(titles(arriving)).toEqual([
			'Groceries',
			'Reading list',
			'Reading list',
			'edited on a plane',
		]);
		// And the rebuilt generation has no row at the id every device already
		// uses, so every link, cursor and reference to it is dangling.
		expect(expectOk(rebuilt.db.tables.notes.get(noteId))).toBeUndefined();
	});
});

describe('the rollover needs no proof, which is why it is affordable', () => {
	test('two devices seeding the SAME generation independently still converge', () => {
		// The property that removes the coordination problem. Nobody has to be
		// caught up, elected, or authoritative to seed a generation, because two
		// snapshots of overlapping state merge into exactly the union. That is the
		// requirement every withdrawn compaction design failed to satisfy.
		const { laptop, phone, noteId } = synchronisedPair();
		expectOk(
			phone.db.tables.notes.update(noteId, { title: 'edited on a plane' }),
		);
		expectOk(laptop.db.tables.notes.create({ title: 'written on the laptop' }));

		const both = open();
		// Deliberately in the wrong order, and with the laggard first.
		expectOk(both.store.applyRemote(phone.store.encodeStateSince()));
		expectOk(both.store.applyRemote(laptop.store.encodeStateSince()));

		expect(titles(both)).toEqual([
			'Reading list',
			'edited on a plane',
			'written on the laptop',
		]);
		expect(both.store.hasUnresolvedDependencies()).toBe(false);
	});

	test('a snapshot is a duplicate of history, not an addition to it', () => {
		// What a generation costs. Each device pushes its whole state on arrival,
		// so a generation costs N snapshots rather than one, and applying all of
		// them is idempotent rather than cumulative.
		const { laptop } = synchronisedPair();
		const seed = laptop.store.encodeStateSince();

		const arriving = open();
		for (let index = 0; index < 5; index += 1) {
			expectOk(arriving.store.applyRemote(seed));
		}

		expect(titles(arriving)).toEqual(['Groceries', 'Reading list']);
	});
});

describe('choosing the next generation is not a thing a CRDT can do', () => {
	test('two devices that each start a generation produce two, and both survive', () => {
		// Why the pointer saying "this generation is current" cannot itself be
		// Yjs. A CRDT is for questions where "both" is a sensible answer. Here it
		// is not: two devices proposing a successor merge into TWO successors, and
		// converging on both is exactly the wrong outcome. Something has to
		// choose, and choosing is a serialized decision rather than a merge.
		const proposals = open();
		const laptop = open();
		const phone = open();
		expectOk(
			laptop.db.tables.notes.create({
				title: 'the laptop says generation 2 is here',
			}),
		);
		expectOk(
			phone.db.tables.notes.create({
				title: 'the phone says generation 2 is here',
			}),
		);

		expectOk(proposals.store.applyRemote(laptop.store.encodeStateSince()));
		expectOk(proposals.store.applyRemote(phone.store.encodeStateSince()));

		// Perfect convergence, and useless as an answer.
		expect(titles(proposals)).toHaveLength(2);
	});
});
