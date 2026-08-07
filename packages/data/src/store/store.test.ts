import { defineLens } from '@epicenter/lens/lens';
import { beforeEach, describe, expect, test } from 'bun:test';

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openBunStore, openMemoryStore } from './bun.js';
import type { Store } from './store.js';

const lens = defineLens({
	namespace: 'so.epicenter.honeycrisp',
	kv: { theme: "'light'|'dark' = 'light'", fontSize: 'number = 14' },
	tables: {
		notes: { title: 'string', tags: 'string[]', date: 'string|null' },
	},
});

function open() {
	const store = openMemoryStore();
	const { data: db, error } = store.bind(lens);
	if (error !== null) throw error;
	return { store, db };
}

let store: Store;
let db: ReturnType<typeof open>['db'];

beforeEach(() => {
	({ store, db } = open());
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

	test('a delete on one device and an edit on the other converge', () => {
		const { laptop, laptopDb } = pair();
		const made = note({ title: 'first' });
		exchange(store, laptop);

		db.notes.delete(made.id);
		laptopDb.notes.update(made.id, { title: 'edited offline' });
		exchange(store, laptop);

		expect(JSON.stringify(db.notes.get(made.id).data)).toBe(
			JSON.stringify(laptopDb.notes.get(made.id).data),
		);
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

describe('the document a row inherently owns', () => {
	test('holds application-named roots and survives a reopen', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'epicenter-doc-'));
		try {
			let id!: string;
			{
				const { data: disk, error } = await openBunStore({ directory });
				if (error !== null) throw error;
				const { data: diskDb, error: bindError } = disk.bind(lens);
				if (bindError !== null) throw bindError;
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
			const { data: reopened, error } = await openBunStore({ directory });
			if (error !== null) throw error;
			const { data: db2, error: bindError } = reopened.bind(lens);
			if (bindError !== null) throw bindError;
			const container = db2.notes.document(id);
			expect(container?.get('editor', 'text').toString()).toContain('buy milk');
			expect(container?.get('meta').getAttr('cursor' as never)).toBe(8);
			await reopened[Symbol.asyncDispose]();
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
				const { data: laptop, error: openError } = await openBunStore({
					directory,
				});
				if (openError !== null) throw openError;
				laptop.bind(lens);
				expect(laptop.applyRemote(second).error).toBeNull();
				expect(laptop.hasUnresolvedDependencies()).toBe(true);
				await laptop[Symbol.asyncDispose]();
			}
			const { data: reopened, error: reopenError } = await openBunStore({
				directory,
			});
			if (reopenError !== null) throw reopenError;
			const { data: db2, error: bindError } = reopened.bind(lens);
			if (bindError !== null) throw bindError;
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
