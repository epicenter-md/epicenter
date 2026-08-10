import type { TableInvalidation } from '@epicenter/lens';
import { defineLens } from '@epicenter/lens';
import { beforeEach, describe, expect, test } from 'bun:test';

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { open, openMemoryStore } from './bun.js';
import type { Store } from './store.js';

const lens = defineLens({
	namespace: 'so.epicenter.honeycrisp',
	kv: { theme: "'light'|'dark' = 'light'", fontSize: 'number = 14' },
	tables: {
		notes: { title: 'string', tags: 'string[]', date: 'string|null' },
	},
});

function openMemory() {
	const store = openMemoryStore();
	const { data: db, error } = store.bind(lens);
	if (error !== null) throw error;
	return { store, db };
}

let store: Store;
let db: ReturnType<typeof openMemory>['db'];

beforeEach(() => {
	({ store, db } = openMemory());
});

/** A note, and its minted id, for tests that need one to exist. */
function note(fields: Partial<Parameters<typeof db.notes.create>[0]> = {}) {
	const { data, error } = db.notes.create({
		title: 'Groceries',
		tags: ['food'],
		date: null,
		...fields,
	});
	if (error !== null) throw error;
	return data;
}

function exchange(a: Store, b: Store) {
	const fromA = a.encodeStateSince(b.stateVector());
	const fromB = b.encodeStateSince(a.stateVector());
	b.applyRemote(fromA);
	a.applyRemote(fromB);
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
		const { data, error } = db.notes.get('nope');
		expect(error).toBeNull();
		expect(data).toBeUndefined();
	});

	test('nothing in the surface returns a promise', () => {
		// One in-memory document over a synchronous SQLite boundary, so there is
		// no I/O to await and no ceremony to pay for one.
		const made = note();
		for (const value of [
			db.notes.get(made.id),
			db.notes.update(made.id, { title: 'x' }),
			db.notes.list(),
			db.notes.ids(),
			db.notes.document(made.id),
			db.kv.get(),
			db.kv.update({ theme: 'dark' }),
			db.query`SELECT 1 AS one`,
			db.notes.delete(made.id),
		]) {
			expect(value).not.toBeInstanceOf(Promise);
		}
	});
});

describe('a write that reaches nothing is a failure', () => {
	test('update on an absent row refuses instead of swallowing it', () => {
		const { data, error } = db.notes.update('nope', { title: 'x' });
		expect(data).toBeNull();
		// The verb this replaces returned Ok(undefined) and dropped the write.
		expect(error?.name).toBe('RowAbsent');
	});

	test('an invalid supplied value refuses the call and touches nothing', () => {
		const made = note();
		const { error } = db.notes.update(made.id, { tags: 'food' as never });
		expect(error?.name).toBe('Nonconforming');
		const after = db.notes.get(made.id).data;
		expect(after?.title).toBe('Groceries');
		expect(after?.tags).toEqual(['food']);
	});
});

describe('deletion', () => {
	test('a deleted row reads as absent and leaves the projection', () => {
		const made = note();
		expect(db.notes.delete(made.id).data).toBe(true);
		expect(db.notes.get(made.id).data).toBeUndefined();
		expect(db.notes.ids().data).toEqual([]);
		expect(db.query`SELECT id FROM notes`.data).toEqual([]);
	});

	test('deleting twice reports the second as a no-op', () => {
		const made = note();
		expect(db.notes.delete(made.id).data).toBe(true);
		expect(db.notes.delete(made.id).data).toBe(false);
	});

	test('CHURN DOES NOT ACCUMULATE A CORPSE PER DELETED ROW', () => {
		// The reason deletion removes the row's attribute instead of clearing it
		// and flagging it absent, which is what ADR-0212 chose. A tombstone is
		// paid by every device, in memory, on every load, forever, and a phone
		// does not get to opt out. At this row's shape the two models measure 37 B
		// and 86 B per dead row, so a regression to clear-and-flag fails here long
		// before anyone notices it on a device.
		const empty = store.encodeStateSince().length;
		for (let index = 0; index < 200; index += 1) {
			db.notes.delete(note({ title: 'x'.repeat(100) }).id);
		}
		expect(db.notes.ids().data).toEqual([]);
		const perDeadRow = (store.encodeStateSince().length - empty) / 200;
		expect(perDeadRow).toBeLessThan(60);
	});

	test('a deleted address cannot be revived, only refused', () => {
		// Deletion takes the row's attribute off the table root, so a deleted id
		// is indistinguishable from one nothing ever held. There is no reuse path
		// to get wrong: `update` refuses, and `create` mints an id of its own.
		const made = note();
		db.notes.delete(made.id);
		const { data, error } = db.notes.update(made.id, { title: 'back?' });
		expect(data).toBeNull();
		expect(error?.name).toBe('RowAbsent');
		expect(db.notes.get(made.id).data).toBeUndefined();
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
		expect(db.query`SELECT fontSize FROM kv WHERE fontSize = ${18}`.data).toEqual(
			[{ fontSize: 18 }],
		);
	});
});

describe('a nonconforming row is reported, never repaired', () => {
	const wrongLens = {
		namespace: 'so.epicenter.honeycrisp',
		tables: { notes: { title: 'string', tags: 'string', date: 'string|null' } },
	};

	test('the call site composes recovery from defaults and what survived', () => {
		const made = note();
		// Corrupt a stored value the way a peer on a newer release could.
		const { data: raw, error: bindError } = store.bindUnknown(wrongLens);
		if (bindError !== null) throw bindError;
		raw.notes?.update(made.id, { tags: 'food' });

		const { data, error } = db.notes.get(made.id);
		expect(data).toBeNull();
		expect(error?.name).toBe('Nonconforming');

		const recovered = data ?? {
			...db.notes.defaults,
			...(error as { conforming?: object }).conforming,
		};
		expect(recovered).toEqual({ id: made.id, title: 'Groceries', date: null });
	});

	test('list separates what it can read from what it cannot', () => {
		const broken = note({ title: 'broken' });
		const fine = note({ title: 'fine' });
		const { data: raw } = store.bindUnknown(wrongLens);
		raw?.notes?.update(broken.id, { tags: 'food' });
		const { data } = db.notes.list();
		expect(data?.rows.map((row) => row.id)).toEqual([fine.id]);
		expect(data?.nonconforming.map((issue) => issue.id)).toEqual([broken.id]);
	});
});

describe('two replicas converge', () => {
	function pair() {
		const laptop = openMemoryStore();
		const { data: laptopDb, error } = laptop.bind(lens);
		if (error !== null) throw error;
		return { laptop, laptopDb };
	}

	test('a row made on one device appears on the other', () => {
		const { laptop, laptopDb } = pair();
		const made = note({ title: 'Recorded on the phone', tags: ['voice'] });
		exchange(store, laptop);

		expect(laptopDb.notes.get(made.id).data?.title).toBe('Recorded on the phone');
		// And the laptop's projection was rebuilt, so SQL sees it too.
		expect(laptopDb.query`SELECT id, title FROM notes`.data).toEqual([
			{ id: made.id, title: 'Recorded on the phone' },
		]);
	});

	test('offline edits to different fields of one row both survive', () => {
		const { laptop, laptopDb } = pair();
		const made = note({ title: 'first' });
		exchange(store, laptop);

		db.notes.update(made.id, { title: 'phone title' });
		laptopDb.notes.update(made.id, { date: '2026-08-07' });
		exchange(store, laptop);

		for (const [name, handle] of [
			['phone', db.notes],
			['laptop', laptopDb.notes],
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
		const { laptop, laptopDb } = pair();
		const made = note({ title: 'first' });
		exchange(store, laptop);

		db.notes.delete(made.id);
		laptopDb.notes.update(made.id, { title: 'edited offline' });
		exchange(store, laptop);

		expect(db.notes.get(made.id).data).toBeUndefined();
		expect(laptopDb.notes.get(made.id).data).toBeUndefined();
		expect(laptopDb.notes.ids().data).toEqual([]);
		expect(laptopDb.query`SELECT id FROM notes`.data).toEqual([]);
	});

	test('two devices creating rows concurrently keep both', () => {
		// Safe by construction rather than by care: a minted 24-character id
		// cannot collide, so two devices never mint a container at one address.
		const { laptop, laptopDb } = pair();
		note({ title: 'from the phone' });
		laptopDb.notes.create({ title: 'from the laptop', tags: [], date: null });
		exchange(store, laptop);

		expect(db.notes.list().data?.rows).toHaveLength(2);
		expect(laptopDb.notes.list().data?.rows).toHaveLength(2);
	});
});

describe('a lens names the store it opens', () => {
	test('one namespace opens once per process, and disposing releases it', async () => {
		const root = await mkdtemp(join(tmpdir(), 'epicenter-claim-'));
		try {
			const first = await open(lens, { root });
			if (first.error !== null) throw first.error;

			const second = await open(lens, { root });
			expect(second.error?.name).toBe('AlreadyOpen');
			// The refusal is the whole point: a second open would be a second
			// `Y.Doc` over one document, and the two converge through storage
			// under last-writer-wins rather than seeing each other.
			expect(second.data).toBeNull();

			await first.data.$store[Symbol.asyncDispose]();

			const third = await open(lens, { root });
			expect(third.error).toBeNull();
			await third.data?.$store[Symbol.asyncDispose]();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test('a lens that will not bind releases the namespace it claimed', async () => {
		const root = await mkdtemp(join(tmpdir(), 'epicenter-refused-'));
		try {
			// A table named `query` collides with the reserved method, so this lens
			// parses and then refuses to bind. The store it half-opened must be
			// disposed and its namespace released, or the namespace is claimed for
			// the life of the process and the application can never start.
			const refused = { namespace: lens.namespace, tables: { query: { a: 'string' } } };
			const attempt = await open(refused as never, { root });
			expect(attempt.error).not.toBeNull();

			const after = await open(lens, { root });
			expect(after.error).toBeNull();
			await after.data?.$store[Symbol.asyncDispose]();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe('the document a row inherently owns', () => {
	test('holds application-named roots and survives a reopen', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'epicenter-doc-'));
		try {
			let id!: string;
			{
				const { data: diskDb, error } = await open(lens, { root: directory });
				if (error !== null) throw error;
				const disk = diskDb.$store;
				const made = diskDb.notes.create({ title: 'x', tags: [], date: null });
				if (made.error !== null) throw made.error;
				id = made.data.id;
				const container = diskDb.notes.document(id);
				if (container === undefined) throw new Error('no document');
				// The application names its root and picks its format. In Yjs 14
				// `change` hands back a fresh builder and `applyDelta` commits it.
				const editor = container.get('editor', 'text');
				editor.applyDelta(editor.change.insert('buy milk') as never);
				container.get('meta').setAttr('cursor' as never, 8 as never);
				await disk[Symbol.asyncDispose]();
			}
			const { data: db2, error } = await open(lens, { root: directory });
			if (error !== null) throw error;
			const container = db2.notes.document(id);
			expect(container?.get('editor', 'text').toString()).toContain('buy milk');
			expect(container?.get('meta').getAttr('cursor' as never)).toBe(8);
			await db2.$store[Symbol.asyncDispose]();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test('an absent row has no document, which is a fact not a failure', () => {
		// The same answer `get` gives an absent row, rather than an Err for one
		// and an Ok(undefined) for the other.
		expect(db.notes.document('nope')).toBeUndefined();
	});

	test('deleting the row takes its document with it', () => {
		const made = note();
		db.notes.document(made.id)?.get('editor', 'text');
		db.notes.delete(made.id);
		expect(db.notes.document(made.id)).toBeUndefined();
	});

	test('an editor writing into its own container cannot touch the row', () => {
		// Why the container exists at all. Bound to the row itself, a ProseMirror
		// schema whose doc node declares attributes overwrites the row's fields
		// and syncs that; measured in ADR-0215.
		const made = note();
		const container = db.notes.document(made.id);
		container?.get('editor', 'text').setAttr('title' as never, 'CLOBBER' as never);
		expect(db.notes.get(made.id).data?.title).toBe('Groceries');
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
		const phone = openMemoryStore();
		const laptop = openMemoryStore();
		const { data: phoneDb, error: e1 } = phone.bind(lens);
		const { data: laptopDb, error: e2 } = laptop.bind(lens);
		if (e1 !== null) throw e1;
		if (e2 !== null) throw e2;

		phoneDb.kv.update({ theme: 'dark' });
		laptopDb.kv.update({ fontSize: 22 });
		exchange(phone, laptop);

		const expected = { theme: 'dark', fontSize: 22 } as const;
		expect(phoneDb.kv.get().data).toEqual(expected);
		expect(laptopDb.kv.get().data).toEqual(expected);
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
		const origin = openMemoryStore();
		const { data: originDb, error } = origin.bind(lens);
		if (error !== null) throw error;
		const made = originDb.notes.create({ title: 'first', tags: [], date: null });
		if (made.error !== null) throw made.error;
		const first = origin.encodeStateSince();
		const afterFirst = origin.stateVector();
		originDb.notes.update(made.data.id, { title: 'second' });
		const second = origin.encodeStateSince(afterFirst);

		const directory = await mkdtemp(join(tmpdir(), 'epicenter-store-'));
		try {
			{
				const { data: laptopDb, error: openError } = await open(lens, {
					root: directory,
				});
				if (openError !== null) throw openError;
				const laptop = laptopDb.$store;
				expect(laptop.applyRemote(second).error).toBeNull();
				expect(laptop.hasUnresolvedDependencies()).toBe(true);
				await laptop[Symbol.asyncDispose]();
			}
			const { data: db2, error: reopenError } = await open(lens, {
				root: directory,
			});
			if (reopenError !== null) throw reopenError;
			const reopened = db2.$store;
			expect(reopened.hasUnresolvedDependencies()).toBe(true);

			expect(reopened.applyRemote(first).error).toBeNull();
			expect(reopened.hasUnresolvedDependencies()).toBe(false);
			expect(db2.notes.get(made.data.id).data?.title).toBe('second');
			await reopened[Symbol.asyncDispose]();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test('a fully applied replica reports no unresolved dependencies', () => {
		note();
		const laptop = openMemoryStore();
		laptop.bind(lens);
		laptop.applyRemote(store.encodeStateSince(laptop.stateVector()));
		expect(laptop.hasUnresolvedDependencies()).toBe(false);
	});
});

describe('pressure is the number that decides whether any of this matters', () => {
	test('a healthy document sits near the item cost of one row', () => {
		for (let index = 0; index < 20; index += 1) note({ title: `note ${index}` });
		const { data, error } = store.pressure();

		expect(error).toBeNull();
		expect(data?.liveRows).toBe(20);
		// A note here is a container, a document container and three fields, so
		// single digits. The absolute number is not the point; the ratio is.
		expect(data?.itemsPerLiveRow).toBeLessThan(15);
	});

	test('churn drives it up, which is the whole signal', () => {
		// Twenty live rows either way. The only difference is how many died to get
		// there, and that is exactly what the ratio has to expose, because the two
		// documents are indistinguishable from every other verb.
		for (let index = 0; index < 20; index += 1) note({ title: `keeper ${index}` });
		const healthy = store.pressure().data?.itemsPerLiveRow ?? 0;

		for (let index = 0; index < 200; index += 1) {
			const doomed = note({ title: `churn ${index}` });
			const { error } = db.notes.delete(doomed.id);
			if (error !== null) throw error;
		}
		const churned = store.pressure().data;

		expect(churned?.liveRows).toBe(20);
		expect(churned?.itemsPerLiveRow).toBeGreaterThan(healthy * 3);
	});

	test('an empty document reports its items rather than dividing by zero', () => {
		const { data, error } = store.pressure();

		expect(error).toBeNull();
		expect(data?.liveRows).toBe(0);
		expect(Number.isFinite(data?.itemsPerLiveRow)).toBe(true);
	});
})

describe('a subscription names the rows a commit touched', () => {
	/** Every invalidation one table handed a listener, in order. */
	function record(table: { subscribe(listener: (i: TableInvalidation) => void): () => void }) {
		const seen: TableInvalidation[] = [];
		const stop = table.subscribe((invalidation) => seen.push(invalidation));
		return { seen, stop };
	}

	test('registration is synchronous and never fires initially', () => {
		// ADR-0187's law 2. A caller that subscribes and then reads has already
		// seen everything, so an initial delivery would only ever be a duplicate
		// that every consumer has to learn to ignore.
		note();
		const { seen } = record(db.notes);

		expect(seen).toEqual([]);
	});

	test('a created row, an edited row and a deleted row each name themselves', () => {
		const { seen } = record(db.notes);

		const made = note();
		expect(seen).toEqual([{ scope: 'rows', rowIds: [made.id] }]);

		db.notes.update(made.id, { title: 'Shopping' });
		expect(seen.at(-1)).toEqual({ scope: 'rows', rowIds: [made.id] });

		db.notes.delete(made.id);
		expect(seen.at(-1)).toEqual({ scope: 'rows', rowIds: [made.id] });
		expect(seen).toHaveLength(3);
	});

	test('a write to another table is not this table\'s business', () => {
		// The control. Without it every assertion above would still pass on an
		// implementation that invalidated every subscriber on every commit.
		const other = openMemoryStore();
		const bound = other.bind(
			defineLens({
				namespace: 'so.epicenter.honeycrisp',
				tables: {
					notes: { title: 'string', tags: 'string[]', date: 'string|null' },
					folders: { name: 'string' },
				},
			}),
		);
		if (bound.error !== null) throw bound.error;
		const notes = record(bound.data.notes);
		const folders = record(bound.data.folders);

		const made = bound.data.folders.create({ name: 'Inbox' });
		if (made.error !== null) throw made.error;

		expect(folders.seen).toEqual([{ scope: 'rows', rowIds: [made.data.id] }]);
		expect(notes.seen).toEqual([]);
	});

	test('one commit touching many rows is ONE call carrying every id', () => {
		// ADR-0187's law 3. A remote update is the only thing in this surface
		// that commits more than one row at a time, so it is what proves it.
		const author = openMemory();
		const ids = [0, 1, 2].map(
			(index) => {
				const made = author.db.notes.create({
					title: `note ${index}`,
					tags: [],
					date: null,
				});
				if (made.error !== null) throw made.error;
				return made.data.id;
			},
		);
		const { seen } = record(db.notes);

		store.applyRemote(author.store.encodeStateSince());

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
		const { seen } = record(db.notes);

		db.notes.document(made.id)?.get('body', 'text');

		expect(seen).toEqual([{ scope: 'rows', rowIds: [made.id] }]);
	});

	test('prose written inside a row\'s document names the row', () => {
		// The case an `observeDeep` observer reports without an id, and the one
		// an editor binding produces on every keystroke burst. The write never
		// goes through a store verb: it is the application writing straight into
		// the type it was handed.
		const made = db.notes.create(
			{ title: 'Groceries', tags: [], date: null },
			{ document: ['body'] },
		);
		if (made.error !== null) throw made.error;
		const { seen } = record(db.notes);

		const body = db.notes.document(made.data.id)?.get('body', 'text');
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
		const author = openMemory();
		author.db.notes.create({ title: 'from the phone', tags: [], date: null });

		let atNotify: { crdt: number; sql: number } | undefined;
		db.notes.subscribe(() => {
			atNotify = {
				crdt: db.notes.list().data?.rows.length ?? -1,
				sql: db.query`SELECT count(*) AS n FROM notes`.data?.[0]?.n as number,
			};
		});
		store.applyRemote(author.store.encodeStateSince());

		expect(atNotify).toEqual({ crdt: 1, sql: 1 });
	});

	test('unsubscribing stops delivery, and doing it twice is harmless', () => {
		const { seen, stop } = record(db.notes);
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
		const first = record(db.notes);
		const second = record(db.notes);

		first.stop();
		first.stop();
		note();

		expect(first.seen).toHaveLength(0);
		expect(second.seen).toHaveLength(1);
	});

	test('a subscriber that throws does not cost the next one its invalidation', () => {
		db.notes.subscribe(() => {
			throw new Error('this subscriber is broken');
		});
		const { seen } = record(db.notes);

		const made = note();

		expect(seen).toEqual([{ scope: 'rows', rowIds: [made.id] }]);
	});

	test('a subscriber may write, and its own write is a separate invalidation', () => {
		const { seen } = record(db.notes);
		let wrote = false;
		db.notes.subscribe((invalidation) => {
			if (wrote || invalidation.scope !== 'rows') return;
			wrote = true;
			db.notes.update(invalidation.rowIds[0] as string, { title: 'renamed' });
		});

		const made = note();

		expect(db.notes.get(made.id).data?.title).toBe('renamed');
		expect(seen).toEqual([
			{ scope: 'rows', rowIds: [made.id] },
			{ scope: 'rows', rowIds: [made.id] },
		]);
	});
})

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
		const author = openMemory();
		author.db.kv.update({ fontSize: 22 });
		const seen: number[] = [];
		db.kv.subscribe(() => seen.push(db.kv.get().data?.fontSize as number));

		store.applyRemote(author.store.encodeStateSince());

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
})

describe('the kv projection is a cache, and is rebuilt like one', () => {
	test('db.query sees kv before anything has written to it', () => {
		// It used to see nothing. The kv projection was written only by
		// `kv.update`, so a store nobody had configured yet had a `kv` relation
		// with no row in it while `db.kv.get()` happily returned defaults.
		const rows = db.query`SELECT id, theme FROM kv`.data;
		expect(rows).toEqual([{ id: 'kv', theme: 'light' }]);
	});

	test('a lens change does not leave the previous lens s row behind', () => {
		// Tables are rebuilt at bind for exactly this reason; kv was not, so SQL
		// kept answering with a row the old declaration wrote.
		db.kv.update({ theme: 'dark' });
		const relensed = openMemoryStore();
		relensed.bindUnknown(lens);
		const second = relensed.bindUnknown({
			namespace: 'so.epicenter.honeycrisp',
			kv: { theme: "'light'|'dark' = 'light'", added: "string = 'new'" },
			tables: { notes: { title: 'string', tags: 'string[]', date: 'string|null' } },
		});
		if (second.error !== null) throw second.error;
		expect(second.data.query`SELECT id, theme, added FROM kv`.data).toEqual([
			{ id: 'kv', theme: 'light', added: 'new' },
		]);
	});
})
