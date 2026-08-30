import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import {
	defineData,
	defineTable,
	field,
	InstantString,
} from '@epicenter/data/definition';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import * as Y from '@y/y';
import { Ok } from 'wellcrafted/result';
import { createSqliteDurablePort } from './log.js';
import { createMemoryRecord, openMemory } from './memory.js';
import {
	type AccountStore,
	createAccountStore,
	createLocalStore,
	type DataOf,
	type LocalStore,
	StoreUnusableError,
	type SyncCapability,
	syncEngineOf,
} from './store.js';

const database = defineData({
	id: 'so.epicenter.honeycrisp',
	kv: { theme: field.select(['light', 'dark']), fontSize: field.number() },
	tables: {
		notes: defineTable({
			scalars: {
				title: field.string(),
				tags: field.tags(),
				date: field.nullable(field.string()),
			},
			types: ['editor'],
			file: {
				serialize: (row) => ({
					data: { title: row.title, tags: row.tags, date: row.date },
					content: row.editor.toString(),
				}),
				deserialize: (file) => {
					const editor = new Y.Type();
					if (file.content !== '') editor.insert(0, [file.content]);
					return Ok({
						editor,
						title: String(file.data.title ?? ''),
						tags: (file.data.tags ?? []) as string[],
						date: (file.data.date ?? null) as string | null,
					});
				},
			},
		}),
	},
});

let db: DataOf<typeof database>;

beforeEach(async () => {
	db = await openMemory(database);
});

/** A note, and its minted id, for tests that need one to exist. */
function note(
	fields: Partial<Parameters<typeof db.tables.notes.create>[0]> = {},
) {
	return db.tables.notes.create({
		title: 'Groceries',
		tags: ['food'],
		date: null,
		...fields,
	});
}

/** Wrap one application-document update the way the wire carries it. */

function exchange(a: AccountStore, b: AccountStore) {
	const fromA = a.encodeStateSince(b.stateVector());
	const fromB = b.encodeStateSince(a.stateVector());
	syncEngineOf(b).applyRemote(fromA);
	syncEngineOf(a).applyRemote(fromB);
}

describe('a read is a property access on a plain object', () => {
	test('disposing the data disposes the store under it', async () => {
		// This asserted `data.store !== data`, which nearly any implementation
		// satisfies including a broken one. What the sentence actually claims is
		// ownership, and ownership is only observable at disposal.
		const opened = await openMemory(database);
		{
			await using data = opened;
			expect(data.tables.notes.rows).toEqual([]);
		}
		expect(() => opened.tables.notes.rows).toThrow();
	});

	test('create returns the row it made, at a minted id', async () => {
		const made = note();
		expect(made.id).toBeString();
		expect(made.id).toHaveLength(24);
		expect(made.title).toBe('Groceries');
		expect(made.tags).toEqual(['food']);
	});

	test('an absent row reads as undefined, which is a fact not a failure', async () => {
		expect(db.tables.notes.get('nope')).toBeUndefined();
	});

	test('every scalar verb is synchronous; only a document open is a load', async () => {
		// One in-memory application document over a synchronous SQLite boundary,
		// so no scalar read or write has I/O to await. The one asynchronous verb
		// is `openDocument`, which is a load by decision (ADR-0248).
		const made = note();
		for (const value of [
			db.tables.notes.get(made.id),
			db.tables.notes.update(made.id, { title: 'x' }),
			db.tables.notes.rows,
			db.tables.notes.ids(),
			db.kv.get('theme'),
			db.kv.update({ theme: 'dark' }),
			db.tables.notes.delete(made.id),
		]) {
			expect(value).not.toBeInstanceOf(Promise);
		}
	});

	test('data groups direct operations with transact', async () => {
		let notifications = 0;
		db.tables.notes.subscribe(() => {
			notifications += 1;
		});

		db.transact(() => {
			note({ title: 'one' });
			note({ title: 'two' });
		});

		// One notification for two rows, which is the point of grouping: a
		// transaction is one commit, so it is one thing to re-read after.
		expect(notifications).toBe(1);
		expect(db.tables.notes.rows).toHaveLength(2);
	});
});

describe('a write that reaches nothing is a failure', () => {
	test('update on an absent row refuses instead of swallowing it', async () => {
		const { data, error } = db.tables.notes.update('nope', { title: 'x' });
		expect(data).toBeNull();
		// The verb this replaces returned Ok(undefined) and dropped the write.
		expect(error?.name).toBe('RowAbsent');
	});

	test('create admits a payload and get reports its conformance', async () => {
		const made = db.tables.notes.create({} as never);
		expect(made.id).toHaveLength(24);
		// A row this declaration cannot read does not arrive through `get`; it is
		// on `nonconforming`, with its raw values and the fields that failed.
		expect(db.tables.notes.get(made.id)).toBeUndefined();
		const issue = db.tables.notes.nonconforming.find(
			(candidate) => candidate.id === made.id,
		);
		expect(issue?.issues.map((each) => each.field)).toEqual([
			'title',
			'tags',
			'date',
		]);
	});

	test('an invalid supplied value is written and reported on read', async () => {
		const made = note();
		const result = db.tables.notes.update(made.id, {
			tags: 'food' as never,
		});
		expect(result.error).toBeNull();
		// The write lands; the read is where the declaration objects. `get` stops
		// answering for the row, and `nonconforming` carries what survived so a
		// caller can compose its own repair (ADR-0125).
		expect(db.tables.notes.get(made.id)).toBeUndefined();
		const reported = db.tables.notes.nonconforming.find(
			(candidate) => candidate.id === made.id,
		);
		expect(reported?.conforming.title).toBe('Groceries');
		expect(reported?.issues.map((issue) => issue.field)).toEqual(['tags']);
	});

	test('reserved row attributes remain a structural boundary', async () => {
		const made = note();
		expect(() =>
			db.tables.notes.update(made.id, { '!presence': 'absent' } as never),
		).toThrow(/reserved/);
		expect(db.tables.notes.get(made.id)?.title).toBe('Groceries');
	});
});

describe('deletion', () => {
	test('a deleted row reads as absent', async () => {
		const made = note();
		db.tables.notes.delete(made.id);
		expect(db.tables.notes.get(made.id)).toBeUndefined();
		expect(db.tables.notes.ids()).toEqual([]);
	});

	test('deleting twice leaves the table exactly as the first delete did', async () => {
		const made = note();
		db.tables.notes.delete(made.id);
		// Deleting an absent address reports nothing and changes nothing: the
		// verb has no outcome to report, so the second call is indistinguishable
		// from never having made it.
		db.tables.notes.delete(made.id);
		expect(db.tables.notes.get(made.id)).toBeUndefined();
		expect(db.tables.notes.ids()).toEqual([]);
	});

	test('CHURN DOES NOT ACCUMULATE A CORPSE PER DELETED ROW', async () => {
		// The reason deletion removes the row's attribute instead of clearing it
		// and flagging it absent, which is what ADR-0212 chose. A tombstone is
		// paid by every device, in memory, on every load, forever, and a phone
		// does not get to opt out. At this row's shape the two models measure 37 B
		// and 86 B per dead row, so a regression to clear-and-flag fails here long
		// before anyone notices it on a device.
		const empty = db.store.encodeStateSince().length;
		for (let index = 0; index < 200; index += 1) {
			db.tables.notes.delete(note({ title: 'x'.repeat(100) }).id);
		}
		expect(db.tables.notes.ids()).toEqual([]);
		const perDeadRow = (db.store.encodeStateSince().length - empty) / 200;
		expect(perDeadRow).toBeLessThan(60);
	});

	test('a deleted address cannot be revived, only refused', async () => {
		// Deletion takes the row's attribute off the table root, so a deleted id
		// is indistinguishable from one nothing ever held. There is no reuse path
		// to get wrong: `update` refuses, and `create` mints an id of its own.
		const made = note();
		db.tables.notes.delete(made.id);
		const { data, error } = db.tables.notes.update(made.id, { title: 'back?' });
		expect(data).toBeNull();
		expect(error?.name).toBe('RowAbsent');
		expect(db.tables.notes.get(made.id)).toBeUndefined();
	});
});

describe('a nonconforming row is reported, never repaired', () => {
	const wrongDatabase = defineData({
		id: 'so.epicenter.honeycrisp',
		kv: {},
		tables: {
			notes: {
				scalars: {
					title: field.string(),
					tags: field.string(),
					date: field.nullable(field.string()),
				},
			},
		},
	});

	/**
	 * Corrupt a stored value the way it actually happens: a peer device on a
	 * release whose declaration disagrees syncs the row in, writes a value its
	 * own declaration accepts, and syncs it back (ADR-0240: two definitions
	 * are never live in one runtime, but two devices may run two releases).
	 */
	async function corruptTags(rowId: string): Promise<void> {
		const peer = await openMemory(wrongDatabase);
		exchange(db.store, peer.store);
		const written = peer.tables.notes.update(rowId, { tags: 'food' });
		if (written.error !== null) throw written.error;
		exchange(db.store, peer.store);
	}

	test('the call site composes application recovery and what survived', async () => {
		const made = note();
		await corruptTags(made.id);

		const row = db.tables.notes.get(made.id);
		expect(row).toBeUndefined();
		// Plain diagnostic data, not a tagged error: nonconformance is a fact
		// about the table, so it is reported on the table rather than handed back
		// as one row's failure.
		const reported = db.tables.notes.nonconforming.find(
			(candidate) => candidate.id === made.id,
		);
		expect(reported?.issues.map((issue) => issue.field)).toEqual(['tags']);
		// Never repaired and never hidden: the raw payload survives intact.
		expect(reported?.raw).toEqual({
			title: 'Groceries',
			tags: 'food',
			date: null,
		});

		// The one recovery composition, and it still reads as one expression.
		const recovered = row ?? { id: made.id, ...reported?.conforming };
		expect(recovered).toEqual({ id: made.id, title: 'Groceries', date: null });
	});

	test('rows and nonconforming separate what it can read from what it cannot', async () => {
		const broken = note({ title: 'broken' });
		const fine = note({ title: 'fine' });
		await corruptTags(broken.id);
		const listed = db.tables.notes;
		expect(listed.rows.map((row) => row.id)).toEqual([fine.id]);
		expect(listed.nonconforming.map((issue) => issue.id)).toEqual([broken.id]);
	});
});

describe('two replicas converge', () => {
	async function pair() {
		return { laptop: await openMemory(database) };
	}

	test('a row made on one device appears on the other', async () => {
		const { laptop } = await pair();
		const made = note({ title: 'Recorded on the phone', tags: ['voice'] });
		exchange(db.store, laptop.store);

		expect(laptop.tables.notes.get(made.id)?.title).toBe(
			'Recorded on the phone',
		);
	});

	test('offline edits to different fields of one row both survive', async () => {
		const { laptop } = await pair();
		const made = note({ title: 'first' });
		exchange(db.store, laptop.store);

		db.tables.notes.update(made.id, { title: 'phone title' });
		laptop.tables.notes.update(made.id, { date: '2026-08-07' });
		exchange(db.store, laptop.store);

		for (const [name, handle] of [
			['phone', db.tables.notes],
			['laptop', laptop.tables.notes],
		] as const) {
			const settled = handle.get(made.id);
			expect(`${name}:${settled?.title}`).toBe(`${name}:phone title`);
			expect(`${name}:${settled?.date}`).toBe(`${name}:2026-08-07`);
		}
	});

	test('a delete on one device beats an edit on the other', async () => {
		// The case ADR-0212 kept a corpse per deleted row to serve. It converges
		// without one, and to the same answer: the row is gone on both devices,
		// and the offline edit is gone with it rather than lingering as a field on
		// a tombstone that a revived address would hand back
		// (`evidence/deletion-model.test.ts`).
		const { laptop } = await pair();
		const made = note({ title: 'first' });
		exchange(db.store, laptop.store);

		db.tables.notes.delete(made.id);
		laptop.tables.notes.update(made.id, { title: 'edited offline' });
		exchange(db.store, laptop.store);

		expect(db.tables.notes.get(made.id)).toBeUndefined();
		expect(laptop.tables.notes.get(made.id)).toBeUndefined();
		expect(laptop.tables.notes.ids()).toEqual([]);
	});

	test('two devices creating rows concurrently keep both', async () => {
		// Safe by construction rather than by care: a minted 24-character id
		// cannot collide, so two devices never mint a container at one address.
		const { laptop } = await pair();
		note({ title: 'from the phone' });
		laptop.tables.notes.create({
			title: 'from the laptop',
			tags: [],
			date: null,
		});
		exchange(db.store, laptop.store);

		expect(db.tables.notes.rows).toHaveLength(2);
		expect(laptop.tables.notes.rows).toHaveLength(2);
	});
});

describe("a row's type content lives on the row (ADR-0295)", () => {
	test('an absent row has no content, which is a fact not a failure', () => {
		expect(db.tables.notes.get('nope')).toBeUndefined();
	});

	test('a type field is minted with its row and is empty', () => {
		const made = note();
		const content = db.tables.notes.get(made.id);
		expect(content?.editor).toBeDefined();
		expect(content?.editor.length).toBe(0);
	});

	test('deleting the row takes its type content with it', () => {
		const made = note();
		const editor = db.tables.notes.get(made.id)?.editor;
		editor?.applyDelta(editor.change.insert('milk') as never);
		db.tables.notes.delete(made.id);
		expect(db.tables.notes.get(made.id)).toBeUndefined();
	});

	test('a type field is a live type on the row, never a JSON scalar', () => {
		// `get` carries it and `stored()` cannot: the faithful read answers in
		// JSON, and a nested type is not one. That is the whole reason the
		// exporter reads through `store.rowFile` rather than through `stored`.
		const made = note();
		const stored = db.store.stored().tables.get('notes')?.get(made.id);
		expect(Object.keys(stored ?? {})).not.toContain('editor');
		expect(db.tables.notes.get(made.id)?.editor).toBeDefined();
	});

	test('an editor writing into its own type field cannot touch the row', () => {
		// Bound to the ROW itself, a ProseMirror schema whose doc node declares
		// attributes would overwrite the row's fields and sync that; measured in
		// ADR-0215. A type field is a type nested UNDER the row, so its
		// attributes are its own.
		const made = note();
		db.tables.notes
			.get(made.id)
			?.editor.setAttr('title' as never, 'CLOBBER' as never);
		expect(db.tables.notes.get(made.id)?.title).toBe('Groceries');
	});

	test('a type field rides the whole state and comes back attached', async () => {
		const made = note();
		const editor = db.tables.notes.get(made.id)?.editor;
		editor?.applyDelta(editor.change.insert('milk and eggs') as never);

		const laptop = await openMemory(database);
		syncEngineOf(laptop.store).applyRemote(db.store.encodeStateSince());
		expect(laptop.tables.notes.get(made.id)?.editor.toString()).toContain(
			'milk and eggs',
		);
	});
});

describe('kv is where anything two devices both write belongs', () => {
	test('an unwritten key reads as undefined and is reported', async () => {
		// The application falls back; the platform says which keys it could not
		// read. Never defaulted here, because a default in a definition would be
		// a value nothing stored (ADR-0255).
		expect(db.kv.get('theme')).toBeUndefined();
		expect(db.kv.nonconforming.map(({ field }) => field)).toEqual([
			'theme',
			'fontSize',
		]);
	});

	test('a write touches only the keys it names', async () => {
		db.kv.update({ theme: 'dark' });
		expect(db.kv.get('theme')).toBe('dark');
		expect(db.kv.get('fontSize')).toBeUndefined();
	});

	test('an undeclared key is preserved for a future declaration', async () => {
		db.kv.update({ nope: 1 } as never);
		expect(db.store.stored().kv).toEqual({ nope: 1 });
		expect(db.kv.get('theme')).toBeUndefined();
	});

	test('ONE unreadable key costs that key and not the object', async () => {
		// The whole reason conformance is per key. It used to be whole-object:
		// one bad value made every read an error, and both applications rebuilt
		// the good half by hand out of the diagnostic.
		db.kv.update({ fontSize: 20 });
		db.kv.update({ theme: 'purple' as never });
		expect(db.kv.get('fontSize')).toBe(20);
		expect(db.kv.get('theme')).toBeUndefined();
		expect(db.kv.nonconforming.map(({ field }) => field)).toEqual(['theme']);
	});

	test('TWO DEVICES BOOTING OFFLINE BOTH KEEP THEIR SETTINGS', async () => {
		// The case that motivated moving KV to a reserved root. Through a chosen
		// row id this loses one device's write entirely, because each mints its
		// own nested container and map LWW keeps one. A root is addressed by its
		// name, so both survive. `evidence/bench/row-model.ts` keeps the losing
		// contrast, now that the chosen-id door is gone from the API.
		const phone = await openMemory(database);
		const laptop = await openMemory(database);

		phone.kv.update({ theme: 'dark' });
		laptop.kv.update({ fontSize: 22 });
		exchange(phone.store, laptop.store);

		// Both writes survive on both devices, which is the claim.
		for (const device of [phone, laptop]) {
			expect(device.kv.get('theme')).toBe('dark');
			expect(device.kv.get('fontSize')).toBe(22);
		}
	});
});

describe('a received update is persisted as the bytes that arrived', () => {
	test('an update whose dependencies are missing survives a RESTART', async () => {
		// Yjs buffers an update it cannot integrate, applyUpdateV2 returns
		// normally, and the document emits NO updateV2 event. Persisting emitted
		// bytes writes nothing, so the bytes are lost at restart while every
		// layer reported success. The restart is the whole test: an in-memory
		// store keeps the buffered update either way.
		const origin = await openMemory(database);
		const made = origin.tables.notes.create({
			title: 'first',
			tags: [],
			date: null,
		});
		const first = origin.store.encodeStateSince();
		const afterFirst = origin.store.stateVector();
		origin.tables.notes.update(made.id, { title: 'second' });
		const second = origin.store.encodeStateSince(afterFirst);

		// A close and a reopen over one durable record: the pending bytes were
		// stored as they arrived, so the gap is still a gap on the way back up.
		const record = createMemoryRecord();
		const laptop = await openMemory(database, record);
		expect(syncEngineOf(laptop.store).applyRemote(second).error).toBeNull();
		expect(syncEngineOf(laptop.store).hasUnresolvedDependencies()).toBe(true);
		await laptop.store[Symbol.asyncDispose]();

		const db2 = await openMemory(database, record);
		const reopened = syncEngineOf(db2.store);
		expect(reopened.hasUnresolvedDependencies()).toBe(true);

		expect(reopened.applyRemote(first).error).toBeNull();
		expect(reopened.hasUnresolvedDependencies()).toBe(false);
		expect(db2.tables.notes.get(made.id)?.title).toBe('second');
		await db2.store[Symbol.asyncDispose]();
	});

	test('a fully applied replica reports no unresolved dependencies', async () => {
		note();
		const laptop = await openMemory(database);
		syncEngineOf(laptop.store).applyRemote(
			db.store.encodeStateSince(laptop.store.stateVector()),
		);
		expect(syncEngineOf(laptop.store).hasUnresolvedDependencies()).toBe(false);
	});
});

describe('pressure is the number that decides whether any of this matters', () => {
	test('a healthy document sits near the item cost of one row', async () => {
		for (let index = 0; index < 20; index += 1)
			note({ title: `note ${index}` });
		const pressure = db.store.pressure();

		expect(pressure.liveRows).toBe(20);
		// A note here is a container and three fields, so
		// single digits. The absolute number is not the point; the ratio is.
		expect(pressure.itemsPerLiveRow).toBeLessThan(15);
	});

	test('churn drives it up, which is the whole signal', async () => {
		// Twenty live rows either way. The only difference is how many died to get
		// there, and that is exactly what the ratio has to expose, because the two
		// documents are indistinguishable from every other verb.
		for (let index = 0; index < 20; index += 1)
			note({ title: `keeper ${index}` });
		const healthy = db.store.pressure().itemsPerLiveRow;

		for (let index = 0; index < 200; index += 1) {
			const doomed = note({ title: `churn ${index}` });
			db.tables.notes.delete(doomed.id);
		}
		const churned = db.store.pressure();

		expect(churned.liveRows).toBe(20);
		expect(churned.itemsPerLiveRow).toBeGreaterThan(healthy * 3);
	});

	test('an empty document reports its items rather than dividing by zero', async () => {
		const pressure = db.store.pressure();

		expect(pressure.liveRows).toBe(0);
		expect(Number.isFinite(pressure.itemsPerLiveRow)).toBe(true);
	});
});

describe('a subscription says a table changed', () => {
	/** Every invalidation one table handed a listener, in order. */
	/**
	 * Counts notifications rather than collecting payloads.
	 *
	 * `subscribe` is a ping now, so what these tests assert is how MANY times
	 * a table said something and for which table, which is everything a
	 * subscriber can act on. Which rows moved is proved separately, and still
	 * is, by `evidence/delta-names-the-row.test.ts`.
	 */
	function record(table: { subscribe(listener: () => void): () => void }) {
		const seen: 'changed'[] = [];
		const stop = table.subscribe(() => seen.push('changed'));
		return { seen, stop };
	}

	test('registration is synchronous and never fires initially', async () => {
		// ADR-0187's law 2. A caller that subscribes and then reads has already
		// seen everything, so an initial delivery would only ever be a duplicate
		// that every consumer has to learn to ignore.
		note();
		const { seen } = record(db.tables.notes);

		expect(seen).toEqual([]);
	});

	test('a created row, an edited row and a deleted row each name themselves', async () => {
		const { seen } = record(db.tables.notes);

		const made = note();
		expect(seen).toEqual(['changed']);

		db.tables.notes.update(made.id, { title: 'Shopping' });
		expect(seen.at(-1)).toBe('changed');

		db.tables.notes.delete(made.id);
		expect(seen.at(-1)).toBe('changed');
		expect(seen).toHaveLength(3);
	});

	test("a write to another table is not this table's business", async () => {
		// The control. Without it every assertion above would still pass on an
		// implementation that invalidated every subscriber on every commit.
		const other = await openMemory(
			defineData({
				id: 'so.epicenter.honeycrisp',
				kv: {},
				tables: {
					notes: {
						scalars: {
							title: field.string(),
							tags: field.tags(),
							date: field.nullable(field.string()),
						},
					},
					folders: { scalars: { name: field.string() } },
				},
			}),
		);
		const notes = record(other.tables.notes);
		const folders = record(other.tables.folders);

		other.tables.folders.create({ name: 'Inbox' });

		expect(folders.seen).toEqual(['changed']);
		expect(notes.seen).toEqual([]);
	});

	test('one commit touching many rows is ONE call carrying every id', async () => {
		// ADR-0187's law 3. A remote update is the only thing in this surface
		// that commits more than one row at a time, so it is what proves it.
		const author = await openMemory(database);
		const ids = [0, 1, 2].map((index) => {
			const made = author.tables.notes.create({
				title: `note ${index}`,
				tags: [],
				date: null,
			});
			return made.id;
		});
		const { seen } = record(db.tables.notes);

		syncEngineOf(db.store).applyRemote(author.store.encodeStateSince());

		// One notification for the whole remote batch, however many rows it
		// carried: a subscriber re-reads, so telling it twice would only cost it
		// a second walk of the same document.
		expect(seen).toEqual(['changed']);
		expect(db.tables.notes.rows.map((row) => row.id).sort()).toEqual(
			[...ids].sort(),
		);
	});

	test("prose written into a row's type field IS a table commit", () => {
		// The collapse's cost, asserted rather than discovered (ADR-0295). A
		// nested edit bubbles through `changedParentTypes`, so a keystroke
		// reaches the table root's delta path and every table subscriber fires
		// at typing frequency. A list that re-renders off this signal is paying
		// for it; what the ADR says about that is that the signal is coarse, and
		// a field-scoped one is `content(id).subscribe`.
		const made = note();
		const { seen } = record(db.tables.notes);

		const body = db.tables.notes.get(made.id)?.editor;
		if (body === undefined) throw new Error('the row has no editor');
		body.applyDelta(body.change.insert('milk and eggs') as never);
		expect(seen).toEqual(['changed']);
	});

	test('unsubscribing stops delivery, and doing it twice is harmless', async () => {
		const { seen, stop } = record(db.tables.notes);
		note();
		expect(seen).toHaveLength(1);

		stop();
		stop();
		note();

		expect(seen).toHaveLength(1);
	});

	test('one subscriber leaving does not silence the others', async () => {
		// The reason the teardown is idempotent and counted. A Svelte effect can
		// run its own teardown more than once, and a second decrement would
		// detach the delta listener out from under the subscribers still holding
		// one, which reads as a UI that simply stops updating.
		const first = record(db.tables.notes);
		const second = record(db.tables.notes);

		first.stop();
		first.stop();
		note();

		expect(first.seen).toHaveLength(0);
		expect(second.seen).toHaveLength(1);
	});

	test('a subscriber that throws does not cost the next one its invalidation', async () => {
		db.tables.notes.subscribe(() => {
			throw new Error('this subscriber is broken');
		});
		const { seen } = record(db.tables.notes);

		note();

		expect(seen).toEqual(['changed']);
	});

	test('a subscriber may write, and its own write is a separate notification', async () => {
		const { seen } = record(db.tables.notes);
		let wrote = false;
		let written: string | undefined;
		db.tables.notes.subscribe(() => {
			if (wrote) return;
			wrote = true;
			// A subscriber re-reads to find out what moved, which is the whole
			// contract now, and writing from inside its own notification is the
			// case the swap-before-deliver buffer exists for.
			written = db.tables.notes.rows.at(0)?.id;
			if (written !== undefined) {
				db.tables.notes.update(written, { title: 'renamed' });
			}
		});

		const made = note();

		expect(written).toBe(made.id);
		expect(db.tables.notes.get(made.id)?.title).toBe('renamed');
		expect(seen).toEqual(['changed', 'changed']);
	});
});

describe('kv reports its own changes', () => {
	test('a local update notifies, and the listener reads the new value', async () => {
		const seen: unknown[] = [];
		db.kv.subscribe(() => seen.push(db.kv.get('theme')));

		db.kv.update({ theme: 'dark' });

		expect(seen).toEqual(['dark']);
	});

	test('a change that arrived from a peer notifies too', async () => {
		// The case a settings screen exists for: another device changed a
		// preference and this one has to stop showing the old value.
		const author = await openMemory(database);
		author.kv.update({ fontSize: 22 });
		const seen: unknown[] = [];
		db.kv.subscribe(() => seen.push(db.kv.get('fontSize')));

		syncEngineOf(db.store).applyRemote(author.store.encodeStateSince());

		expect(seen).toEqual([22]);
	});

	test('CONTROL: a table write does not notify kv', async () => {
		// Without this, an implementation that notified every subscriber on
		// every commit would satisfy both tests above.
		const seen: unknown[] = [];
		db.kv.subscribe(() => seen.push('kv'));

		note();

		expect(seen).toEqual([]);
	});

	test('registration never fires initially, and unsubscribing is idempotent', async () => {
		const seen: unknown[] = [];
		const stop = db.kv.subscribe(() => seen.push('kv'));
		expect(seen).toEqual([]);

		db.kv.update({ theme: 'dark' });
		expect(seen).toHaveLength(1);

		stop();
		stop();
		db.kv.update({ theme: 'light' });

		expect(seen).toHaveLength(1);
	});
});

describe('kv survives a declaration upgrade (ADR-0240)', () => {
	test('a stored write outlives the runtime that wrote it', async () => {
		// The upgrade is a close and a reopen (ADR-0240): the same durable
		// record, a newer declaration, one runtime at a time.
		const record = createMemoryRecord();
		const first = await openMemory(database, record);
		first.kv.update({ theme: 'dark' });
		first.kv.update({ future: 'kept' } as never);
		await first.store[Symbol.asyncDispose]();

		const second = await openMemory(
			defineData({
				id: 'so.epicenter.honeycrisp',
				kv: {
					theme: field.select(['light', 'dark']),
					added: field.string(),
					future: field.string(),
				},
				tables: {
					notes: {
						scalars: {
							title: field.string(),
							tags: field.tags(),
							date: field.nullable(field.string()),
						},
					},
				},
			}),
			record,
		);
		// The stored write survives the upgrade. The newly declared field remains
		// missing, so recovery belongs to the application that opened the data.
		expect(second.kv.get('theme')).toBe('dark');
		expect(second.kv.get('future' as never) as unknown).toBe('kept');
		expect(second.kv.get('added' as never) as unknown).toBeUndefined();
		expect(second.kv.nonconforming.map(({ field }) => field)).toEqual([
			'added',
		]);
		await second.store[Symbol.asyncDispose]();
	});
});

describe('an undeclared table waits in the CRDT (ADR-0240)', () => {
	const withScratch = defineData({
		id: 'so.epicenter.honeycrisp',
		kv: { theme: field.select(['light', 'dark']) },
		tables: {
			notes: { scalars: { title: field.string() } },
			scratch: { scalars: { body: field.string() } },
		},
	});
	const withoutScratch = defineData({
		id: 'so.epicenter.honeycrisp',
		kv: {},
		tables: { notes: { scalars: { title: field.string() } } },
	});

	test('the next runtime has no handle; one that re-declares it reads every row back', async () => {
		const record = createMemoryRecord();
		const first = await openMemory(withScratch, record);
		const made = first.tables.scratch.create({ body: 'kept in the CRDT' });
		first.kv.update({ theme: 'dark' });
		await first.store[Symbol.asyncDispose]();

		// The device updates (ADR-0240): the same durable record, the next
		// runtime, a declaration that no longer names `scratch` or `kv`.
		const second = await openMemory(withoutScratch, record);
		expect((second.tables as Record<string, unknown>).scratch).toBeUndefined();
		await second.store[Symbol.asyncDispose]();

		// A later release declares them again: nothing was lost, because the
		// CRDT is the truth and never dropped a byte.
		const third = await openMemory(withScratch, record);
		expect(third.tables.scratch.rows).toEqual([
			{ id: made.id, body: 'kept in the CRDT' },
		]);
		expect(third.kv.get('theme')).toBe('dark');
		await third.store[Symbol.asyncDispose]();
	});

	test('stored() sees the table and the kv key the declaration dropped', async () => {
		const record = createMemoryRecord();
		const first = await openMemory(withScratch, record);
		const made = first.tables.scratch.create({ body: 'kept in the CRDT' });
		first.kv.update({ theme: 'dark' });
		await first.store[Symbol.asyncDispose]();

		const second = await openMemory(withoutScratch, record);
		// The lens cannot reach them: there is no handle for `scratch`, and this
		// declaration names no kv keys at all.
		expect((second.tables as Record<string, unknown>).scratch).toBeUndefined();

		// The artifact read does, because it enumerates the roots the document
		// holds rather than the tables the declaration names.
		const state = second.stored();
		expect([...state.tables.keys()]).toEqual(['notes', 'scratch']);
		expect(state.tables.get('scratch')?.get(made.id)).toEqual({
			body: 'kept in the CRDT',
		});
		expect(state.kv).toEqual({ theme: 'dark' });
		await second.store[Symbol.asyncDispose]();
	});
});

describe('stored() is the faithful read (ADR-0267)', () => {
	const withPreview = defineData({
		id: 'so.epicenter.honeycrisp',
		kv: {},
		tables: {
			notes: { scalars: { title: field.string(), preview: field.string() } },
		},
	});
	const withoutPreview = defineData({
		id: 'so.epicenter.honeycrisp',
		kv: {},
		tables: { notes: { scalars: { title: field.string() } } },
	});

	test('a field the declaration dropped survives here and nowhere else', async () => {
		const record = createMemoryRecord();
		const before = await openMemory(withPreview, record);
		const made = before.tables.notes.create({
			title: 'Groceries',
			preview: 'milk, eggs',
		});
		await before.store[Symbol.asyncDispose]();

		// The release stops declaring `preview`. The row still CONFORMS, because
		// every field this declaration names reads fine, so it is not reported as
		// nonconforming either. Through the lens the stored value is unreachable
		// from both arms, which is exactly the data loss an export must not copy.
		const after = await openMemory(withoutPreview, record);
		const listed = after.tables.notes;
		expect(listed.nonconforming).toEqual([]);
		expect(listed.rows).toEqual([{ id: made.id, title: 'Groceries' }]);

		expect(after.stored().tables.get('notes')?.get(made.id)).toEqual({
			title: 'Groceries',
			preview: 'milk, eggs',
		});
		await after.store[Symbol.asyncDispose]();
	});

	test('a deleted row is absent rather than empty', async () => {
		const made = note();
		db.tables.notes.delete(made.id);
		expect(db.stored().tables.get('notes')?.has(made.id)).toBe(false);
	});
});

describe('foreign bytes have exactly one door', () => {
	// The store's updateV2 listener treats any unrecognized origin as an
	// application writing through a live type, which is only correct for a
	// LOCAL transaction. An application holds a type field and a type field
	// exposes `.doc`, so the branch is guarded by `transaction.local` rather
	// than by convention: `applyUpdateV2` forces it to false and a local
	// `transact` defaults it to true. This test also pins `transaction.local`
	// itself: if an rc removed the field, every application write into a type
	// field would take the throw and the suite fails loudly.
	test('a direct Y.applyUpdateV2 on the live document throws instead of forging authored work', () => {
		const made = note({ title: 'mine' });
		const live = db.tables.notes.get(made.id)?.editor.doc;
		if (live === null || live === undefined) {
			throw new Error('the type field is not attached to a document');
		}

		const stranger = new Y.Doc({ gc: true });
		const text = stranger.get('editor', 'text' as never);
		stranger.transact(() =>
			text.applyDelta(text.change.insert('theirs') as never),
		);
		const foreign = new Uint8Array(Y.encodeStateAsUpdateV2(stranger));
		stranger.destroy();

		expect(() =>
			Y.applyUpdateV2(live, foreign as Uint8Array<ArrayBuffer>),
		).toThrow('applyRemote');

		// The throw fired before anything persisted, so the store is not
		// poisoned: local work still commits.
		const after = db.tables.notes.create({
			title: 'still works',
			tags: [],
			date: null,
		});
		expect(after.id).toHaveLength(24);
	});
});

describe('a document store owes nobody (ADR-0233)', () => {
	test('local commits leave the outbox empty and no replica verb exists', async () => {
		const { sqlite } = createMemoryRecord();
		const local = createLocalStore({ definition: database, sqlite });
		const store = local.store;
		try {
			const made = local.tables.notes.create({
				title: 'device work',
				tags: [],
				date: null,
			});
			expect(made.id).toHaveLength(24);

			// The write is durable, but it is owed to nobody. The rows carry no
			// authority position, because no authority will ever give them one,
			// and the port answers with an empty outbox rather than offering
			// them: a store that does not sync has no sender to offer them to.
			expect(
				createSqliteDurablePort({ sqlite, syncs: false }).load().outbox,
			).toEqual([]);
			expect(
				sqlite.all<{ count: number }>(
					'SELECT COUNT(*) AS count FROM _updates',
				)[0]?.count,
			).toBeGreaterThan(0);

			// Both kinds carry `sync`; the VALUE is the discriminant, so a
			// device store answers `undefined` rather than omitting the key.
			expect('sync' in store).toBe(true);
			expect(store.sync).toBeUndefined();
			// And the delivery machinery is unreachable: nothing was registered.
			// @ts-expect-error a device store has no sync engine
			expect(() => syncEngineOf(store)).toThrow('not a replica');
		} finally {
			await local.store[Symbol.asyncDispose]();
		}
	});

	test('the sync VALUE discriminates the two kinds, at the type level too', async () => {
		// Compile-time pins: `sync !== undefined` must narrow the union in both
		// directions without an `in`-probe or a cast. The annotations are the
		// assertions; a shape change fails typecheck before it fails a test.
		function kindOf(store: LocalStore | AccountStore): 'local' | 'account' {
			if (store.sync !== undefined) {
				const capability: SyncCapability = store.sync;
				void capability;
				const account: AccountStore = store;
				void account;
				return 'account';
			}
			const device: LocalStore = store;
			void device;
			return 'local';
		}

		const local = createLocalStore({
			definition: database,
			sqlite: createMemoryRecord().sqlite,
		});
		const account = await openMemory(database);
		try {
			expect(kindOf(local.store)).toBe('local');
			expect(kindOf(account.store)).toBe('account');
		} finally {
			await local.store[Symbol.asyncDispose]();
			await account.store[Symbol.asyncDispose]();
		}
	});
});

describe('an unusable store throws, and never dresses up as a read outcome', () => {
	test('using a disposed store throws StoreUnusableError', async () => {
		const app = await openMemory(database);
		await app.store[Symbol.asyncDispose]();
		expect(() => app.tables.notes.rows).toThrow(StoreUnusableError);
		expect(() => app.kv.get('theme')).toThrow(StoreUnusableError);
		expect(() => app.tables.notes.get('anything')).toThrow(StoreUnusableError);
	});

	test('a refused durable flush leaves the store live and reports blocked', async () => {
		// The withdrawn poison (ADR-0238): storage failing is a visible debt,
		// never the store's death. The live document is the truth while open.
		const raw = new Database(':memory:');
		const sqlite = createBunSqliteAdapter(raw);
		const bound = createAccountStore({
			definition: database,
			sqlite,
			// The refused flush is the subject here, not noise worth printing.
			log: {
				error: () => undefined,
				warn: () => undefined,
				info: () => undefined,
				debug: () => undefined,
				trace: () => undefined,
			},
		});
		const store = bound.store;
		// Pull durable storage out from under a live document.
		raw.close();

		const made = bound.tables.notes.create({
			title: 'still accepted',
			tags: [],
			date: null,
		});
		expect(made.id).toHaveLength(24);
		// Reads follow the accepted edit immediately.
		expect(bound.tables.notes.rows.map((row) => row.title)).toEqual([
			'still accepted',
		]);
		// The debt is visible: a restart would lose this edit, and the status
		// says so instead of an exception pretending the data is gone now.
		expect(store.persistence.get()).toBe('blocked');
	});
});

describe('a type field carries its own change signal (ADR-0297)', () => {
	test('an edit to the field reaches its subscriber', () => {
		const made = note();
		const editor = db.tables.notes.get(made.id)?.editor;
		if (editor === undefined) throw new Error('the row has no content');
		let fired = 0;
		db.tables.notes.watch(made.id, 'editor', () => {
			fired += 1;
		});
		editor.applyDelta(editor.change.insert('milk') as never);
		expect(fired).toBe(1);
	});

	test('a scalar write on the same row does not fire it', () => {
		// Why the signal is scoped to the FIELD rather than to the row. An
		// application hangs its own `updatedAt` write on this, and a row-scoped
		// signal would fire on the write it caused, so every application would
		// have to break its own loop.
		const made = note();
		let fired = 0;
		db.tables.notes.watch(made.id, 'editor', () => {
			fired += 1;
		});
		db.tables.notes.update(made.id, { title: 'Groceries and milk' });
		expect(fired).toBe(0);
	});

	test('unsubscribing stops delivery, and doing it twice is harmless', () => {
		const made = note();
		const editor = db.tables.notes.get(made.id)?.editor;
		if (editor === undefined) throw new Error('the row has no content');
		let fired = 0;
		const stop = db.tables.notes.watch(made.id, 'editor', () => {
			fired += 1;
		});
		stop();
		stop();
		editor.applyDelta(editor.change.insert('milk') as never);
		expect(fired).toBe(0);
	});

	test('it fires once per commit, after the table subscriber', () => {
		// The order is the contract an application's own derived write depends
		// on: by the time this runs, every coarser reader has already seen the
		// commit that caused it, so a write made here is one commit later rather
		// than a re-entry into the one being accepted.
		const made = note();
		const editor = db.tables.notes.get(made.id)?.editor;
		if (editor === undefined) throw new Error('the row has no content');
		const order: string[] = [];
		db.store.onCommitted(() => order.push('committed'));
		db.tables.notes.subscribe(() => order.push('table'));
		db.tables.notes.watch(made.id, 'editor', () => order.push('field'));

		db.transact(() => {
			editor.applyDelta(editor.change.insert('a') as never);
			editor.applyDelta(editor.change.insert('b') as never);
		});
		expect(order).toEqual(['committed', 'table', 'field']);
	});

	test('a remote edit to the field reaches it too', async () => {
		const made = note();
		const laptop = await openMemory(database);
		syncEngineOf(laptop.store).applyRemote(db.store.encodeStateSince());

		const here = db.tables.notes.get(made.id);
		if (here === undefined) throw new Error('the row has no content');
		let fired = 0;
		db.tables.notes.watch(made.id, 'editor', () => {
			fired += 1;
		});

		const there = laptop.tables.notes.get(made.id);
		there?.editor.applyDelta(
			there.editor.change.insert('typed elsewhere') as never,
		);
		syncEngineOf(db.store).applyRemote(laptop.store.encodeStateSince());

		expect(fired).toBeGreaterThan(0);
		expect(here.editor.toString()).toContain('typed elsewhere');
	});
});

describe('the store manages no timestamps (ADR-0297)', () => {
	test('a declared instant field is an ordinary field nobody stamps', async () => {
		// `field.instant()` is a type, not a contract. The platform stops
		// holding an opinion about time: a table that wants recency declares
		// the field and writes it, and what it stores is exactly that.
		const timed = defineData({
			id: 'so.epicenter.honeycrisp',
			kv: {},
			tables: {
				notes: {
					scalars: {
						title: field.string(),
						updatedAt: field.instant(),
					},
				},
			},
		});
		const data = await openMemory(timed);
		const written = InstantString.fromDate(new Date(0));
		const made = data.tables.notes.create({
			title: 'Groceries',
			updatedAt: written,
		});
		expect(made.updatedAt).toBe(written);
		data.tables.notes.update(made.id, { title: 'Groceries and milk' });
		expect(data.tables.notes.get(made.id)?.updatedAt).toBe(written);
	});

	test('a table declaring no timestamp stores none', async () => {
		const plain = defineData({
			id: 'so.epicenter.honeycrisp',
			kv: {},
			tables: { notes: { scalars: { title: field.string() } } },
		});
		const data = await openMemory(plain);
		const made = data.tables.notes.create({ title: 'Groceries' });
		expect(Object.keys(made).sort()).toEqual(['id', 'title']);
	});
});
