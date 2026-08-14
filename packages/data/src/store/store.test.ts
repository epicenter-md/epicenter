import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SqliteDatabase, SqliteRow, SqliteValue } from '@epicenter/sqlite';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import type { TableInvalidation } from '@epicenter/workspace';
import { defineWorkspace } from '@epicenter/workspace';
import * as Y from '@y/y';
import { open, openMemory } from './bun.js';
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

const workspace = defineWorkspace({
	namespace: 'so.epicenter.honeycrisp',
	kv: { theme: "'light'|'dark' = 'light'", fontSize: 'number = 14' },
	tables: {
		notes: { title: 'string', tags: 'string[]', date: 'string|null' },
	},
});

let db: DataOf<typeof workspace>;

beforeEach(() => {
	db = openMemory(workspace);
});

/** A note, and its minted id, for tests that need one to exist. */
function note(
	fields: Partial<Parameters<typeof db.tables.notes.create>[0]> = {},
) {
	const { data, error } = db.tables.notes.create({
		title: 'Groceries',
		tags: ['food'],
		date: null,
		...fields,
	});
	if (error !== null) throw error;
	return data;
}

function exchange(a: AccountStore, b: AccountStore) {
	const fromA = a.encodeStateSince(b.stateVector());
	const fromB = b.encodeStateSince(a.stateVector());
	syncEngineOf(b).applyRemote(fromA);
	syncEngineOf(a).applyRemote(fromB);
}

describe('a read is a property access on a plain object', () => {
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

	test('nothing in the surface returns a promise', () => {
		// One in-memory document over a synchronous SQLite boundary, so there is
		// no I/O to await and no ceremony to pay for one.
		const made = note();
		for (const value of [
			db.tables.notes.get(made.id),
			db.tables.notes.update(made.id, { title: 'x' }),
			db.tables.notes.list(),
			db.tables.notes.ids(),
			db.tables.notes.document(made.id),
			db.kv.get(),
			db.kv.update({ theme: 'dark' }),
			db.query`SELECT 1 AS one`,
			db.tables.notes.delete(made.id),
		]) {
			expect(value).not.toBeInstanceOf(Promise);
		}
	});
});

describe('a write that reaches nothing is a failure', () => {
	test('update on an absent row refuses instead of swallowing it', () => {
		const { data, error } = db.tables.notes.update('nope', { title: 'x' });
		expect(data).toBeNull();
		// The verb this replaces returned Ok(undefined) and dropped the write.
		expect(error?.name).toBe('RowAbsent');
	});

	test('create refuses a payload that would not read back whole', () => {
		// The untyped door could omit a required field; the row then committed
		// and the same call reported it unreadable, which callers reasonably
		// read as "the row never existed". Refusing before the commit makes
		// that reading true: an Err from create touches nothing.
		const { data, error } = db.tables.notes.create({} as never);
		expect(data).toBeNull();
		expect(error?.name).toBe('Nonconforming');
		expect(db.tables.notes.ids()).toEqual([]);
	});

	test('an invalid supplied value refuses the call and touches nothing', () => {
		const made = note();
		const { error } = db.tables.notes.update(made.id, {
			tags: 'food' as never,
		});
		expect(error?.name).toBe('Nonconforming');
		const after = db.tables.notes.get(made.id).data;
		expect(after?.title).toBe('Groceries');
		expect(after?.tags).toEqual(['food']);
	});
});

describe('deletion', () => {
	test('a deleted row reads as absent and leaves the projection', () => {
		const made = note();
		expect(db.tables.notes.delete(made.id)).toBe(true);
		expect(db.tables.notes.get(made.id).data).toBeUndefined();
		expect(db.tables.notes.ids()).toEqual([]);
		expect(db.query`SELECT id FROM notes`.data).toEqual([]);
	});

	test('deleting twice reports the second as a no-op', () => {
		const made = note();
		expect(db.tables.notes.delete(made.id)).toBe(true);
		expect(db.tables.notes.delete(made.id)).toBe(false);
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

describe('the projection is written in the same transaction as the log', () => {
	test('query sees a committed local write immediately', () => {
		const made = note({ title: 'Groceries' });
		const { data: rows, error } = db.query`
			SELECT id, title FROM notes WHERE id = ${made.id}`;
		expect(error).toBeNull();
		expect(rows).toEqual([{ id: made.id, title: 'Groceries' }]);
	});

	test('an array field is queryable through json_each', () => {
		const found = note({ title: 'Groceries', tags: ['food', 'errands'] });
		note({ title: 'Ideas', tags: ['work'] });
		const { data: rows } = db.query`
			SELECT id FROM notes
			WHERE EXISTS (SELECT 1 FROM json_each(notes.tags) WHERE value = ${'food'})`;
		expect(rows).toEqual([{ id: found.id }]);
	});

	test('a scalar binds natively, so equality works without quoting JSON', () => {
		db.kv.update({ fontSize: 18 });
		expect(
			db.query`SELECT fontSize FROM kv WHERE fontSize = ${18}`.data,
		).toEqual([{ fontSize: 18 }]);
	});
});

describe('a nonconforming row is reported, never repaired', () => {
	const wrongWorkspace = defineWorkspace({
		namespace: 'so.epicenter.honeycrisp',
		tables: { notes: { title: 'string', tags: 'string', date: 'string|null' } },
	});

	/**
	 * Corrupt a stored value the way it actually happens: a peer device on a
	 * release whose declaration disagrees syncs the row in, writes a value its
	 * own declaration accepts, and syncs it back (ADR-0240: two definitions
	 * are never live in one runtime, but two devices may run two releases).
	 */
	function corruptTags(rowId: string): void {
		const peer = openMemory(wrongWorkspace);
		exchange(db.store, peer.store);
		const written = peer.tables.notes.update(rowId, { tags: 'food' });
		if (written.error !== null) throw written.error;
		exchange(db.store, peer.store);
	}

	test('the call site composes recovery from defaults and what survived', () => {
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
			...db.tables.notes.defaults,
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
		return { laptop: openMemory(workspace) };
	}

	test('a row made on one device appears on the other', () => {
		const { laptop } = pair();
		const made = note({ title: 'Recorded on the phone', tags: ['voice'] });
		exchange(db.store, laptop.store);

		expect(laptop.tables.notes.get(made.id).data?.title).toBe(
			'Recorded on the phone',
		);
		// And the laptop's projection was rebuilt, so SQL sees it too.
		expect(laptop.query`SELECT id, title FROM notes`.data).toEqual([
			{ id: made.id, title: 'Recorded on the phone' },
		]);
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
		expect(laptop.query`SELECT id FROM notes`.data).toEqual([]);
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

describe('a workspace names the store it opens', () => {
	test('one namespace opens once per process, and disposing releases it', async () => {
		const root = await mkdtemp(join(tmpdir(), 'epicenter-claim-'));
		try {
			const first = await open(workspace, { root });
			if (first.error !== null) throw first.error;

			const second = await open(workspace, { root });
			expect(second.error?.name).toBe('AlreadyOpen');
			// The refusal is the whole point: a second open would be a second
			// `Y.Doc` over one document, and the two converge through storage
			// under last-writer-wins rather than seeing each other.
			expect(second.data).toBeNull();

			await first.data[Symbol.asyncDispose]();

			const third = await open(workspace, { root });
			expect(third.error).toBeNull();
			await third.data?.[Symbol.asyncDispose]();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test('a workspace that will not parse releases the namespace it claimed', async () => {
		const root = await mkdtemp(join(tmpdir(), 'epicenter-refused-'));
		try {
			// A table named `kv` collides with the relation KV projects into, which
			// is the one name a workspace still reserves. The store this half-opened must
			// be disposed and its namespace released, or the namespace is claimed for
			// the life of the process and the application can never start.
			const refused = {
				namespace: workspace.namespace,
				tables: { kv: { a: 'string' } },
			};
			const attempt = await open(refused as never, { root });
			expect(attempt.error).not.toBeNull();

			const after = await open(workspace, { root });
			expect(after.error).toBeNull();
			await after.data?.[Symbol.asyncDispose]();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test('a corrupt durable record refuses the boot and releases the claim', async () => {
		const root = await mkdtemp(join(tmpdir(), 'epicenter-corrupt-'));
		try {
			{
				const { data: first, error } = await open(workspace, { root });
				if (error !== null) throw error;
				expectOkCreate(first);
				await first[Symbol.asyncDispose]();
			}
			// One garbage row in the update log: the hydration replay cannot
			// decode it, which is "the store could not read its durable record".
			const file = new Database(
				join(root, workspace.namespace, 'store.sqlite3'),
			);
			file.run('UPDATE _updates SET bytes = ?', [
				new Uint8Array([1, 2, 3, 4, 5]),
			]);
			file.close();

			const refused = await open(workspace, { root });
			expect(refused.data).toBeNull();
			expect(refused.error?.name).toBe('StorageFailed');

			// The claim was released with the refusal: a retry reports the same
			// honest failure rather than `AlreadyOpen` for the life of the
			// process.
			const again = await open(workspace, { root });
			expect(again.error?.name).toBe('StorageFailed');
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

/** One created note through whichever runtime the disk test holds. */
function expectOkCreate(data: DataOf<typeof workspace>): void {
	const made = data.tables.notes.create({
		title: 'to be corrupted',
		tags: [],
		date: null,
	});
	if (made.error !== null) throw made.error;
}

describe('the document a row inherently owns', () => {
	test('holds application-named roots and survives a reopen', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'epicenter-doc-'));
		try {
			let id!: string;
			{
				const { data: diskDb, error } = await open(workspace, {
					root: directory,
				});
				if (error !== null) throw error;
				const disk = diskDb;
				const made = diskDb.tables.notes.create({
					title: 'x',
					tags: [],
					date: null,
				});
				if (made.error !== null) throw made.error;
				id = made.data.id;
				const container = diskDb.tables.notes.document(id);
				if (container === undefined) throw new Error('no document');
				// The application names its root and picks its format. In Yjs 14
				// `change` hands back a fresh builder and `applyDelta` commits it.
				const editor = container.get('editor', 'text');
				editor.applyDelta(editor.change.insert('buy milk') as never);
				container.get('meta').setAttr('cursor' as never, 8 as never);
				await disk[Symbol.asyncDispose]();
			}
			const { data: db2, error } = await open(workspace, { root: directory });
			if (error !== null) throw error;
			const container = db2.tables.notes.document(id);
			expect(container?.get('editor', 'text').toString()).toContain('buy milk');
			expect(container?.get('meta').getAttr('cursor' as never)).toBe(8);
			await db2[Symbol.asyncDispose]();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test('an absent row has no document, which is a fact not a failure', () => {
		// The same answer `get` gives an absent row, rather than an Err for one
		// and an Ok(undefined) for the other.
		expect(db.tables.notes.document('nope')).toBeUndefined();
	});

	test('deleting the row takes its document with it', () => {
		const made = note();
		db.tables.notes.document(made.id)?.get('editor', 'text');
		db.tables.notes.delete(made.id);
		expect(db.tables.notes.document(made.id)).toBeUndefined();
	});

	test('an editor writing into its own container cannot touch the row', () => {
		// Why the container exists at all. Bound to the row itself, a ProseMirror
		// schema whose doc node declares attributes overwrites the row's fields
		// and syncs that; measured in ADR-0215.
		const made = note();
		const container = db.tables.notes.document(made.id);
		container
			?.get('editor', 'text')
			.setAttr('title' as never, 'CLOBBER' as never);
		expect(db.tables.notes.get(made.id).data?.title).toBe('Groceries');
	});
});

describe('kv is where anything two devices both write belongs', () => {
	test('an unwritten key reads as its declared default', () => {
		const { data, error } = db.kv.get();
		expect(error).toBeNull();
		expect(data).toEqual({ theme: 'light', fontSize: 14 });
	});

	test('a write touches only the keys it names', () => {
		db.kv.update({ theme: 'dark' });
		expect(db.kv.get().data).toEqual({ theme: 'dark', fontSize: 14 });
	});

	test('an undeclared key is refused by name', () => {
		expect(db.kv.update({ nope: 1 } as never).error?.name).toBe('UnknownField');
	});

	test('an invalid value is refused and touches nothing', () => {
		db.kv.update({ fontSize: 20 });
		expect(db.kv.update({ theme: 'purple' as never }).error?.name).toBe(
			'Nonconforming',
		);
		expect(db.kv.get().data).toEqual({ theme: 'light', fontSize: 20 });
	});

	test('TWO DEVICES BOOTING OFFLINE BOTH KEEP THEIR SETTINGS', () => {
		// The case that motivated moving KV to a reserved root. Through a chosen
		// row id this loses one device's write entirely, because each mints its
		// own nested container and map LWW keeps one. A root is addressed by its
		// name, so both survive. `evidence/bench/row-model.ts` keeps the losing
		// contrast, now that the chosen-id door is gone from the API.
		const phone = openMemory(workspace);
		const laptop = openMemory(workspace);

		phone.kv.update({ theme: 'dark' });
		laptop.kv.update({ fontSize: 22 });
		exchange(phone.store, laptop.store);

		const expected = { theme: 'dark', fontSize: 22 } as const;
		expect(phone.kv.get().data).toEqual(expected);
		expect(laptop.kv.get().data).toEqual(expected);
	});

	test('kv is queryable as a one-row relation', () => {
		db.kv.update({ theme: 'dark', fontSize: 20 });
		expect(db.query`SELECT theme, fontSize FROM kv`.data).toEqual([
			{ theme: 'dark', fontSize: 20 },
		]);
	});
});

describe('a received update is persisted as the bytes that arrived', () => {
	test('an update whose dependencies are missing survives a RESTART', async () => {
		// Yjs buffers an update it cannot integrate, applyUpdateV2 returns
		// normally, and the document emits NO updateV2 event. Persisting emitted
		// bytes writes nothing, so the bytes are lost at restart while every
		// layer reported success. The restart is the whole test: an in-memory
		// store keeps the buffered update either way.
		const origin = openMemory(workspace);
		const made = origin.tables.notes.create({
			title: 'first',
			tags: [],
			date: null,
		});
		if (made.error !== null) throw made.error;
		const first = origin.store.encodeStateSince();
		const afterFirst = origin.store.stateVector();
		origin.tables.notes.update(made.data.id, { title: 'second' });
		const second = origin.store.encodeStateSince(afterFirst);

		const directory = await mkdtemp(join(tmpdir(), 'epicenter-store-'));
		try {
			{
				const { data: laptop, error: openError } = await open(workspace, {
					root: directory,
				});
				if (openError !== null) throw openError;
				expect(syncEngineOf(laptop.store).applyRemote(second).error).toBeNull();
				expect(syncEngineOf(laptop.store).hasUnresolvedDependencies()).toBe(
					true,
				);
				await laptop[Symbol.asyncDispose]();
			}
			const { data: db2, error: reopenError } = await open(workspace, {
				root: directory,
			});
			if (reopenError !== null) throw reopenError;
			const reopened = syncEngineOf(db2.store);
			expect(reopened.hasUnresolvedDependencies()).toBe(true);

			expect(reopened.applyRemote(first).error).toBeNull();
			expect(reopened.hasUnresolvedDependencies()).toBe(false);
			expect(db2.tables.notes.get(made.data.id).data?.title).toBe('second');
			await db2.store[Symbol.asyncDispose]();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test('a fully applied replica reports no unresolved dependencies', () => {
		note();
		const laptop = openMemory(workspace);
		syncEngineOf(laptop.store).applyRemote(
			db.store.encodeStateSince(laptop.store.stateVector()),
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
		// A note here is a container, a document container and three fields, so
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
			defineWorkspace({
				namespace: 'so.epicenter.honeycrisp',
				tables: {
					notes: { title: 'string', tags: 'string[]', date: 'string|null' },
					folders: { name: 'string' },
				},
			}),
		);
		const notes = record(other.tables.notes);
		const folders = record(other.tables.folders);

		const made = other.tables.folders.create({ name: 'Inbox' });
		if (made.error !== null) throw made.error;

		expect(folders.seen).toEqual([{ scope: 'rows', rowIds: [made.data.id] }]);
		expect(notes.seen).toEqual([]);
	});

	test('one commit touching many rows is ONE call carrying every id', () => {
		// ADR-0187's law 3. A remote update is the only thing in this surface
		// that commits more than one row at a time, so it is what proves it.
		const author = openMemory(workspace);
		const ids = [0, 1, 2].map((index) => {
			const made = author.tables.notes.create({
				title: `note ${index}`,
				tags: [],
				date: null,
			});
			if (made.error !== null) throw made.error;
			return made.data.id;
		});
		const { seen } = record(db.tables.notes);

		syncEngineOf(db.store).applyRemote(author.store.encodeStateSince());

		expect(seen).toHaveLength(1);
		const only = seen[0];
		if (only?.scope !== 'rows') throw new Error('expected row scope');
		expect([...only.rowIds].sort()).toEqual([...ids].sort());
	});

	test('minting a document root that create did not name is itself a write', () => {
		// Worth pinning because it is easy to read `document(id).get(name)` as a
		// pure read. It creates on miss, and creating is a transaction, so a row
		// whose roots were not named at `create` invalidates on first open. That
		// is not a bug in the subscription; it is the write ADR-0215 wants
		// nobody to be making, showing up where it can be seen.
		const made = note();
		const { seen } = record(db.tables.notes);

		db.tables.notes.document(made.id)?.get('body', 'text');

		expect(seen).toEqual([{ scope: 'rows', rowIds: [made.id] }]);
	});

	test("prose written inside a row's document names the row", () => {
		// The case an `observeDeep` observer reports without an id, and the one
		// an editor binding produces on every keystroke burst. The write never
		// goes through a store verb: it is the application writing straight into
		// the type it was handed.
		const made = db.tables.notes.create(
			{ title: 'Groceries', tags: [], date: null },
			{ document: ['body'] },
		);
		if (made.error !== null) throw made.error;
		const { seen } = record(db.tables.notes);

		const body = db.tables.notes.document(made.data.id)?.get('body', 'text');
		if (body === undefined) throw new Error('the row has no document');
		body.applyDelta(body.change.insert('milk and eggs') as never);

		expect(seen).toEqual([{ scope: 'rows', rowIds: [made.data.id] }]);
	});

	test('the listener reads the same rows through the CRDT and through SQL', () => {
		// The measured hazard this whole buffer exists for. The `'delta'` that
		// names the row fires synchronously inside `applyUpdateV2`, BEFORE the
		// projection has been rebuilt, so a subscriber notified there sees the
		// CRDT reporting a row that `db.query` cannot find. Notifying after the
		// projection commits is what makes these two agree.
		const author = openMemory(workspace);
		author.tables.notes.create({
			title: 'from the phone',
			tags: [],
			date: null,
		});

		let atNotify: { crdt: number; sql: number } | undefined;
		db.tables.notes.subscribe(() => {
			atNotify = {
				crdt: db.tables.notes.list().rows.length,
				sql: db.query`SELECT count(*) AS n FROM notes`.data?.[0]?.n as number,
			};
		});
		syncEngineOf(db.store).applyRemote(author.store.encodeStateSince());

		expect(atNotify).toEqual({ crdt: 1, sql: 1 });
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
		db.kv.subscribe(() => seen.push(db.kv.get().data?.theme));

		db.kv.update({ theme: 'dark' });

		expect(seen).toEqual(['dark']);
	});

	test('a change that arrived from a peer notifies too', () => {
		// The case a settings screen exists for: another device changed a
		// preference and this one has to stop showing the old value.
		const author = openMemory(workspace);
		author.kv.update({ fontSize: 22 });
		const seen: number[] = [];
		db.kv.subscribe(() => seen.push(db.kv.get().data?.fontSize as number));

		syncEngineOf(db.store).applyRemote(author.store.encodeStateSince());

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

describe('the kv projection is a cache, and is rebuilt like one', () => {
	test('db.query sees kv before anything has written to it', () => {
		// It used to see nothing. The kv projection was written only by
		// `kv.update`, so a store nobody had configured yet had a `kv` relation
		// with no row in it while `db.kv.get()` happily returned defaults.
		const rows = db.query`SELECT id, theme FROM kv`.data;
		expect(rows).toEqual([{ id: 'kv', theme: 'light' }]);
	});

	test('an upgraded declaration does not leave the previous release s row behind', async () => {
		// Tables are rebuilt at open for exactly this reason; kv was not, so SQL
		// kept answering with a row the old declaration wrote. The upgrade is a
		// close and a reopen (ADR-0240): the same durable file, a newer
		// declaration, one runtime at a time.
		const database = createBunSqliteAdapter(new Database(':memory:'));
		const first = createAccountStore({ workspace: workspace, database });
		const written = first.kv.update({ theme: 'dark' });
		if (written.error !== null) throw written.error;
		await first[Symbol.asyncDispose]();

		const second = createAccountStore({
			workspace: defineWorkspace({
				namespace: 'so.epicenter.honeycrisp',
				kv: { theme: "'light'|'dark' = 'light'", added: "string = 'new'" },
				tables: {
					notes: { title: 'string', tags: 'string[]', date: 'string|null' },
				},
			}),
			database,
		});
		// The stored write survives the upgrade, and the new declaration's
		// default appears beside it: the row was rebuilt, not carried.
		expect(second.query`SELECT id, theme, added FROM kv`.data).toEqual([
			{ id: 'kv', theme: 'dark', added: 'new' },
		]);
	});
});

describe('a removed relation leaves SQL and waits in the CRDT (ADR-0240)', () => {
	// The durable record and the projection deliberately share one database
	// here, which is the Durable Object shape: the only synchronous SQLite in
	// `workerd` is the object's own storage. The projection owns that
	// database's letter-named relations OUTRIGHT, so a definition that stops
	// declaring a table takes its relation out of `query`; the underscore
	// relations are the durable record and are never the projection's to
	// touch. The rows themselves stay in the CRDT, which is the truth.
	const withScratch = defineWorkspace({
		namespace: 'so.epicenter.honeycrisp',
		kv: { theme: "'light'|'dark' = 'light'" },
		tables: {
			notes: { title: 'string' },
			scratch: { body: 'string' },
		},
	});
	const withoutScratch = defineWorkspace({
		namespace: 'so.epicenter.honeycrisp',
		tables: { notes: { title: 'string' } },
	});

	test('the next runtime drops it; one that re-declares it reads every row back', async () => {
		const database = createBunSqliteAdapter(new Database(':memory:'));
		const first = createAccountStore({ workspace: withScratch, database });
		const made = first.tables.scratch.create({ body: 'kept in the CRDT' });
		if (made.error !== null) throw made.error;
		const wrote = first.kv.update({ theme: 'dark' });
		if (wrote.error !== null) throw wrote.error;
		expect(first.query`SELECT body FROM scratch`.data).toEqual([
			{ body: 'kept in the CRDT' },
		]);
		await first[Symbol.asyncDispose]();

		// The device updates (ADR-0240): same durable database, the next
		// runtime, a declaration that no longer names `scratch` or `kv`.
		const second = createAccountStore({ workspace: withoutScratch, database });
		// Gone from SQL, not merely empty: the relation itself was dropped, so
		// nothing can keep reading rows this runtime cannot see or update.
		expect(second.query`SELECT body FROM scratch`.error?.name).toBe(
			'QueryFailed',
		);
		expect(
			second.query`SELECT name FROM sqlite_master WHERE name IN ('scratch', 'kv')`
				.data,
		).toEqual([]);
		// And the durable record beside it was untouched: the sweep claims only
		// the letter-named namespace, never the store's own relations.
		expect(
			database.all<SqliteRow & { total: number }>(
				'SELECT COUNT(*) AS total FROM _updates',
			)[0]?.total,
		).toBeGreaterThan(0);
		await second[Symbol.asyncDispose]();

		// A later release declares them again: nothing was lost, because the
		// projection is a cache and the CRDT never dropped a byte.
		const third = createAccountStore({ workspace: withScratch, database });
		expect(third.query`SELECT body FROM scratch`.data).toEqual([
			{ body: 'kept in the CRDT' },
		]);
		const back = third.kv.get();
		expect(back.data?.theme).toBe('dark');
		await third[Symbol.asyncDispose]();
	});
});

describe('foreign bytes have exactly one door', () => {
	// The fourth branch of the updateV2 listener treats any unrecognized origin
	// as an application writing into a row's document, which is only correct
	// for a LOCAL transaction. An application can reach the live document (a
	// row document root exposes `.doc`), so the branch is guarded by
	// `transaction.local` rather than by convention: `applyUpdateV2` forces it
	// to false and a local `transact` defaults it to true. This test also pins
	// `transaction.local` itself: if an rc removed the field, every application
	// row-document write would take the throw and the suite fails loudly.
	test('a direct Y.applyUpdateV2 on the live document throws instead of forging authored work', () => {
		const made = db.tables.notes.create(
			{ title: 'mine', tags: [], date: null },
			{ document: ['editor'] },
		);
		if (made.error !== null) throw made.error;
		const container = db.tables.notes.document(made.data.id);
		if (container === undefined) throw new Error('no document');
		const live = container.get('editor', 'text').doc;
		if (live === null) throw new Error('root not attached to a document');

		const stranger = openMemory(workspace);
		stranger.tables.notes.create({ title: 'theirs', tags: [], date: null });
		const foreign = stranger.store.encodeStateSince();

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
		expect(after.error).toBeNull();
	});
});

describe('discard deletes the live file whole, and the shelf survives (ADR-0231)', () => {
	test('a discarded store reopens empty at cursor zero, with history intact', async () => {
		const root = await mkdtemp(join(tmpdir(), 'epicenter-discard-'));
		try {
			const opened = await open(workspace, { root });
			if (opened.error !== null) throw opened.error;
			const app = opened.data;
			const made = app.tables.notes.create({
				title: 'retired document work',
				tags: [],
				date: null,
			});
			if (made.error !== null) throw made.error;
			syncEngineOf(app.store).advance(9);

			const discarded = await app.store.discard();
			expect(discarded.error).toBeNull();
			expect(existsSync(join(root, workspace.namespace, 'store.sqlite3'))).toBe(
				false,
			);
			// The shelf is the owner's, not the document's.
			expect(
				existsSync(join(root, workspace.namespace, 'history.sqlite3')),
			).toBe(true);

			// Boot is the whole of adoption: a wiped store opens empty and asks
			// the authority for everything, from zero.
			const reopened = await open(workspace, { root });
			if (reopened.error !== null) throw reopened.error;
			try {
				expect(reopened.data.tables.notes.list().rows).toEqual([]);
				expect(syncEngineOf(reopened.data.store).cursor()).toBe(0);
			} finally {
				await reopened.data[Symbol.asyncDispose]();
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe('a document store owes nobody (ADR-0233)', () => {
	test('local commits leave the outbox empty and no replica verb exists', async () => {
		const database = createBunSqliteAdapter(new Database(':memory:'));
		const device = createDeviceStore({ workspace: workspace, database });
		const store = device.store;
		try {
			const made = device.tables.notes.create({
				title: 'device work',
				tags: [],
				date: null,
			});
			expect(made.error).toBeNull();

			// The write is durable, but it is owed to nobody: nothing could ever
			// acknowledge a device document's outbox, so nothing may join it.
			expect(database.all('SELECT COUNT(*) AS owed FROM _outbox')).toEqual([
				{ owed: 0 },
			]);
			expect(
				database.all<{ count: number }>(
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
			await device[Symbol.asyncDispose]();
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
			workspace: workspace,
			database: createBunSqliteAdapter(new Database(':memory:')),
		});
		const account = openMemory(workspace);
		try {
			expect(kindOf(device.store)).toBe('device');
			expect(kindOf(account.store)).toBe('account');
		} finally {
			await device[Symbol.asyncDispose]();
			await account[Symbol.asyncDispose]();
		}
	});
});

describe('an unusable store throws, and never dresses up as a read outcome', () => {
	test('using a disposed store throws StoreUnusableError', async () => {
		const app = openMemory(workspace);
		await app[Symbol.asyncDispose]();
		expect(() => app.tables.notes.list()).toThrow(StoreUnusableError);
		expect(() => app.kv.get()).toThrow(StoreUnusableError);
		expect(() => app.tables.notes.get('anything')).toThrow(StoreUnusableError);
	});

	test('a refused durable flush leaves the store live and reports blocked', () => {
		// The withdrawn poison (ADR-0238): storage failing is a visible debt,
		// never the store's death. The live document is the truth while open.
		const raw = new Database(':memory:');
		const database = createBunSqliteAdapter(raw);
		const projection = createBunSqliteAdapter(new Database(':memory:'));
		const bound = createAccountStore({
			workspace: workspace,
			database,
			projection,
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
		expect(made.error).toBeNull();
		// Reads and the query projection follow the accepted edit immediately.
		expect(bound.tables.notes.list().rows.map((row) => row.title)).toEqual([
			'still accepted',
		]);
		expect(bound.query`SELECT title FROM notes`.data).toEqual([
			{ title: 'still accepted' },
		]);
		// The debt is visible: a restart would lose this edit, and the status
		// says so instead of an exception pretending the data is gone now.
		expect(store.persistence.get()).toBe('blocked');
	});
});

describe('the read index is a rebuildable cache (ADR-0238)', () => {
	/**
	 * A healthy durable engine under a projection that can refuse: the exact
	 * inverse of the failable-port harness in `persistence.test.ts`, because
	 * the two debts must fail independently.
	 */
	function openWithFailableProjection() {
		const durable = createBunSqliteAdapter(new Database(':memory:'));
		const inner = createBunSqliteAdapter(new Database(':memory:'));
		const gate = { failing: false };
		const projection: SqliteDatabase = {
			run(sql: string, parameters?: readonly SqliteValue[]): void {
				if (gate.failing) throw new Error('projection refused');
				inner.run(sql, parameters);
			},
			all<TRow extends SqliteRow>(
				sql: string,
				parameters?: readonly SqliteValue[],
			): TRow[] {
				if (gate.failing) throw new Error('projection refused');
				return inner.all<TRow>(sql, parameters);
			},
			transaction<TResult>(run: () => TResult): TResult {
				if (gate.failing) throw new Error('projection refused');
				return inner.transaction(run);
			},
		};
		const db = createAccountStore({
			workspace: workspace,
			database: durable,
			projection,
			// The refused projection write is the subject here, not noise.
			log: {
				error: () => undefined,
				warn: () => undefined,
				info: () => undefined,
				debug: () => undefined,
				trace: () => undefined,
			},
		});
		return { store: db.store, db, gate, durable };
	}

	test('a failed projection write never fails the verb, and the durable debt stays separate', () => {
		const { store, db, gate, durable } = openWithFailableProjection();
		const before = db.tables.notes.create({
			title: 'before',
			tags: [],
			date: null,
		});
		expect(before.error).toBeNull();

		gate.failing = true;
		const during = db.tables.notes.create({
			title: 'while stale',
			tags: [],
			date: null,
		});
		expect(during.error).toBeNull();
		// Live reads follow the accepted edit; the persistence debt is
		// untouched, because the durable engine took both writes fine.
		expect(
			db.tables.notes
				.list()
				.rows.map((row) => row.title)
				.sort(),
		).toEqual(['before', 'while stale']);
		expect(store.persistence.get()).toBe('saved');
		expect(
			durable.all<{ count: number }>(
				'SELECT COUNT(*) AS count FROM _updates',
			)[0]?.count,
		).toBe(2);
	});

	test('a stale index refuses to answer rather than serving old rows', () => {
		const { db, gate } = openWithFailableProjection();
		expect(
			db.tables.notes.create({ title: 'cached', tags: [], date: null }).error,
		).toBeNull();

		gate.failing = true;
		expect(
			db.tables.notes.create({ title: 'never cached', tags: [], date: null })
				.error,
		).toBeNull();

		// The projection still physically holds only 'cached'. Serving it would
		// be a lie, so the query is refused while the rebuild cannot run.
		const refused = db.query`SELECT title FROM notes ORDER BY title`;
		expect(refused.data).toBeNull();
		expect(refused.error?.name).toBe('QueryFailed');

		// The first query after healing rebuilds the whole index before it
		// answers: no window where SQL disagrees with the live document.
		gate.failing = false;
		expect(db.query`SELECT title FROM notes ORDER BY title`.data).toEqual([
			{ title: 'cached' },
			{ title: 'never cached' },
		]);
	});

	test('a remote update is durable even while the read index refuses', () => {
		const author = openMemory(workspace);
		const made = author.tables.notes.create({
			title: 'from the authority',
			tags: [],
			date: null,
		});
		expect(made.error).toBeNull();
		const update = author.store.encodeStateSince();

		const replica = openWithFailableProjection();
		replica.gate.failing = true;
		const applied = syncEngineOf(replica.store).applyRemote(update, {
			advanceTo: 4,
		});
		expect(applied.error).toBeNull();

		// Live: rows and cursor advanced at once.
		expect(replica.db.tables.notes.list().rows.map((row) => row.title)).toEqual(
			['from the authority'],
		);
		expect(syncEngineOf(replica.store).cursor()).toBe(4);
		// Durable: the bytes and their bookmark landed despite the projection,
		// or a restart would silently drop an update every layer accepted.
		expect(
			replica.durable.all<{ count: number }>(
				'SELECT COUNT(*) AS count FROM _updates',
			)[0]?.count,
		).toBe(1);
		expect(
			replica.durable.all<{ seq: number }>('SELECT seq FROM _cursor')[0]?.seq,
		).toBe(4);

		replica.gate.failing = false;
		expect(replica.db.query`SELECT title FROM notes`.data).toEqual([
			{ title: 'from the authority' },
		]);
	});

	test('a remote KV change reaches query without a rebind', () => {
		const author = openMemory(workspace);
		expect(author.kv.update({ theme: 'dark' }).error).toBeNull();
		const update = author.store.encodeStateSince();

		const replica = openMemory(workspace);
		expect(syncEngineOf(replica.store).applyRemote(update).error).toBeNull();

		// The whole-index rebuild a remote update triggers covers KV too; it
		// used to cover only tables, so this row stayed at the previous value
		// until the next bind.
		expect(replica.query`SELECT theme FROM kv`.data).toEqual([
			{ theme: 'dark' },
		]);
	});
});
