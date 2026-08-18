/**
 * The client half of sync: what a replica owes the authority, and what it has
 * read from it.
 *
 * These tests reach the SQLite file directly rather than only the store's
 * surface, because the properties under test are properties of the log's shape.
 * A remote update landing in the log twice is invisible from every verb the
 * store exposes, and it was live for exactly that reason.
 */

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { defineDatabase } from '@epicenter/database';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import type { Result } from 'wellcrafted/result';

import { copyBytes } from './log.js';
import { createAccountStore, syncEngineOf } from './store.js';

const workspace = defineDatabase({
	id: 'so.epicenter.honeycrisp',
	tables: { notes: { title: 'string' } },
});

function open() {
	const raw = new Database(':memory:');
	const database = createBunSqliteAdapter(raw);
	const db = createAccountStore({ workspace: workspace, database });
	return {
		store: db.store,
		db,
		logRows: () =>
			database.all<{ seq: number; len: number }>(
				'SELECT seq, length(bytes) AS len FROM _updates ORDER BY seq',
			),
		/** The raw queue, so a test can see what a merge was given to work with. */
		outbox: () =>
			database
				.all<{ id: number; bytes: Uint8Array | ArrayBuffer }>(
					'SELECT id, bytes FROM _outbox ORDER BY id',
				)
				.map((row) => ({ id: row.id, bytes: copyBytes(row.bytes) })),
	};
}

function expectOk<TValue, TError>(result: Result<TValue, TError>): TValue {
	if (result.error !== null) throw result.error;
	// `TError` may itself admit null, so the union does not discriminate on
	// `error` for a caller that has not fixed it to a concrete type.
	return result.data as TValue;
}

function titles(replica: ReturnType<typeof open>): string[] {
	return replica.db.tables.notes
		.list()
		.rows.map((row) => row.title)
		.sort();
}

describe('the local log holds each update once', () => {
	test('a remote update is persisted once, as the bytes that arrived', () => {
		// This was a live bug, and the control that catches it is the byte count:
		// the `updateV2` listener appended what the document EMITTED while
		// `applyRemote` appended what it RECEIVED, so one 108-byte update became
		// two 108-byte rows and the log grew at double the rate it reported.
		// Neither copy was wrong on its own, so no verb could see it.
		const author = open();
		const reader = open();
		expectOk(author.db.tables.notes.create({ title: 'Groceries' }));
		const update = author.store.encodeStateSince();

		expectOk(syncEngineOf(reader.store).applyRemote(update));

		const rows = reader.logRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.len).toBe(update.length);
	});

	test('a remote update owes the authority nothing, because it came from there', () => {
		// Re-offering received bytes would grow the authority's log with entries
		// that carry no new information, and two replicas would pump one update
		// back and forth between them forever.
		const author = open();
		const reader = open();
		expectOk(author.db.tables.notes.create({ title: 'Groceries' }));
		expectOk(
			syncEngineOf(reader.store).applyRemote(author.store.encodeStateSince()),
		);

		expect(reader.outbox()).toHaveLength(0);
		expect(syncEngineOf(reader.store).coalesce()).toBeUndefined();
	});

	test('an application writing inside a row document owes it, like any local work', () => {
		// Prose reaches storage through the update listener rather than through a
		// store verb, so it is the one local write that could plausibly be missed.
		const author = open();
		const note = expectOk(
			author.db.tables.notes.create({ title: 'Groceries' }),
		);
		const before = author.outbox().length;
		const text = author.db.tables.notes
			.document(note.id)
			?.get('editor', 'text');
		if (text === undefined) throw new Error('the row has no document');
		text.applyDelta(text.change.insert('buy milk') as never);

		expect(author.outbox().length).toBeGreaterThan(before);
	});
});

describe('coalesce merges only what this replica authored', () => {
	test('twenty transactions become one entry that carries all twenty', () => {
		const author = open();
		const reader = open();
		for (let index = 0; index < 20; index += 1) {
			expectOk(author.db.tables.notes.create({ title: `note ${index}` }));
		}
		expect(author.outbox()).toHaveLength(20);

		const merged = syncEngineOf(author.store).coalesce();
		if (merged === undefined) throw new Error('nothing to send');
		expect(author.outbox()).toHaveLength(1);

		expectOk(syncEngineOf(reader.store).applyRemote(merged.bytes));
		expect(titles(reader)).toHaveLength(20);
		expect(syncEngineOf(reader.store).hasUnresolvedDependencies()).toBe(false);
	});

	test('CONTROL: the last entry ALONE carries one note and leaves a gap', () => {
		// Without this the test above passes when `coalesce` simply returns the
		// newest entry and silently drops nineteen, which is the exact failure the
		// merge exists to prevent. The single entry has to be visibly insufficient
		// and visibly incomplete, not merely smaller.
		const author = open();
		const lastOnly = open();
		for (let index = 0; index < 20; index += 1) {
			expectOk(author.db.tables.notes.create({ title: `note ${index}` }));
		}
		const last = author.outbox().at(-1);
		if (last === undefined) throw new Error('empty outbox');

		expectOk(syncEngineOf(lastOnly.store).applyRemote(last.bytes));

		expect(titles(lastOnly)).toEqual(['note 19']);
		// And the replica cannot even report the shortfall as an error, which is
		// why the merge has to be right rather than merely checked.
		expect(syncEngineOf(lastOnly.store).hasUnresolvedDependencies()).toBe(
			false,
		);
	});

	test('coalescing twice is a no-op rather than a re-merge', () => {
		const author = open();
		expectOk(author.db.tables.notes.create({ title: 'a' }));
		expectOk(author.db.tables.notes.create({ title: 'b' }));
		const first = syncEngineOf(author.store).coalesce();
		const second = syncEngineOf(author.store).coalesce();

		expect(second?.id).toBe(first?.id);
		expect(second?.bytes).toEqual(first?.bytes as Uint8Array);
	});

	test('an entry authored after a coalesce survives the acknowledgement', () => {
		// The ack names a position rather than "everything", because work authored
		// while a submission was in flight has been acknowledged by nobody.
		const author = open();
		expectOk(author.db.tables.notes.create({ title: 'sent' }));
		const inFlight = syncEngineOf(author.store).coalesce();
		if (inFlight === undefined) throw new Error('nothing to send');
		expectOk(
			author.db.tables.notes.create({ title: 'authored while in flight' }),
		);

		syncEngineOf(author.store).acknowledge(inFlight.id);

		const remaining = author.outbox();
		expect(remaining).toHaveLength(1);
		expect(remaining[0]?.id).toBeGreaterThan(inFlight.id);
	});

	test('an acknowledged replica still holds everything it sent', () => {
		// The ack drops the OBLIGATION, never the data. A store that confused the
		// two would empty itself every time sync succeeded.
		const author = open();
		expectOk(author.db.tables.notes.create({ title: 'Groceries' }));
		const sent = syncEngineOf(author.store).coalesce();
		if (sent === undefined) throw new Error('nothing to send');
		syncEngineOf(author.store).acknowledge(sent.id);

		expect(titles(author)).toEqual(['Groceries']);
		expect(author.outbox()).toHaveLength(0);
	});
});

describe('the cursor is a log position, and never a state vector', () => {
	test('a fresh replica reads zero, which is also "I have read nothing"', () => {
		expect(syncEngineOf(open().store).cursor()).toBe(0);
	});

	test('advancing survives a reopen of the same file', () => {
		const database = createBunSqliteAdapter(new Database(':memory:'));
		syncEngineOf(
			createAccountStore({ workspace: workspace, database }).store,
		).advance(7);

		expect(
			syncEngineOf(
				createAccountStore({ workspace: workspace, database }).store,
			).cursor(),
		).toBe(7);
	});
});

describe('the stamp lands only on an empty store', () => {
	test('a store that grew before it was stamped is refused with Unstampable', () => {
		const { store, db } = open();
		expectOk(db.tables.notes.create({ title: 'pre-bootstrap work' }));

		const refused = syncEngineOf(store).adoptDocumentIdentity('doc-1');
		expect(refused.error?.name).toBe('Unstampable');
		expect(syncEngineOf(store).documentIdentity()).toBeUndefined();
	});

	test('a stamped store keeps its first identity, and re-stamping is a no-op', () => {
		const { store, db } = open();
		expectOk(syncEngineOf(store).adoptDocumentIdentity('doc-1'));
		expectOk(db.tables.notes.create({ title: 'after the stamp' }));

		// First write wins: membership never changes in place, even once the
		// store holds state, and only discarding the file whole changes it.
		expectOk(syncEngineOf(store).adoptDocumentIdentity('doc-2'));
		expect(syncEngineOf(store).documentIdentity()).toBe('doc-1');
	});

	test('read progress alone is a commitment: a moved cursor refuses the stamp', () => {
		const { store } = open();
		syncEngineOf(store).advance(3);

		const refused = syncEngineOf(store).adoptDocumentIdentity('doc-1');
		expect(refused.error?.name).toBe('Unstampable');
	});
});

describe('a row document root is created exactly once', () => {
	test('two devices first-opening one note both keep their prose', () => {
		// The window this closes. `document(id).get(name)` creates on miss, and a
		// created nested type is addressed by the operation that made it, so two
		// devices opening the same fresh note each minted a type at that key and
		// map LWW discarded one along with everything typed into it. Naming the
		// root at `create` leaves exactly one creator.
		const author = open();
		const other = open();
		const note = expectOk(
			author.db.tables.notes.create(
				{ title: 'Groceries' },
				{ document: ['editor'] },
			),
		);
		expectOk(
			syncEngineOf(other.store).applyRemote(author.store.encodeStateSince()),
		);

		for (const [replica, words] of [
			[author, 'written on the phone'],
			[other, 'written on the laptop'],
		] as const) {
			const text = replica.db.tables.notes.document(note.id)?.get('editor');
			if (text === undefined) throw new Error('the row has no editor');
			text.applyDelta(text.change.insert(words) as never);
		}

		expectOk(
			syncEngineOf(author.store).applyRemote(
				other.store.encodeStateSince(author.store.stateVector()),
			),
		);
		expectOk(
			syncEngineOf(other.store).applyRemote(
				author.store.encodeStateSince(other.store.stateVector()),
			),
		);

		const merged = JSON.stringify(
			author.db.tables.notes.document(note.id)?.get('editor').toJSON(),
		);
		expect(merged).toContain('phone');
		expect(merged).toContain('laptop');
		expect(merged).toBe(
			JSON.stringify(
				other.db.tables.notes.document(note.id)?.get('editor').toJSON(),
			),
		);
	});

	test('CONTROL: a root NOT named at create still races, which is why naming it matters', () => {
		// The same scenario without the declaration. Kept so the fix is measured
		// against the failure rather than asserted, and so anyone who removes the
		// `document` option sees what it was buying.
		const author = open();
		const other = open();
		const note = expectOk(
			author.db.tables.notes.create({ title: 'Groceries' }),
		);
		expectOk(
			syncEngineOf(other.store).applyRemote(author.store.encodeStateSince()),
		);

		for (const [replica, words] of [
			[author, 'written on the phone'],
			[other, 'written on the laptop'],
		] as const) {
			const text = replica.db.tables.notes.document(note.id)?.get('editor');
			if (text === undefined) throw new Error('the row has no editor');
			text.applyDelta(text.change.insert(words) as never);
		}

		expectOk(
			syncEngineOf(author.store).applyRemote(
				other.store.encodeStateSince(author.store.stateVector()),
			),
		);
		expectOk(
			syncEngineOf(other.store).applyRemote(
				author.store.encodeStateSince(other.store.stateVector()),
			),
		);

		const merged = JSON.stringify(
			author.db.tables.notes.document(note.id)?.get('editor').toJSON(),
		);
		const survivors = ['phone', 'laptop'].filter((device) =>
			merged.includes(device),
		);
		expect(survivors).toHaveLength(1);
	});
});
