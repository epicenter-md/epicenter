import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import type { TableInvalidation } from '@epicenter/data/definition';
import { defineData, field, InstantString } from '@epicenter/data/definition';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { expectOk } from 'wellcrafted/testing';
import * as Y from '@y/y';
import { encodeEnvelope } from './envelope.js';
import { APP_DOCUMENT } from './log.js';
import { createMemoryRecord, openMemory } from './memory.js';
import {
	type AccountStore,
	createAccountStore,
	createDeviceStore,
	type DataOf,
	type DeviceStore,
	StoreUnusableError,
	type SyncCapability,
	syncEngineOf,
} from './store.js';

const database = defineData({
	id: 'so.epicenter.honeycrisp',
	kv: { theme: field.select(['light', 'dark']), fontSize: field.number() },
	tables: {
		notes: {
			fields: {
				title: field.string(),
				tags: field.tags(),
				date: field.nullable(field.string()),
			},
		},
	},
});

let db: DataOf<typeof database>;

beforeEach(() => {
	db = openMemory(database);
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
function asEnvelope(bytes: Uint8Array): Uint8Array {
	return encodeEnvelope([{ document: APP_DOCUMENT, bytes }]);
}

function exchange(a: AccountStore, b: AccountStore) {
	const fromA = a.encodeStateSince(b.stateVector());
	const fromB = b.encodeStateSince(a.stateVector());
	syncEngineOf(b).applyRemote(asEnvelope(fromA));
	syncEngineOf(a).applyRemote(asEnvelope(fromB));
}

describe('a read is a property access on a plain object', () => {
	test('data carries its immutable definition and owns the store lifecycle', async () => {
		const opened = openMemory(database);
		await using data = opened;

		expect(data.definition).toEqual(database);
		expect(data.definition).not.toBe(database);
		expect(Object.isFrozen(data.definition)).toBe(true);
		expect(Object.isFrozen(data.definition.kv)).toBe(true);
		expect(Object.isFrozen(data.definition.tables)).toBe(true);
		expect(data.store).not.toBe(data);
	});

	test('create returns the row it made, at a minted id', () => {
		const made = note();
		expect(made.id).toBeString();
		expect(made.id).toHaveLength(24);
		expect(made.title).toBe('Groceries');
		expect(made.tags).toEqual(['food']);
	});

	test('an absent row reads as Ok(undefined), which is a fact not a failure', () => {
		const { data, error } = db.tables.notes.get('nope');
		expect(error).toBeNull();
		expect(data).toBeUndefined();
	});

	test('every scalar verb is synchronous; only a document open is a load', () => {
		// One in-memory application document over a synchronous SQLite boundary,
		// so no scalar read or write has I/O to await. The one asynchronous verb
		// is `openDocument`, which is a load by decision (ADR-0248).
		const made = note();
		for (const value of [
			db.tables.notes.get(made.id),
			db.tables.notes.update(made.id, { title: 'x' }),
			db.tables.notes.list(),
			db.tables.notes.ids(),
			db.kv.get(),
			db.kv.update({ theme: 'dark' }),
			db.tables.notes.delete(made.id),
		]) {
			expect(value).not.toBeInstanceOf(Promise);
		}
	});

	test('data groups direct operations with transact', () => {
		expect(Object.hasOwn(db, 'documents')).toBe(false);
		expect(Object.hasOwn(db.store, 'documents')).toBe(false);
		const touched: string[][] = [];
		db.tables.notes.subscribe((invalidation) => {
			if (invalidation.scope === 'rows') touched.push([...invalidation.rowIds]);
		});

		db.transact(() => {
			note({ title: 'one' });
			note({ title: 'two' });
		});

		expect(touched).toHaveLength(1);
		expect(touched[0]).toHaveLength(2);
	});
});

describe('a write that reaches nothing is a failure', () => {
	test('update on an absent row refuses instead of swallowing it', () => {
		const { data, error } = db.tables.notes.update('nope', { title: 'x' });
		expect(data).toBeNull();
		// The verb this replaces returned Ok(undefined) and dropped the write.
		expect(error?.name).toBe('RowAbsent');
	});

	test('create admits a payload and get reports its conformance', () => {
		const made = db.tables.notes.create({} as never);
		expect(made.id).toHaveLength(24);
		const read = db.tables.notes.get(made.id);
		expect(read.data).toBeNull();
		expect(read.error?.issues.map((issue) => issue.field)).toEqual([
			'title',
			'tags',
			'date',
		]);
	});

	test('an invalid supplied value is written and reported on read', () => {
		const made = note();
		const result = db.tables.notes.update(made.id, {
			tags: 'food' as never,
		});
		expect(result.error).toBeNull();
		const after = db.tables.notes.get(made.id);
		expect(after.data).toBeNull();
		expect(after.error?.conforming.title).toBe('Groceries');
		expect(after.error?.issues.map((issue) => issue.field)).toEqual(['tags']);
	});

	test('reserved row attributes remain a structural boundary', () => {
		const made = note();
		expect(() =>
			db.tables.notes.update(made.id, { '!presence': 'absent' } as never),
		).toThrow(/reserved/);
		expect(db.tables.notes.get(made.id).data?.title).toBe('Groceries');
	});
});

describe('deletion', () => {
	test('a deleted row reads as absent', () => {
		const made = note();
		db.tables.notes.delete(made.id);
		expect(db.tables.notes.get(made.id).data).toBeUndefined();
		expect(db.tables.notes.ids()).toEqual([]);
	});

	test('deleting twice leaves the table exactly as the first delete did', () => {
		const made = note();
		db.tables.notes.delete(made.id);
		// Deleting an absent address reports nothing and changes nothing: the
		// verb has no outcome to report, so the second call is indistinguishable
		// from never having made it.
		db.tables.notes.delete(made.id);
		expect(db.tables.notes.get(made.id).data).toBeUndefined();
		expect(db.tables.notes.ids()).toEqual([]);
	});

	test('CHURN DOES NOT ACCUMULATE A CORPSE PER DELETED ROW', () => {
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

	test('a deleted address cannot be revived, only refused', () => {
		// Deletion takes the row's attribute off the table root, so a deleted id
		// is indistinguishable from one nothing ever held. There is no reuse path
		// to get wrong: `update` refuses, and `create` mints an id of its own.
		const made = note();
		db.tables.notes.delete(made.id);
		const { data, error } = db.tables.notes.update(made.id, { title: 'back?' });
		expect(data).toBeNull();
		expect(error?.name).toBe('RowAbsent');
		expect(db.tables.notes.get(made.id).data).toBeUndefined();
	});
});

describe('a nonconforming row is reported, never repaired', () => {
	const wrongDatabase = defineData({
		id: 'so.epicenter.honeycrisp',
		kv: {},
		tables: {
			notes: {
				fields: {
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
	function corruptTags(rowId: string): void {
		const peer = openMemory(wrongDatabase);
		exchange(db.store, peer.store);
		const written = peer.tables.notes.update(rowId, { tags: 'food' });
		if (written.error !== null) throw written.error;
		exchange(db.store, peer.store);
	}

	test('the call site composes application recovery and what survived', () => {
		const made = note();
		corruptTags(made.id);

		const { data, error } = db.tables.notes.get(made.id);
		expect(data).toBeNull();
		// Plain diagnostic data, not a tagged error: the read's only error IS
		// nonconformance, so there is nothing to discriminate it from.
		expect(error?.id).toBe(made.id);
		expect(error?.issues.map((issue) => issue.field)).toEqual(['tags']);
		// Never repaired and never hidden: the raw payload survives intact.
		expect(error?.raw).toEqual({
			title: 'Groceries',
			tags: 'food',
			date: null,
		});

		const recovered = data ?? {
			id: made.id,
			...error?.conforming,
		};
		expect(recovered).toEqual({ id: made.id, title: 'Groceries', date: null });
	});

	test('list separates what it can read from what it cannot', () => {
		const broken = note({ title: 'broken' });
		const fine = note({ title: 'fine' });
		corruptTags(broken.id);
		const listed = db.tables.notes.list();
		expect(listed.rows.map((row) => row.id)).toEqual([fine.id]);
		expect(listed.nonconforming.map((issue) => issue.id)).toEqual([broken.id]);
	});
});

describe('two replicas converge', () => {
	function pair() {
		return { laptop: openMemory(database) };
	}

	test('a row made on one device appears on the other', () => {
		const { laptop } = pair();
		const made = note({ title: 'Recorded on the phone', tags: ['voice'] });
		exchange(db.store, laptop.store);

		expect(laptop.tables.notes.get(made.id).data?.title).toBe(
			'Recorded on the phone',
		);
	});

	test('offline edits to different fields of one row both survive', () => {
		const { laptop } = pair();
		const made = note({ title: 'first' });
		exchange(db.store, laptop.store);

		db.tables.notes.update(made.id, { title: 'phone title' });
		laptop.tables.notes.update(made.id, { date: '2026-08-07' });
		exchange(db.store, laptop.store);

		for (const [name, handle] of [
			['phone', db.tables.notes],
			['laptop', laptop.tables.notes],
		] as const) {
			const settled = handle.get(made.id).data;
			expect(`${name}:${settled?.title}`).toBe(`${name}:phone title`);
			expect(`${name}:${settled?.date}`).toBe(`${name}:2026-08-07`);
		}
	});

	test('a delete on one device beats an edit on the other', () => {
		// The case ADR-0212 kept a corpse per deleted row to serve. It converges
		// without one, and to the same answer: the row is gone on both devices,
		// and the offline edit is gone with it rather than lingering as a field on
		// a tombstone that a revived address would hand back
		// (`evidence/deletion-model.test.ts`).
		const { laptop } = pair();
		const made = note({ title: 'first' });
		exchange(db.store, laptop.store);

		db.tables.notes.delete(made.id);
		laptop.tables.notes.update(made.id, { title: 'edited offline' });
		exchange(db.store, laptop.store);

		expect(db.tables.notes.get(made.id).data).toBeUndefined();
		expect(laptop.tables.notes.get(made.id).data).toBeUndefined();
		expect(laptop.tables.notes.ids()).toEqual([]);
	});

	test('two devices creating rows concurrently keep both', () => {
		// Safe by construction rather than by care: a minted 24-character id
		// cannot collide, so two devices never mint a container at one address.
		const { laptop } = pair();
		note({ title: 'from the phone' });
		laptop.tables.notes.create({
			title: 'from the laptop',
			tags: [],
			date: null,
		});
		exchange(db.store, laptop.store);

		expect(db.tables.notes.list().rows).toHaveLength(2);
		expect(laptop.tables.notes.list().rows).toHaveLength(2);
	});
});

describe('the document a row inherently owns (ADR-0248)', () => {
	test('an absent row has no document, which is a fact not a failure', async () => {
		// The same answer `get` gives an absent row, rather than an Err for one
		// and an Ok(undefined) for the other.
		const { data, error } = await db.tables.notes.openDocument('nope');
		expect(error).toBeNull();
		expect(data).toBeUndefined();
	});

	test('deleting the row retires its document', async () => {
		const made = note();
		const opened = await db.tables.notes.openDocument(made.id);
		opened.data?.get('editor', 'text');
		opened.data?.[Symbol.dispose]();
		db.tables.notes.delete(made.id);
		const after = await db.tables.notes.openDocument(made.id);
		expect(after.error).toBeNull();
		expect(after.data).toBeUndefined();
	});

	test('an editor writing into its own document cannot touch the row', async () => {
		// Why the split exists at all. Bound to the row itself, a ProseMirror
		// schema whose doc node declares attributes overwrites the row's fields
		// and syncs that; measured in ADR-0215, and structurally unreachable now
		// that the row and its rich content are two documents.
		const made = note();
		const opened = await db.tables.notes.openDocument(made.id);
		opened.data
			?.get('editor', 'text')
			.setAttr('title' as never, 'CLOBBER' as never);
		expect(db.tables.notes.get(made.id).data?.title).toBe('Groceries');
		opened.data?.[Symbol.dispose]();
	});
});

describe('kv is where anything two devices both write belongs', () => {
	test('an unwritten key is nonconforming rather than defaulted', () => {
		const { data, error } = db.kv.get();
		expect(data).toBeNull();
		expect(error?.conforming).toEqual({});
		expect(error?.issues.map(({ field }) => field)).toEqual([
			'theme',
			'fontSize',
		]);
	});

	test('a write touches only the keys it names', () => {
		db.kv.update({ theme: 'dark' });
		const read = db.kv.get();
		expect(read.data).toBeNull();
		expect(read.error?.conforming).toEqual({ theme: 'dark' });
	});

	test('an undeclared key is preserved for a future declaration', () => {
		db.kv.update({ nope: 1 } as never);
		const read = db.kv.get();
		expect(read.data).toBeNull();
		expect(read.error?.raw).toEqual({ nope: 1 });
		expect(read.error?.conforming).toEqual({});
	});

	test('an invalid value is written and reported on read', () => {
		db.kv.update({ fontSize: 20 });
		db.kv.update({ theme: 'purple' as never });
		const read = db.kv.get();
		expect(read.data).toBeNull();
		expect(read.error?.conforming).toEqual({ fontSize: 20 });
		expect(read.error?.raw).toEqual({ theme: 'purple', fontSize: 20 });
	});

	test('TWO DEVICES BOOTING OFFLINE BOTH KEEP THEIR SETTINGS', () => {
		// The case that motivated moving KV to a reserved root. Through a chosen
		// row id this loses one device's write entirely, because each mints its
		// own nested container and map LWW keeps one. A root is addressed by its
		// name, so both survive. `evidence/bench/row-model.ts` keeps the losing
		// contrast, now that the chosen-id door is gone from the API.
		const phone = openMemory(database);
		const laptop = openMemory(database);

		phone.kv.update({ theme: 'dark' });
		laptop.kv.update({ fontSize: 22 });
		exchange(phone.store, laptop.store);

		const expected = { theme: 'dark', fontSize: 22 } as const;
		expect(phone.kv.get().data).toEqual(expected);
		expect(laptop.kv.get().data).toEqual(expected);
	});
});

describe('a received update is persisted as the bytes that arrived', () => {
	test('an update whose dependencies are missing survives a RESTART', async () => {
		// Yjs buffers an update it cannot integrate, applyUpdateV2 returns
		// normally, and the document emits NO updateV2 event. Persisting emitted
		// bytes writes nothing, so the bytes are lost at restart while every
		// layer reported success. The restart is the whole test: an in-memory
		// store keeps the buffered update either way.
		const origin = openMemory(database);
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
		const laptop = openMemory(database, record);
		expect(
			syncEngineOf(laptop.store).applyRemote(asEnvelope(second)).error,
		).toBeNull();
		expect(syncEngineOf(laptop.store).hasUnresolvedDependencies()).toBe(true);
		await laptop.store[Symbol.asyncDispose]();

		const db2 = openMemory(database, record);
		const reopened = syncEngineOf(db2.store);
		expect(reopened.hasUnresolvedDependencies()).toBe(true);

		expect(reopened.applyRemote(asEnvelope(first)).error).toBeNull();
		expect(reopened.hasUnresolvedDependencies()).toBe(false);
		expect(db2.tables.notes.get(made.id).data?.title).toBe('second');
		await db2.store[Symbol.asyncDispose]();
	});

	test('a fully applied replica reports no unresolved dependencies', () => {
		note();
		const laptop = openMemory(database);
		syncEngineOf(laptop.store).applyRemote(
			asEnvelope(db.store.encodeStateSince(laptop.store.stateVector())),
		);
		expect(syncEngineOf(laptop.store).hasUnresolvedDependencies()).toBe(false);
	});
});

describe('pressure is the number that decides whether any of this matters', () => {
	test('a healthy document sits near the item cost of one row', () => {
		for (let index = 0; index < 20; index += 1)
			note({ title: `note ${index}` });
		const pressure = db.store.pressure();

		expect(pressure.liveRows).toBe(20);
		// A note here is a container and three fields, so
		// single digits. The absolute number is not the point; the ratio is.
		expect(pressure.itemsPerLiveRow).toBeLessThan(15);
	});

	test('churn drives it up, which is the whole signal', () => {
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

	test('an empty document reports its items rather than dividing by zero', () => {
		const pressure = db.store.pressure();

		expect(pressure.liveRows).toBe(0);
		expect(Number.isFinite(pressure.itemsPerLiveRow)).toBe(true);
	});
});

describe('a subscription names the rows a commit touched', () => {
	/** Every invalidation one table handed a listener, in order. */
	function record(table: {
		subscribe(listener: (i: TableInvalidation) => void): () => void;
	}) {
		const seen: TableInvalidation[] = [];
		const stop = table.subscribe((invalidation) => seen.push(invalidation));
		return { seen, stop };
	}

	test('registration is synchronous and never fires initially', () => {
		// ADR-0187's law 2. A caller that subscribes and then reads has already
		// seen everything, so an initial delivery would only ever be a duplicate
		// that every consumer has to learn to ignore.
		note();
		const { seen } = record(db.tables.notes);

		expect(seen).toEqual([]);
	});

	test('a created row, an edited row and a deleted row each name themselves', () => {
		const { seen } = record(db.tables.notes);

		const made = note();
		expect(seen).toEqual([{ scope: 'rows', rowIds: [made.id] }]);

		db.tables.notes.update(made.id, { title: 'Shopping' });
		expect(seen.at(-1)).toEqual({ scope: 'rows', rowIds: [made.id] });

		db.tables.notes.delete(made.id);
		expect(seen.at(-1)).toEqual({ scope: 'rows', rowIds: [made.id] });
		expect(seen).toHaveLength(3);
	});

	test("a write to another table is not this table's business", () => {
		// The control. Without it every assertion above would still pass on an
		// implementation that invalidated every subscriber on every commit.
		const other = openMemory(
			defineData({
				id: 'so.epicenter.honeycrisp',
				kv: {},
				tables: {
					notes: {
						fields: {
							title: field.string(),
							tags: field.tags(),
							date: field.nullable(field.string()),
						},
					},
					folders: { fields: { name: field.string() } },
				},
			}),
		);
		const notes = record(other.tables.notes);
		const folders = record(other.tables.folders);

		const made = other.tables.folders.create({ name: 'Inbox' });

		expect(folders.seen).toEqual([{ scope: 'rows', rowIds: [made.id] }]);
		expect(notes.seen).toEqual([]);
	});

	test('one commit touching many rows is ONE call carrying every id', () => {
		// ADR-0187's law 3. A remote update is the only thing in this surface
		// that commits more than one row at a time, so it is what proves it.
		const author = openMemory(database);
		const ids = [0, 1, 2].map((index) => {
			const made = author.tables.notes.create({
				title: `note ${index}`,
				tags: [],
				date: null,
			});
			return made.id;
		});
		const { seen } = record(db.tables.notes);

		syncEngineOf(db.store).applyRemote(
			asEnvelope(author.store.encodeStateSince()),
		);

		expect(seen).toHaveLength(1);
		const only = seen[0];
		if (only?.scope !== 'rows') throw new Error('expected row scope');
		expect([...only.rowIds].sort()).toEqual([...ids].sort());
	});

	test("prose written inside a row's document is not a table commit", async () => {
		// The split's contract (ADR-0248): a row's rich document is its own
		// document, so an editor keystroke never touches the table root and
		// never invalidates the table. What a list renders from a document is
		// a preview, and a preview is an ordinary scalar field the application
		// writes itself, which is the invalidation the list actually needs.
		const made = note();
		const { seen } = record(db.tables.notes);

		const opened = await db.tables.notes.openDocument(made.id);
		const body = opened.data?.get('body', 'text');
		if (body === undefined) throw new Error('the row has no document');
		body.applyDelta(body.change.insert('milk and eggs') as never);
		expect(seen).toEqual([]);

		db.tables.notes.update(made.id, { title: 'Groceries, previewed' });
		expect(seen).toEqual([{ scope: 'rows', rowIds: [made.id] }]);
		opened.data?.[Symbol.dispose]();
	});

	test('unsubscribing stops delivery, and doing it twice is harmless', () => {
		const { seen, stop } = record(db.tables.notes);
		note();
		expect(seen).toHaveLength(1);

		stop();
		stop();
		note();

		expect(seen).toHaveLength(1);
	});

	test('one subscriber leaving does not silence the others', () => {
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

	test('a subscriber that throws does not cost the next one its invalidation', () => {
		db.tables.notes.subscribe(() => {
			throw new Error('this subscriber is broken');
		});
		const { seen } = record(db.tables.notes);

		const made = note();

		expect(seen).toEqual([{ scope: 'rows', rowIds: [made.id] }]);
	});

	test('a subscriber may write, and its own write is a separate invalidation', () => {
		const { seen } = record(db.tables.notes);
		let wrote = false;
		db.tables.notes.subscribe((invalidation) => {
			if (wrote || invalidation.scope !== 'rows') return;
			wrote = true;
			db.tables.notes.update(invalidation.rowIds[0] as string, {
				title: 'renamed',
			});
		});

		const made = note();

		expect(db.tables.notes.get(made.id).data?.title).toBe('renamed');
		expect(seen).toEqual([
			{ scope: 'rows', rowIds: [made.id] },
			{ scope: 'rows', rowIds: [made.id] },
		]);
	});
});

describe('kv reports its own changes', () => {
	test('a local update notifies, and the listener reads the new value', () => {
		const seen: unknown[] = [];
		db.kv.subscribe(() => seen.push(db.kv.get().error?.conforming.theme));

		db.kv.update({ theme: 'dark' });

		expect(seen).toEqual(['dark']);
	});

	test('a change that arrived from a peer notifies too', () => {
		// The case a settings screen exists for: another device changed a
		// preference and this one has to stop showing the old value.
		const author = openMemory(database);
		author.kv.update({ fontSize: 22 });
		const seen: unknown[] = [];
		db.kv.subscribe(() => seen.push(db.kv.get().error?.conforming.fontSize));

		syncEngineOf(db.store).applyRemote(
			asEnvelope(author.store.encodeStateSince()),
		);

		expect(seen).toEqual([22]);
	});

	test('CONTROL: a table write does not notify kv', () => {
		// Without this, an implementation that notified every subscriber on
		// every commit would satisfy both tests above.
		const seen: unknown[] = [];
		db.kv.subscribe(() => seen.push('kv'));

		note();

		expect(seen).toEqual([]);
	});

	test('registration never fires initially, and unsubscribing is idempotent', () => {
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
		const first = openMemory(database, record);
		first.kv.update({ theme: 'dark' });
		first.kv.update({ future: 'kept' } as never);
		await first.store[Symbol.asyncDispose]();

		const second = openMemory(
			defineData({
				id: 'so.epicenter.honeycrisp',
				kv: {
					theme: field.select(['light', 'dark']),
					added: field.string(),
					future: field.string(),
				},
				tables: {
					notes: {
						fields: {
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
		const read = second.kv.get();
		expect(read.data).toBeNull();
		expect(read.error?.conforming).toEqual({
			theme: 'dark',
			future: 'kept',
		});
		expect(read.error?.issues.map(({ field }) => field)).toEqual(['added']);
		await second.store[Symbol.asyncDispose]();
	});
});

describe('an undeclared table waits in the CRDT (ADR-0240)', () => {
	const withScratch = defineData({
		id: 'so.epicenter.honeycrisp',
		kv: { theme: field.select(['light', 'dark']) },
		tables: {
			notes: { fields: { title: field.string() } },
			scratch: { fields: { body: field.string() } },
		},
	});
	const withoutScratch = defineData({
		id: 'so.epicenter.honeycrisp',
		kv: {},
		tables: { notes: { fields: { title: field.string() } } },
	});

	test('the next runtime has no handle; one that re-declares it reads every row back', async () => {
		const record = createMemoryRecord();
		const first = openMemory(withScratch, record);
		const made = first.tables.scratch.create({ body: 'kept in the CRDT' });
		first.kv.update({ theme: 'dark' });
		await first.store[Symbol.asyncDispose]();

		// The device updates (ADR-0240): the same durable record, the next
		// runtime, a declaration that no longer names `scratch` or `kv`.
		const second = openMemory(withoutScratch, record);
		expect((second.tables as Record<string, unknown>).scratch).toBeUndefined();
		await second.store[Symbol.asyncDispose]();

		// A later release declares them again: nothing was lost, because the
		// CRDT is the truth and never dropped a byte.
		const third = openMemory(withScratch, record);
		expect(third.tables.scratch.list().rows).toEqual([
			{ id: made.id, body: 'kept in the CRDT' },
		]);
		expect(third.kv.get().data?.theme).toBe('dark');
		await third.store[Symbol.asyncDispose]();
	});

	test('stored() sees the table and the kv key the declaration dropped', async () => {
		const record = createMemoryRecord();
		const first = openMemory(withScratch, record);
		const made = first.tables.scratch.create({ body: 'kept in the CRDT' });
		first.kv.update({ theme: 'dark' });
		await first.store[Symbol.asyncDispose]();

		const second = openMemory(withoutScratch, record);
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
			notes: { fields: { title: field.string(), preview: field.string() } },
		},
	});
	const withoutPreview = defineData({
		id: 'so.epicenter.honeycrisp',
		kv: {},
		tables: { notes: { fields: { title: field.string() } } },
	});

	test('a field the declaration dropped survives here and nowhere else', async () => {
		const record = createMemoryRecord();
		const before = openMemory(withPreview, record);
		const made = before.tables.notes.create({
			title: 'Groceries',
			preview: 'milk, eggs',
		});
		await before.store[Symbol.asyncDispose]();

		// The release stops declaring `preview`. The row still CONFORMS, because
		// every field this declaration names reads fine, so it is not reported as
		// nonconforming either. Through the lens the stored value is unreachable
		// from both arms, which is exactly the data loss an export must not copy.
		const after = openMemory(withoutPreview, record);
		const listed = after.tables.notes.list();
		expect(listed.nonconforming).toEqual([]);
		expect(listed.rows).toEqual([{ id: made.id, title: 'Groceries' }]);

		expect(after.stored().tables.get('notes')?.get(made.id)).toEqual({
			title: 'Groceries',
			preview: 'milk, eggs',
		});
		await after.store[Symbol.asyncDispose]();
	});

	test('a deleted row is absent rather than empty', () => {
		const made = note();
		db.tables.notes.delete(made.id);
		expect(db.stored().tables.get('notes')?.has(made.id)).toBe(false);
	});
});

describe('foreign bytes have exactly one door', () => {
	// The manager's updateV2 listener treats any unrecognized origin as an
	// application writing into its own document, which is only correct for a
	// LOCAL transaction. An application holds the live document (a handle's
	// root exposes `.doc`), so the branch is guarded by `transaction.local`
	// rather than by convention: `applyUpdateV2` forces it to false and a
	// local `transact` defaults it to true. This test also pins
	// `transaction.local` itself: if an rc removed the field, every
	// application row-document write would take the throw and the suite fails
	// loudly.
	test('a direct Y.applyUpdateV2 on a live row document throws instead of forging authored work', async () => {
		const made = note({ title: 'mine' });
		const opened = await db.tables.notes.openDocument(made.id);
		const live = opened.data?.get('editor', 'text').doc;
		if (live === null || live === undefined) {
			throw new Error('root not attached to a document');
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
		).toThrow('store connection');

		// The throw fired before anything persisted, so the store is not
		// poisoned: local work still commits.
		const after = db.tables.notes.create({
			title: 'still works',
			tags: [],
			date: null,
		});
		expect(after.id).toHaveLength(24);
		opened.data?.[Symbol.dispose]();
	});
});

describe('a document store owes nobody (ADR-0233)', () => {
	test('local commits leave the outbox empty and no replica verb exists', async () => {
		const { sqlite } = createMemoryRecord();
		const device = createDeviceStore({ definition: database, sqlite });
		const store = device.store;
		try {
			const made = device.tables.notes.create({
				title: 'device work',
				tags: [],
				date: null,
			});
			expect(made.id).toHaveLength(24);

			// The write is durable, but it is owed to nobody: nothing could ever
			// acknowledge a device document's outbox, so nothing may join it.
			expect(sqlite.all('SELECT COUNT(*) AS owed FROM _outbox')).toEqual([
				{ owed: 0 },
			]);
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
			await device.store[Symbol.asyncDispose]();
		}
	});

	test('the sync VALUE discriminates the two kinds, at the type level too', async () => {
		// Compile-time pins: `sync !== undefined` must narrow the union in both
		// directions without an `in`-probe or a cast. The annotations are the
		// assertions; a shape change fails typecheck before it fails a test.
		function kindOf(store: DeviceStore | AccountStore): 'device' | 'account' {
			if (store.sync !== undefined) {
				const capability: SyncCapability = store.sync;
				void capability;
				const account: AccountStore = store;
				void account;
				return 'account';
			}
			const device: DeviceStore = store;
			void device;
			return 'device';
		}

		const device = createDeviceStore({
			definition: database,
			sqlite: createMemoryRecord().sqlite,
		});
		const account = openMemory(database);
		try {
			expect(kindOf(device.store)).toBe('device');
			expect(kindOf(account.store)).toBe('account');
		} finally {
			await device.store[Symbol.asyncDispose]();
			await account.store[Symbol.asyncDispose]();
		}
	});
});

describe('an unusable store throws, and never dresses up as a read outcome', () => {
	test('using a disposed store throws StoreUnusableError', async () => {
		const app = openMemory(database);
		await app.store[Symbol.asyncDispose]();
		expect(() => app.tables.notes.list()).toThrow(StoreUnusableError);
		expect(() => app.kv.get()).toThrow(StoreUnusableError);
		expect(() => app.tables.notes.get('anything')).toThrow(StoreUnusableError);
	});

	test('a refused durable flush leaves the store live and reports blocked', () => {
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
		expect(bound.tables.notes.list().rows.map((row) => row.title)).toEqual([
			'still accepted',
		]);
		// The debt is visible: a restart would lose this edit, and the status
		// says so instead of an exception pretending the data is gone now.
		expect(store.persistence.get()).toBe('blocked');
	});
});

describe('a document commit derives its row fields (ADR-0264)', () => {
	const withDerive = defineData({
		id: 'so.epicenter.honeycrisp',
		kv: {},
		tables: {
			notes: {
				fields: { preview: field.string() },
				document: {
					// Pure: the row's preview is whatever the document's `meta` root
					// says its title is. The store runs this on every local commit.
					derive: (doc) => {
						const meta = doc.get('meta') as { getAttr(key: string): unknown };
						return { preview: String(meta.getAttr('title') ?? '') };
					},
					// A document block owes its codec (ADR-0264/0267); this test only
					// exercises `derive`, so the codec is inert.
					file: { serialize: () => '', deserialize: () => undefined },
				},
			},
		},
	});

	test('a local edit to a row document writes the derived field onto the row', async () => {
		await using data = openMemory(withDerive);
		const made = data.tables.notes.create({ preview: '' });
		const opened = await data.tables.notes.openDocument(made.id);
		const handle = opened.data;
		if (handle === undefined || handle === null) {
			throw new Error('the document should open');
		}
		handle.get('meta').setAttr('title' as never, 'Groceries' as never);
		expect(data.tables.notes.get(made.id).data?.preview).toBe('Groceries');
		handle[Symbol.dispose]();
	});

	test('a later edit re-derives the field', async () => {
		await using data = openMemory(withDerive);
		const made = data.tables.notes.create({ preview: '' });
		const opened = await data.tables.notes.openDocument(made.id);
		const handle = opened.data;
		if (handle === undefined || handle === null) {
			throw new Error('the document should open');
		}
		handle.get('meta').setAttr('title' as never, 'First' as never);
		expect(data.tables.notes.get(made.id).data?.preview).toBe('First');
		handle.get('meta').setAttr('title' as never, 'Second' as never);
		expect(data.tables.notes.get(made.id).data?.preview).toBe('Second');
		handle[Symbol.dispose]();
	});

	test('the derivation comes back with the document, after it has unloaded', async () => {
		// The follow-up lives on the live document's entry, so it dies when the
		// last handle does. What proves that is not a leak: the next open
		// registers it again, and an edit derives exactly as the first one did.
		await using data = openMemory(withDerive);
		const made = data.tables.notes.create({ preview: '' });
		{
			const opened = await data.tables.notes.openDocument(made.id);
			using handle = expectOk(opened);
			if (handle === undefined) throw new Error('the document should open');
			handle.get('meta').setAttr('title' as never, 'First' as never);
		}
		expect(data.tables.notes.get(made.id).data?.preview).toBe('First');

		const reopened = await data.tables.notes.openDocument(made.id);
		using handle = expectOk(reopened);
		if (handle === undefined) throw new Error('the document should reopen');
		handle.get('meta').setAttr('title' as never, 'Second' as never);
		expect(data.tables.notes.get(made.id).data?.preview).toBe('Second');
	});
});

describe('the store manages instant createdAt/updatedAt (ADR-0265)', () => {
	const withTimestamps = defineData({
		id: 'so.epicenter.honeycrisp',
		kv: {},
		tables: {
			notes: {
				fields: {
					title: field.string(),
					createdAt: field.instant(),
					updatedAt: field.instant(),
				},
			},
		},
	});

	test('create stamps createdAt and updatedAt over whatever is passed', () => {
		const data = openMemory(withTimestamps);
		const made = data.tables.notes.create({
			title: 'Groceries',
			createdAt: 'not-an-instant' as never,
			updatedAt: 'not-an-instant' as never,
		});
		expect(made.createdAt).not.toBe('not-an-instant');
		expect(InstantString.is(made.createdAt)).toBe(true);
		expect(InstantString.is(made.updatedAt)).toBe(true);
	});

	test('update moves updatedAt and leaves createdAt', () => {
		const data = openMemory(withTimestamps);
		const made = data.tables.notes.create({
			title: 'Groceries',
			createdAt: 'x' as never,
			updatedAt: 'x' as never,
		});
		const updated = data.tables.notes.update(made.id, {
			title: 'Groceries and milk',
			updatedAt: 'stale' as never,
		});
		expect(updated.error).toBeNull();
		const after = data.tables.notes.get(made.id).data;
		expect(after?.createdAt).toBe(made.createdAt);
		expect(after?.updatedAt).not.toBe('stale');
		expect(
			after !== undefined &&
				after !== null &&
				after.updatedAt >= made.updatedAt,
		).toBe(true);
	});

	test('a table without instant createdAt/updatedAt is left alone', () => {
		const plain = defineData({
			id: 'so.epicenter.honeycrisp',
			kv: {},
			tables: { notes: { fields: { title: field.string() } } },
		});
		const data = openMemory(plain);
		const made = data.tables.notes.create({ title: 'Groceries' });
		expect(Object.keys(made).sort()).toEqual(['id', 'title']);
	});
});
