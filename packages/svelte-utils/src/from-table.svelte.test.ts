import { expect, test } from 'bun:test';
import type {
	BaseRow,
	ReadonlyTable,
	TableReadError,
} from '@epicenter/workspace';
import { TableNewerWriterError, TableParseError } from '@epicenter/workspace';
import {
	type AsyncTable,
	asyncWorkspaceHandle,
	type TableCommitDelta,
} from '@epicenter/workspace/sqlite';
import { Err, Ok } from 'wellcrafted/result';
import { fromTable, type ObservableTable } from './from-table.svelte.js';

// `bun test` runs `.svelte.ts` modules without the Svelte compiler, so the runes
// the source uses are plain globals here. `$derived.by` is stubbed as a proxy
// that re-invokes the compute function on every property read, which models the
// pull-based recompute a live `$derived` does and lets the list surfaces reflect
// the current table state. `createSubscriber` is the real import; outside an
// effect its `subscribe()` is a no-op (it never attaches an observer), so the
// observe-driven lifecycle is not exercised here. That lifecycle belongs to
// Svelte and is covered by Svelte's own tests; what these tests pin is the
// stateless read-through: that every surface reads live through the table and
// classifies each id into rows or the right issue bucket.
(globalThis as unknown as { $derived: unknown }).$derived = Object.assign(
	<T>(v: T) => v,
	{
		by: <TValue extends object>(fn: () => TValue): TValue =>
			new Proxy(Array.isArray(fn()) ? [] : {}, {
				get: (_target, prop) => Reflect.get(fn(), prop),
				ownKeys: () => Reflect.ownKeys(fn()),
				getOwnPropertyDescriptor: (_target, prop) =>
					Reflect.getOwnPropertyDescriptor(fn(), prop),
			}) as TValue,
	},
);

type Row = BaseRow & { name: string };

type StoredEntry =
	| { kind: 'row'; row: Row }
	| { kind: 'error'; error: TableReadError };

const row = (id: string, name = id): StoredEntry => ({
	kind: 'row',
	row: { id, _v: 1, name } as Row,
});

const nonconforming = (id: string): StoredEntry => ({
	kind: 'error',
	error: TableParseError.ValidationFailed({
		id,
		errors: [{ path: '/name', message: 'required' }],
		row: {},
	}).error,
});

const newerWriter = (id: string): StoredEntry => ({
	kind: 'error',
	error: TableNewerWriterError.NewerWriter({
		id,
		version: 9,
		latestVersion: 1,
		row: {},
	}).error,
});

/**
 * A `ReadonlyTable` standing on a plain Map. `fromTable` only ever calls
 * `scan()`, `observe()`, and `get()`, so the rest throws to fail loud if the
 * contract widens. The view reads live, so mutating `store` then reading a
 * surface plays the role of a write landing.
 */
function createMockTable() {
	const store = new Map<string, StoredEntry>();

	const table = {
		scan() {
			const scan = {
				rows: [] as Row[],
				nonconforming: [] as TableParseError[],
				newerWriter: [] as TableNewerWriterError[],
			};
			for (const entry of store.values()) {
				if (entry.kind === 'row') {
					scan.rows.push(entry.row);
				} else if (entry.error.name === 'NewerWriter') {
					scan.newerWriter.push(entry.error);
				} else {
					scan.nonconforming.push(entry.error);
				}
			}
			return scan;
		},
		get(id: string) {
			const entry = store.get(id);
			if (!entry) return Ok(null);
			return entry.kind === 'row' ? Ok(entry.row) : Err(entry.error);
		},
		observe() {
			// Outside an effect `createSubscriber` never calls this; the lifecycle
			// is Svelte's to drive. Return a no-op unobserve for completeness.
			return () => {};
		},
	} as unknown as ReadonlyTable<Row>;

	return { table, store };
}

test('all + buckets: scan routes conforming rows and each issue bucket', () => {
	const { table, store } = createMockTable();
	store.set('ok', row('ok'));
	store.set('bad', nonconforming('bad'));
	store.set('ahead', newerWriter('ahead'));

	const entries = fromTable(table);

	expect(entries.all.map((r) => r.id)).toEqual(['ok']);
	expect(entries.nonconforming.map((e) => e.id)).toEqual(['bad']);
	expect(entries.newerWriter.map((e) => e.id)).toEqual(['ahead']);
});

test('byId: conforming id resolves; unreadable and absent ids do not', () => {
	const { table, store } = createMockTable();
	store.set('ok', row('ok', 'Ada'));
	store.set('bad', nonconforming('bad'));

	const entries = fromTable(table);

	expect(entries.byId('ok')?.name).toBe('Ada');

	// A stored-but-unreadable id does not resolve to a row; it surfaces in the
	// issue bucket instead.
	expect(entries.byId('bad')).toBeUndefined();
	expect(entries.nonconforming.map((e) => e.id)).toEqual(['bad']);

	// An absent id resolves to undefined and is in no bucket.
	expect(entries.byId('missing')).toBeUndefined();
});

test('reads are live: surfaces reflect the current table state', () => {
	const { table, store } = createMockTable();
	const entries = fromTable(table);
	expect(entries.all).toEqual([]);

	store.set('a', row('a', 'Ada'));
	expect(entries.byId('a')?.name).toBe('Ada');
	expect(entries.all.map((r) => r.id)).toEqual(['a']);

	store.delete('a');
	expect(entries.byId('a')).toBeUndefined();
	expect(entries.all).toEqual([]);
});

test('reads are live across every classification transition', () => {
	const { table, store } = createMockTable();
	const entries = fromTable(table);

	// row -> nonconforming -> newerWriter -> row, each visible on the next read.
	store.set('a', row('a'));
	expect(entries.byId('a')).toBeDefined();

	store.set('a', nonconforming('a'));
	expect(entries.byId('a')).toBeUndefined();
	expect(entries.nonconforming.map((e) => e.id)).toEqual(['a']);

	store.set('a', newerWriter('a'));
	expect(entries.byId('a')).toBeUndefined();
	expect(entries.newerWriter.map((e) => e.id)).toEqual(['a']);

	store.set('a', row('a', 'fixed'));
	expect(entries.byId('a')?.name).toBe('fixed');
	expect(entries.newerWriter).toEqual([]);
});

test('SQLite table view reads list and point values without legacy issue buckets', () => {
	type SqliteRow = { id: string; name: string };
	const store = new Map<string, SqliteRow>();
	const table: ObservableTable<SqliteRow> = {
		get: (id) => store.get(id) ?? null,
		list: () => [...store.values()],
		observe: () => () => {},
	};
	const entries = fromTable(table);

	expect(entries.all).toEqual([]);
	store.set('a', { id: 'a', name: 'Ada' });
	expect(entries.all).toEqual([{ id: 'a', name: 'Ada' }]);
	expect(entries.byId('a')?.name).toBe('Ada');
	expect(entries.byId('missing')).toBeUndefined();
	expect('nonconforming' in entries).toBeFalse();
	expect('newerWriter' in entries).toBeFalse();
});

test('async SQLite table view hydrates once, then applies committed deltas', async () => {
	type SqliteRow = { id: string; name: string };
	let resolveSnapshot!: (rows: SqliteRow[]) => void;
	const snapshot = new Promise<SqliteRow[]>((resolve) => {
		resolveSnapshot = resolve;
	});
	let observer: ((delta: TableCommitDelta) => void) | undefined;
	let listCalls = 0;
	let unobserved = false;
	const table = {
		[asyncWorkspaceHandle]: 'table',
		list() {
			listCalls += 1;
			observer?.({
				upserted: [
					{ id: 'a', name: 'committed' },
					{ id: 'b', name: 'Bee' },
				],
				removed: [],
			});
			return snapshot;
		},
		observe(callback: (delta: TableCommitDelta) => void) {
			observer = callback;
			return () => {
				unobserved = true;
			};
		},
	} as unknown as AsyncTable<SqliteRow>;

	const entries = fromTable(table);
	resolveSnapshot([{ id: 'a', name: 'snapshot' }]);
	await entries.whenReady;

	expect(listCalls).toBe(1);
	expect(entries.all).toEqual([
		{ id: 'a', name: 'committed' },
		{ id: 'b', name: 'Bee' },
	]);
	expect(entries.byId('a')?.name).toBe('committed');

	observer?.({
		upserted: [{ id: 'c', name: 'Cee' }],
		removed: ['a'],
	});
	expect(entries.all).toEqual([
		{ id: 'b', name: 'Bee' },
		{ id: 'c', name: 'Cee' },
	]);
	expect(entries.byId('a')).toBeUndefined();
	expect(listCalls).toBe(1);

	entries[Symbol.dispose]();
	expect(unobserved).toBeTrue();
});
