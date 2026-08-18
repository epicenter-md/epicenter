/**
 * What a never-compacted log remembers after you delete something.
 *
 * ADR-0217 refuses to compact the authority's log, and prices that refusal in
 * storage: about 4 MB a year against 10 GB. That is the whole cost as the
 * record states it, and it is not the whole cost.
 *
 * An append-only log keeps the update that CREATED a row, so deleting the row
 * removes it from the current state and removes nothing from the log. The
 * content is still there, in bytes, and a device joining for the first time
 * replays the log from position zero, so it downloads everything anyone has
 * ever deleted.
 *
 * That is not an argument against refusing compaction. It is the fact that
 * decides how long a superseded generation may be kept, which is otherwise easy
 * to reason about as though the only cost were disk.
 */

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { defineDatabase } from '@epicenter/database';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import type { Result } from 'wellcrafted/result';

import { createAccountStore, syncEngineOf } from '../src/store/store.js';
import { openSyncAuthority } from '../src/sync/authority.js';

const evidenceDatabase = defineDatabase({
	id: 'so.epicenter.honeycrisp',
	tables: { notes: { title: 'string' } },
});

/** Distinctive enough that finding it in a blob cannot be a coincidence. */
const CANARY = 'SECRET-CANARY-my-therapist-appointment';
/** Never written anywhere. The control for every search below. */
const NEVER_WRITTEN = 'THIS-STRING-WAS-NEVER-WRITTEN-ANYWHERE';

function expectOk<TValue, TError>(result: Result<TValue, TError>): TValue {
	if (result.error !== null) throw result.error;
	return result.data as TValue;
}

function contains(blobs: readonly Uint8Array[], needle: string): boolean {
	return Buffer.concat(blobs.map((bytes) => Buffer.from(bytes)))
		.toString('latin1')
		.includes(needle);
}

/** A device that wrote a note, pushed it, then deleted it. */
function afterWritingAndDeleting() {
	const database = createBunSqliteAdapter(new Database(':memory:'));
	const db = createAccountStore({ database: evidenceDatabase, sqlite: database });
	const store = db.store;
	const authorityDatabase = createBunSqliteAdapter(new Database(':memory:'));
	const authority = openSyncAuthority({ sqlite: authorityDatabase });

	const note = expectOk(db.tables.notes.create({ title: CANARY }));
	const created = syncEngineOf(store).coalesce();
	if (created === undefined) throw new Error('nothing to send');
	expectOk(authority.append(created.bytes));
	syncEngineOf(store).acknowledge(created.id);

	db.tables.notes.delete(note.id);
	const deleted = syncEngineOf(store).coalesce();
	if (deleted !== undefined) expectOk(authority.append(deleted.bytes));

	return {
		store,
		db,
		note,
		authority,
		localLog: () =>
			database
				.all<{ bytes: Uint8Array }>('SELECT bytes FROM _updates')
				.map((row) => new Uint8Array(row.bytes as never)),
		authorityLog: () =>
			authorityDatabase
				.all<{ bytes: Uint8Array }>('SELECT bytes FROM _log')
				.map((row) => new Uint8Array(row.bytes as never)),
	};
}

describe('a deleted row is gone from the application', () => {
	test('no verb can reach it', () => {
		const world = afterWritingAndDeleting();

		expect(expectOk(world.db.tables.notes.get(world.note.id))).toBeUndefined();
		expect(world.db.tables.notes.ids()).toEqual([]);
		expect(world.db.tables.notes.list().rows).toEqual([]);
	});

	test('and gone from the current state, which is what gc reclaims', () => {
		// The half that works. A snapshot of the document today does NOT carry it,
		// so anything derived from current state is clean.
		const world = afterWritingAndDeleting();

		expect(contains([world.store.encodeStateSince()], CANARY)).toBe(false);
	});
});

describe('and still in every log, for as long as the log exists', () => {
	test("the device's own log still holds the text", () => {
		const world = afterWritingAndDeleting();

		expect(contains(world.localLog(), CANARY)).toBe(true);
		// CONTROL: a string nobody ever wrote must not be found, or the search is
		// matching on something other than the content and proves nothing.
		expect(contains(world.localLog(), NEVER_WRITTEN)).toBe(false);
	});

	test("the authority's log still holds the text", () => {
		const world = afterWritingAndDeleting();

		expect(contains(world.authorityLog(), CANARY)).toBe(true);
		expect(contains(world.authorityLog(), NEVER_WRITTEN)).toBe(false);
	});

	test('and a device joining for the FIRST time downloads it', () => {
		// The consequence that matters. Catch-up is "everything after your
		// cursor", and a new device's cursor is zero, so a person who joins a
		// phone today receives every note anyone has ever deleted. Nothing
		// surfaces it, because the workspace reads current state; it arrives, is
		// applied, and is invisible.
		const world = afterWritingAndDeleting();
		const backlog = expectOk(world.authority.since(0, 1_000));

		expect(
			contains(
				backlog.map((entry) => entry.bytes),
				CANARY,
			),
		).toBe(true);
		expect(
			contains(
				backlog.map((entry) => entry.bytes),
				NEVER_WRITTEN,
			),
		).toBe(false);

		// And the arriving device shows nothing, which is why this is invisible
		// rather than merely undesirable.
		const arrivingDb = createAccountStore({
			database: evidenceDatabase,
			sqlite: createBunSqliteAdapter(new Database(':memory:')),
		});
		const arriving = arrivingDb.store;
		for (const entry of backlog)
			expectOk(syncEngineOf(arriving).applyRemote(entry.bytes));
		expect(arrivingDb.tables.notes.list().rows).toEqual([]);
	});
});

describe('what makes a deletion real', () => {
	test('only a rebuild drops it, because only a rebuild writes state instead of history', () => {
		// The reason a superseded generation cannot be kept forever, and the
		// reason the retention window is a privacy commitment rather than a
		// storage decision. A new generation seeded from CURRENT STATE carries no
		// trace; the old log carries all of it until it is deleted.
		const world = afterWritingAndDeleting();
		const rebuilt = openSyncAuthority({
			sqlite: createBunSqliteAdapter(new Database(':memory:')),
		});
		expectOk(rebuilt.append(world.store.encodeStateSince()));

		const fresh = expectOk(rebuilt.since(0, 1_000));
		expect(
			contains(
				fresh.map((entry) => entry.bytes),
				CANARY,
			),
		).toBe(false);
		// CONTROL: the old generation still has it, so the difference is the
		// rebuild and not the search.
		expect(contains(world.authorityLog(), CANARY)).toBe(true);
	});
});
