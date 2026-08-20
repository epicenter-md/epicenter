import { expect, mock, test } from 'bun:test';

type SubscriberControl = {
	activate(): void;
	deactivate(): void;
};

const subscriberControls: SubscriberControl[] = [];

/**
 * `createSubscriber` installs its subscription only from inside a Svelte
 * effect, and these are plain bun tests with no reactive runtime. Substituting
 * it with its activation and teardown lifecycle lets the live-snapshot and
 * dormant-read behavior be exercised without reshaping the adapter around the
 * test.
 */
mock.module('svelte/reactivity', () => ({
	createSubscriber(start: (update: () => void) => () => void) {
		let stop: (() => void) | undefined;
		const control = {
			activate() {
				stop ??= start(() => {});
			},
			deactivate() {
				stop?.();
				stop = undefined;
			},
		};
		subscriberControls.push(control);
		// These tests read getters imperatively, outside a Svelte effect. The
		// real createSubscriber is also a no-op for those reads; tests activate
		// the simulated effect explicitly through this control.
		return () => {};
	},
}));

import { fromData } from './from-data.svelte.js';

/**
 * An in-memory stand-in for one store table handle: the same closure-object
 * shape the engine freezes, with counters so a test can see which underlying
 * verbs a read actually paid for.
 */
function createFakeTable<TRow extends { id: string }>(seed: TRow[]) {
	const rows = new Map<string, TRow>(seed.map((row) => [row.id, row]));
	const listeners = new Set<() => void>();
	const calls = { list: 0, subscribe: 0 };
	return {
		calls,
		handle: {
			create(fields: Omit<TRow, 'id'>) {
				const row = { id: `row-${rows.size + 1}`, ...fields } as TRow;
				rows.set(row.id, row);
				for (const listener of listeners) listener();
				return row;
			},
			get(rowId: string) {
				return { data: rows.get(rowId), error: null };
			},
			update(rowId: string, fields: Partial<TRow>) {
				const row = rows.get(rowId);
				if (row === undefined) return { data: null, error: { rowId } };
				rows.set(rowId, { ...row, ...fields });
				for (const listener of listeners) listener();
				return { data: undefined, error: null };
			},
			delete(rowId: string) {
				const removed = rows.delete(rowId);
				if (removed) for (const listener of listeners) listener();
				return removed;
			},
			ids() {
				return [...rows.keys()].sort();
			},
			list() {
				calls.list += 1;
				return { rows: [...rows.values()], nonconforming: [] };
			},
			document(rowId: string) {
				return rows.has(rowId) ? { get: () => rowId } : undefined;
			},
			subscribe(listener: () => void) {
				calls.subscribe += 1;
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		},
	};
}

function createFakeKv<TValues>(initial: TValues) {
	let value = initial;
	const listeners = new Set<() => void>();
	return {
		set(next: TValues) {
			value = next;
			for (const listener of listeners) listener();
		},
		handle: {
			get() {
				return { data: value, error: null };
			},
			update(fields: Partial<TValues>) {
				value = { ...value, ...fields };
				for (const listener of listeners) listener();
			},
			subscribe(listener: () => void) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		},
	};
}

type Note = { id: string; title: string };
type Folder = { id: string; name: string };

function setup() {
	subscriberControls.length = 0;
	const notes = createFakeTable<Note>([{ id: 'n1', title: 'first' }]);
	const folders = createFakeTable<Folder>([]);
	const kv = createFakeKv({ theme: 'dark' });
	const reactive = fromData({
		tables: { notes: notes.handle, folders: folders.handle },
		kv: kv.handle,
	});
	// One subscriber per table plus one for kv, created in declaration order.
	const [notesControl, foldersControl] = subscriberControls;
	if (notesControl === undefined || foldersControl === undefined)
		throw new Error('expected one subscriber control per table');
	return { notes, folders, kv, reactive, notesControl, foldersControl };
}

test('mirrors the declared table names and preserves their row types', () => {
	const { reactive } = setup();
	expect(Object.keys(reactive.tables).sort()).toEqual(['folders', 'notes']);
	// Compile-time: the mapped type keeps each table's own row type.
	const rows: Note[] = reactive.tables.notes.rows;
	expect(rows[0]?.title).toBe('first');
	const folderRows: Folder[] = reactive.tables.folders.rows;
	expect(folderRows).toEqual([]);
});

test('wrapping subscribes to nothing and reads nothing', () => {
	const { notes, folders } = setup();
	expect(notes.calls.subscribe).toBe(0);
	expect(folders.calls.subscribe).toBe(0);
	expect(notes.calls.list).toBe(0);
});

test('every read is a fresh walk, never a cached copy', () => {
	const { notes, reactive } = setup();
	expect(reactive.tables.notes.rows).toHaveLength(1);
	notes.handle.create({ title: 'second' });
	expect(reactive.tables.notes.rows).toHaveLength(2);
	expect(notes.calls.list).toBe(2);
	expect(notes.calls.subscribe).toBe(0);
});

test('an observed table still reads through on every access', () => {
	const { notes, reactive, notesControl } = setup();
	notesControl.activate();
	expect(notes.calls.subscribe).toBe(1);

	// No snapshot even while observed: the store's public `onCommitted` phase
	// runs before table invalidations, so a reader in that phase must see the
	// committed rows, which only a read-through guarantees.
	expect(reactive.tables.notes.rows).toHaveLength(1);
	notes.handle.create({ title: 'second' });
	expect(reactive.tables.notes.rows).toHaveLength(2);
	expect(notes.calls.list).toBe(2);

	notesControl.deactivate();
	expect(reactive.tables.notes.rows).toHaveLength(2);
	expect(notes.calls.list).toBe(3);
});

test('write verbs pass through to the underlying handle', () => {
	const { notes, reactive } = setup();
	const table = reactive.tables.notes;
	const created = table.create({ title: 'made' });
	expect(created.title).toBe('made');
	expect(table.update(created.id, { title: 'renamed' }).error).toBeNull();
	expect(notes.handle.get(created.id).data?.title).toBe('renamed');
	expect(table.delete(created.id)).toBe(true);
	expect(table.delete(created.id)).toBe(false);
});

test('point reads pass through and answer from current data', () => {
	const { reactive } = setup();
	const table = reactive.tables.notes;
	expect(table.get('n1').data?.title).toBe('first');
	expect(table.get('absent').data).toBeUndefined();
	expect(table.ids()).toEqual(['n1']);
	expect(table.document('n1')).toBeDefined();
	expect(table.document('absent')).toBeUndefined();
});

test('kv get passes through and reflects writes', () => {
	const { kv, reactive } = setup();
	expect(reactive.kv.get().data).toEqual({ theme: 'dark' });
	kv.set({ theme: 'light' });
	expect(reactive.kv.get().data).toEqual({ theme: 'light' });
	reactive.kv.update({ theme: 'dark' });
	expect(reactive.kv.get().data).toEqual({ theme: 'dark' });
});
