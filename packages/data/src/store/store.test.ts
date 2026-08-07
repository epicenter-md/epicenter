import { defineLens } from '@epicenter/lens/lens';
import { beforeEach, describe, expect, test } from 'bun:test';

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openBunStore, openMemoryStore } from './bun.js';
import type { Store } from './store.js';

const lens = defineLens({
	namespace: 'so.epicenter.honeycrisp',
	tables: {
		notes: { title: 'string', tags: 'string[]', date: 'string|null' },
		settings: { theme: "'light'|'dark' = 'light'", fontSize: 'number = 14' },
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

describe('a read is a property access on a plain object', () => {
	test('create returns the row it made', async () => {
		const { data: note, error } = await db.notes.create({
			title: 'Groceries',
			tags: ['food'],
			date: null,
		});
		expect(error).toBeNull();
		expect(note?.id).toBeString();
		expect(note?.title).toBe('Groceries');
		expect(note?.tags).toEqual(['food']);
	});

	test('an absent row reads as Ok(undefined), which is a fact not a failure', async () => {
		const { data, error } = await db.notes.get('nope');
		expect(error).toBeNull();
		expect(data).toBeUndefined();
	});

	test('a chosen id is how a singleton reaches one address', async () => {
		const { data, error } = await db.settings.ensure('app');
		expect(error).toBeNull();
		// Nothing was supplied, so every value here came from a declared default.
		expect(data).toEqual({ id: 'app', theme: 'light', fontSize: 14 });
	});

	test('ensure is get-or-create, not create-or-fail', async () => {
		await db.settings.ensure('app', { theme: 'dark' });
		const { data } = await db.settings.ensure('app');
		expect(data?.theme).toBe('dark');
	});
});

describe('a write that reaches nothing is a failure', () => {
	test('update on an absent row refuses instead of silently swallowing it', async () => {
		const { data, error } = await db.notes.update('nope', { title: 'x' });
		expect(data).toBeNull();
		// The verb this replaces returned Ok(undefined) and dropped the write.
		expect(error?.name).toBe('RowAbsent');
	});

	test('create refuses an occupied address', async () => {
		await db.settings.ensure('app');
		const { error } = await db.settings.create('app', {});
		expect(error?.name).toBe('RowExists');
	});

	test('an invalid supplied value refuses the call', async () => {
		const { data: note } = await db.notes.create({
			title: 'Groceries',
			tags: ['food'],
			date: null,
		});
		const { error } = await db.notes.update(note?.id ?? '', {
			tags: 'food' as never,
		});
		expect(error?.name).toBe('Nonconforming');
		// And touched no other field.
		const { data: after } = await db.notes.get(note?.id ?? '');
		expect(after?.title).toBe('Groceries');
		expect(after?.tags).toEqual(['food']);
	});
});

describe('deletion', () => {
	test('a deleted row reads as absent and leaves the projection', async () => {
		const { data: note } = await db.notes.create({
			title: 'Groceries',
			tags: ['food'],
			date: null,
		});
		const id = note?.id ?? '';
		expect((await db.notes.delete(id)).data).toBe(true);
		expect((await db.notes.get(id)).data).toBeUndefined();
		expect((await db.notes.ids()).data).toEqual([]);
		const { data: rows } = await db.query`SELECT id FROM notes`;
		expect(rows).toEqual([]);
	});

	test('deleting twice reports the second as a no-op', async () => {
		const { data: note } = await db.notes.create({
			title: 'x',
			tags: [],
			date: null,
		});
		const id = note?.id ?? '';
		expect((await db.notes.delete(id)).data).toBe(true);
		expect((await db.notes.delete(id)).data).toBe(false);
	});

	test('an address is reusable even though its content is not', async () => {
		await db.settings.ensure('app', { theme: 'dark' });
		await db.settings.delete('app');
		const { data } = await db.settings.ensure('app');
		// Back to the declared default: the previous content is gone from the CRDT.
		expect(data?.theme).toBe('light');
	});
});

describe('the projection is written in the same transaction as the log', () => {
	test('query sees a committed local write immediately', async () => {
		await db.notes.create('n1', {
			title: 'Groceries',
			tags: ['food'],
			date: null,
		});
		const { data: rows, error } = await db.query`
			SELECT id, title FROM notes WHERE id = ${'n1'}`;
		expect(error).toBeNull();
		expect(rows).toEqual([{ id: 'n1', title: 'Groceries' }]);
	});

	test('an array field is queryable through json_each', async () => {
		await db.notes.create('n1', {
			title: 'Groceries',
			tags: ['food', 'errands'],
			date: null,
		});
		await db.notes.create('n2', { title: 'Ideas', tags: ['work'], date: null });
		const { data: rows } = await db.query`
			SELECT id FROM notes
			WHERE EXISTS (SELECT 1 FROM json_each(notes.tags) WHERE value = ${'food'})`;
		expect(rows).toEqual([{ id: 'n1' }]);
	});

	test('a scalar binds natively, so equality works without quoting JSON', async () => {
		await db.settings.ensure('app', { fontSize: 18 });
		const { data: rows } = await db.query`
			SELECT id FROM settings WHERE fontSize = ${18}`;
		expect(rows).toEqual([{ id: 'app' }]);
	});
});

describe('a nonconforming row is reported, never repaired', () => {
	test('the call site composes recovery from defaults and what survived', async () => {
		await db.settings.ensure('app', { fontSize: 20 });
		// Corrupt the stored value the way a peer on a newer release could.
		const { data: rawDb, error: bindError } = store.bindUnknown({
			namespace: 'so.epicenter.honeycrisp',
			tables: { settings: { theme: 'string', fontSize: 'number' } },
		});
		if (bindError !== null) throw bindError;
		await rawDb.settings?.update('app', { theme: 'purple' });

		const { data, error } = await db.settings.get('app');
		expect(data).toBeNull();
		expect(error?.name).toBe('Nonconforming');

		const cfg = data ?? {
			...db.settings.defaults,
			...(error as { conforming?: object }).conforming,
		};
		expect(cfg).toEqual({ theme: 'light', fontSize: 20, id: 'app' });
	});

	test('list separates what it can read from what it cannot', async () => {
		await db.settings.ensure('app', { fontSize: 20 });
		await db.settings.ensure('other');
		const { data: rawDb } = store.bindUnknown({
			namespace: 'so.epicenter.honeycrisp',
			tables: { settings: { theme: 'string', fontSize: 'number' } },
		});
		await rawDb?.settings?.update('app', { theme: 'purple' });
		const { data } = await db.settings.list();
		expect(data?.rows.map((row) => row.id)).toEqual(['other']);
		expect(data?.nonconforming.map((issue) => issue.id)).toEqual(['app']);
	});
});

describe('two replicas converge', () => {
	test('a row made on one device appears on the other', async () => {
		const laptop = openMemoryStore();
		const { data: laptopDb, error } = laptop.bind(lens);
		if (error !== null) throw error;

		await db.notes.create('n1', {
			title: 'Recorded on the phone',
			tags: ['voice'],
			date: null,
		});
		laptop.applyRemote(store.encodeStateSince(laptop.stateVector()));

		const { data: note } = await laptopDb.notes.get('n1');
		expect(note?.title).toBe('Recorded on the phone');
		// And the laptop's projection was rebuilt, so SQL sees it too.
		const { data: rows } = await laptopDb.query`SELECT id, title FROM notes`;
		expect(rows).toEqual([{ id: 'n1', title: 'Recorded on the phone' }]);
	});

	test('offline edits to different fields of one row both survive', async () => {
		const laptop = openMemoryStore();
		const { data: laptopDb, error } = laptop.bind(lens);
		if (error !== null) throw error;
		await db.notes.create('n1', { title: 'first', tags: [], date: null });
		laptop.applyRemote(store.encodeStateSince(laptop.stateVector()));

		// Both go offline and edit different fields.
		await db.notes.update('n1', { title: 'phone title' });
		await laptopDb.notes.update('n1', { date: '2026-08-07' });

		// Then they meet.
		const phoneState = store.encodeStateSince(laptop.stateVector());
		const laptopState = laptop.encodeStateSince(store.stateVector());
		laptop.applyRemote(phoneState);
		store.applyRemote(laptopState);

		for (const [name, handle] of [
			['phone', db.notes],
			['laptop', laptopDb.notes],
		] as const) {
			const { data: note } = await handle.get('n1');
			expect(`${name}:${note?.title}`).toBe(`${name}:phone title`);
			expect(`${name}:${note?.date}`).toBe(`${name}:2026-08-07`);
		}
	});

	test('a delete on one device and an edit on the other converge', async () => {
		const laptop = openMemoryStore();
		const { data: laptopDb, error } = laptop.bind(lens);
		if (error !== null) throw error;
		await db.notes.create('n1', { title: 'first', tags: [], date: null });
		laptop.applyRemote(store.encodeStateSince(laptop.stateVector()));

		await db.notes.delete('n1');
		await laptopDb.notes.update('n1', { title: 'edited offline' });

		const phoneState = store.encodeStateSince(laptop.stateVector());
		const laptopState = laptop.encodeStateSince(store.stateVector());
		laptop.applyRemote(phoneState);
		store.applyRemote(laptopState);

		// Both land on the same answer, whatever it is: convergence is the claim,
		// and the tombstone is held rather than the edit resurrecting a corpse
		// only on one side.
		const phone = (await db.notes.get('n1')).data;
		const other = (await laptopDb.notes.get('n1')).data;
		expect(JSON.stringify(phone)).toBe(JSON.stringify(other));
	});
});

describe('the document a row inherently owns', () => {
	test('opens, holds application-named roots, and survives a reopen', async () => {
		await db.notes.create('n1', { title: 'x', tags: [], date: null });
		{
			const { data: document, error } = await db.notes.document.open('n1');
			if (error !== null) throw error;
			await using open = document;
			open.transact(() => {
				// The application names its root and picks its own shape; Epicenter
				// never learns either. In Yjs 14 a root needs a name to have a type,
				// `change` hands back a fresh builder every access, and `applyDelta`
				// is the door that commits it.
				const editor = open.get('editor', 'text');
				editor.applyDelta(editor.change.insert('buy milk'));
				open.get('meta').setAttr('cursor', 8);
			});
		}
		const { data: reopened, error } = await db.notes.document.open('n1');
		if (error !== null) throw error;
		await using open = reopened;
		// `toString()` wraps in `<text>` when the root was named before content
		// arrived and does not after a reload, so the content is what is asserted.
		expect(open.get('editor', 'text').toString()).toContain('buy milk');
		expect(open.get('meta').getAttr('cursor')).toBe(8);
	});

	test('a document cannot be opened for an absent row', async () => {
		const { error } = await db.notes.document.open('nope');
		expect(error?.name).toBe('RowAbsent');
	});
});

describe('a received update is persisted as the bytes that arrived', () => {
	test('an update whose dependencies are missing survives a RESTART', async () => {
		// The failure this guards: Yjs buffers an update it cannot integrate,
		// `applyUpdateV2` returns normally, and the document emits NO updateV2
		// event. Persisting emitted bytes writes nothing, so the bytes are lost
		// at restart while every layer reported success.
		//
		// The restart is the whole test. An in-memory store keeps the buffered
		// update in `pendingStructs` either way, so a test that never reopens
		// passes with the bug still in.
		const origin = openMemoryStore();
		const { data: originDb, error } = origin.bind(lens);
		if (error !== null) throw error;
		await originDb.notes.create('n1', { title: 'first', tags: [], date: null });
		const first = origin.encodeStateSince();
		const afterFirst = origin.stateVector();
		await originDb.notes.update('n1', { title: 'second' });
		const second = origin.encodeStateSince(afterFirst);

		const directory = await mkdtemp(join(tmpdir(), 'epicenter-store-'));
		try {
			{
				const { data: laptop, error: openError } = await openBunStore({
					directory,
				});
				if (openError !== null) throw openError;
				laptop.bind(lens);
				// Only the dependent half. Nothing can be applied yet.
				expect(laptop.applyRemote(second).error).toBeNull();
				expect(laptop.hasUnresolvedDependencies()).toBe(true);
				await laptop[Symbol.asyncDispose]();
			}
			// Restart. The buffered bytes must have reached durable storage.
			const { data: reopened, error: reopenError } = await openBunStore({
				directory,
			});
			if (reopenError !== null) throw reopenError;
			const { data: db2, error: bindError } = reopened.bind(lens);
			if (bindError !== null) throw bindError;
			expect(reopened.hasUnresolvedDependencies()).toBe(true);

			// The missing half arrives and the update that survived the restart
			// resolves against it.
			expect(reopened.applyRemote(first).error).toBeNull();
			expect(reopened.hasUnresolvedDependencies()).toBe(false);
			expect((await db2.notes.get('n1')).data?.title).toBe('second');
			await reopened[Symbol.asyncDispose]();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test('a fully applied replica reports no unresolved dependencies', async () => {
		await db.notes.create('n1', { title: 'x', tags: [], date: null });
		const laptop = openMemoryStore();
		laptop.bind(lens);
		laptop.applyRemote(store.encodeStateSince(laptop.stateVector()));
		expect(laptop.hasUnresolvedDependencies()).toBe(false);
	});
});
