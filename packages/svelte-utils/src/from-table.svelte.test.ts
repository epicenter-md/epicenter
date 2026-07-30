import { expect, mock, test } from 'bun:test';

type SubscriberControl = {
	activate(): void;
	deactivate(): void;
};

const subscriberControls: SubscriberControl[] = [];

/**
 * `createSubscriber` installs its subscription only from inside a Svelte
 * effect, and these are plain bun tests with no reactive runtime. Substituting
 * it with its activation and teardown lifecycle lets the invalidation path and
 * dormant-cache behavior be exercised without reshaping the adapter around the
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
		// These tests read getters imperatively, outside a Svelte effect. The real
		// createSubscriber is also a no-op for those reads; tests activate the
		// simulated effect explicitly through this control.
		return () => {};
	},
}));

import {
	DataReadError,
	defineTable,
	type NonconformingRowError,
	type RowFor,
	type TableInvalidation,
	type TableLens,
} from '@epicenter/data';
import { field } from '@epicenter/field';
import { fromTable } from './from-table.svelte.js';

/**
 * Data table Svelte adapter tests.
 *
 * Key behaviors:
 * - Initial refresh classifies conforming and nonconforming rows
 * - Observation starts before each scan, including initial readiness
 * - Reactivation discards a dormant cache and rescans
 * - Row invalidations update only the rows they name
 */

(globalThis as unknown as { $state: unknown }).$state = Object.assign(
	<TValue>(value: TValue) => value,
	{ raw: <TValue>(value: TValue) => value },
);

/**
 * Invalidation is handled asynchronously, so a test that wants to assert on the
 * result waits for the adapter's queue to drain. A timer turn flushes every
 * microtask the mock table can produce.
 */
const settle = () => Bun.sleep(1);

async function activateLatestSubscriber(): Promise<SubscriberControl> {
	const subscriber = subscriberControls.at(-1);
	if (subscriber === undefined) throw new Error('No subscriber was created');
	subscriber.activate();
	await settle();
	return subscriber;
}

const definition = defineTable({
	fields: { name: field.string() },
});
type Row = RowFor<typeof definition>;

type StoredEntry =
	| { kind: 'row'; row: Row }
	| { kind: 'error'; error: NonconformingRowError };

const row = (id: string, name = id): StoredEntry => ({
	kind: 'row',
	row: { id, name },
});

const nonconforming = (id: string): StoredEntry => ({
	kind: 'error',
	error: DataReadError.NonconformingRow({
		address: {
			kind: 'row',
			namespace: 'so.epicenter.test.svelte',
			tableName: 'rows',
			rowId: id,
		},
		raw: {},
		issues: [{ field: 'name', kind: 'missing', message: 'required' }],
	}).error,
});

function createMockTable() {
	const store = new Map<string, StoredEntry>();
	const listeners = new Set<(invalidation: TableInvalidation) => void>();
	const reads = { scans: 0, gets: [] as string[] };
	let getFailure: unknown;
	let heldScan:
		| { readonly promise: Promise<void>; readonly release: () => void }
		| undefined;

	const table = {
		async scan() {
			reads.scans += 1;
			const snapshot = [...store.entries()].sort(([left], [right]) =>
				left < right ? -1 : 1,
			);
			const gate = heldScan;
			heldScan = undefined;
			await gate?.promise;
			const scan = {
				rows: [] as Row[],
				nonconforming: [] as NonconformingRowError[],
			};
			for (const [, entry] of snapshot) {
				if (entry.kind === 'row') scan.rows.push(entry.row);
				else scan.nonconforming.push(entry.error);
			}
			return scan;
		},
		async get(id: string) {
			reads.gets.push(id);
			if (getFailure !== undefined) return { data: null, error: getFailure };
			const entry = store.get(id);
			if (entry === undefined) return { data: undefined, error: null };
			return entry.kind === 'row'
				? { data: entry.row, error: null }
				: { data: null, error: entry.error };
		},
		subscribe(listener: (invalidation: TableInvalidation) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	} as unknown as TableLens<typeof definition>;

	return {
		table,
		store,
		reads,
		failGetsWith(error: unknown) {
			getFailure = error;
		},
		holdNextScan() {
			let release = () => {};
			const promise = new Promise<void>((resolve) => {
				release = resolve;
			});
			heldScan = { promise, release };
			return release;
		},
		invalidate(invalidation: TableInvalidation) {
			for (const listener of listeners) listener(invalidation);
		},
	};
}

test('initial refresh classifies conforming and nonconforming rows', async () => {
	const { table, store } = createMockTable();
	store.set('ok', row('ok'));
	store.set('bad', nonconforming('bad'));

	const entries = fromTable(table);
	await entries.whenReady;

	expect(entries.all.map((r) => r.id)).toEqual(['ok']);
	expect(entries.nonconforming.map((e) => e.id)).toEqual(['bad']);
});

test('initial scan observes a mutation that lands while the scan is in flight', async () => {
	const mock = createMockTable();
	mock.store.set('a', row('a', 'Before'));
	const releaseScan = mock.holdNextScan();

	const entries = fromTable(mock.table);
	mock.store.set('a', row('a', 'After'));
	mock.invalidate({ scope: 'rows', rowIds: ['a'] });
	releaseScan();
	await entries.whenReady;

	expect(entries.byId('a')?.name).toBe('After');
	expect(mock.reads.scans).toBe(1);
	expect(mock.reads.gets).toEqual(['a']);
});

test('reactivation clears a dormant cache and rescans before exposing rows', async () => {
	const mock = createMockTable();
	mock.store.set('a', row('a', 'Before'));
	const entries = fromTable(mock.table);
	await entries.whenReady;
	expect(entries.all.map((entry) => entry.name)).toEqual(['Before']);
	const subscriber = subscriberControls.at(-1);
	expect(subscriber).toBeDefined();

	subscriber?.activate();
	await settle();
	subscriber?.deactivate();
	mock.store.set('a', row('a', 'After'));
	const releaseScan = mock.holdNextScan();
	subscriber?.activate();

	expect(entries.all).toEqual([]);
	releaseScan();
	await settle();
	expect(entries.all.map((entry) => entry.name)).toEqual(['After']);
	expect(mock.reads.scans).toBe(3);
});

test('explicit refresh updates classified and point-read surfaces', async () => {
	const { table, store } = createMockTable();
	const entries = fromTable(table);
	await entries.whenReady;
	expect(entries.all).toEqual([]);

	store.set('a', row('a', 'Ada'));
	await entries.refresh();
	expect(entries.byId('a')?.name).toBe('Ada');
	expect(entries.all.map((r) => r.id)).toEqual(['a']);

	store.delete('a');
	await entries.refresh();
	expect(entries.byId('a')).toBeUndefined();
	expect(entries.all).toEqual([]);
});

test('a rows invalidation re-reads only the rows it names', async () => {
	const mock = createMockTable();
	mock.store.set('a', row('a', 'Ada'));
	mock.store.set('b', row('b', 'Bo'));
	const entries = fromTable(mock.table);
	await entries.whenReady;
	await activateLatestSubscriber();
	expect(entries.all.map((r) => r.id)).toEqual(['a', 'b']);
	expect(mock.reads.scans).toBe(2);

	mock.store.set('b', row('b', 'Bea'));
	mock.invalidate({ scope: 'rows', rowIds: ['b'] });
	await settle();

	expect(mock.reads.scans).toBe(2);
	expect(mock.reads.gets).toEqual(['b']);
	expect(entries.byId('b')?.name).toBe('Bea');
	expect(entries.all.map((r) => r.id)).toEqual(['a', 'b']);
});

test('a rows invalidation removes a row that is no longer live', async () => {
	const mock = createMockTable();
	mock.store.set('a', row('a'));
	mock.store.set('b', row('b'));
	const entries = fromTable(mock.table);
	await entries.whenReady;
	await activateLatestSubscriber();

	mock.store.delete('a');
	mock.invalidate({ scope: 'rows', rowIds: ['a'] });
	await settle();

	expect(entries.all.map((r) => r.id)).toEqual(['b']);
	expect(entries.byId('a')).toBeUndefined();
});

test('a rows invalidation moves a newly nonconforming row into its bucket', async () => {
	const mock = createMockTable();
	mock.store.set('a', row('a'));
	const entries = fromTable(mock.table);
	await entries.whenReady;
	await activateLatestSubscriber();

	mock.store.set('a', nonconforming('a'));
	mock.invalidate({ scope: 'rows', rowIds: ['a'] });
	await settle();

	expect(entries.all).toEqual([]);
	expect(entries.nonconforming.map((issue) => issue.id)).toEqual(['a']);

	// And back again, without a scan.
	mock.store.set('a', row('a', 'Recovered'));
	mock.invalidate({ scope: 'rows', rowIds: ['a'] });
	await settle();
	expect(entries.nonconforming).toEqual([]);
	expect(entries.byId('a')?.name).toBe('Recovered');
	expect(mock.reads.scans).toBe(2);
});

test('a table invalidation rescans and supersedes waiting row ids', async () => {
	const mock = createMockTable();
	mock.store.set('a', row('a'));
	const entries = fromTable(mock.table);
	await entries.whenReady;
	await activateLatestSubscriber();
	mock.reads.gets.length = 0;

	mock.store.set('c', row('c'));
	mock.invalidate({ scope: 'rows', rowIds: ['a'] });
	mock.invalidate({ scope: 'table' });
	await settle();

	expect(mock.reads.scans).toBe(3);
	expect(entries.all.map((r) => r.id)).toEqual(['a', 'c']);
});

test('an unreadable point read falls back to a rescan', async () => {
	const mock = createMockTable();
	mock.store.set('a', row('a'));
	const entries = fromTable(mock.table);
	await entries.whenReady;
	await activateLatestSubscriber();

	mock.failGetsWith({ name: 'ReplicaUnavailable', message: 'storage gone' });
	mock.store.set('b', row('b'));
	mock.invalidate({ scope: 'rows', rowIds: ['b'] });
	await settle();

	// The read could not answer, so the view asked the question it can always
	// ask instead of reporting a failure the caller cannot act on.
	expect(mock.reads.scans).toBe(3);
	expect(entries.all.map((r) => r.id)).toEqual(['a', 'b']);
	expect(entries.loadError).toBeNull();
});
