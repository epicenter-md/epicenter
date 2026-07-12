import type {
	BaseRow,
	ReadonlyTable,
	TableNewerWriterError,
	TableParseError,
} from '@epicenter/workspace';
import {
	type AsyncTable,
	asyncWorkspaceHandle,
	type TableCommitDelta,
} from '@epicenter/workspace/sqlite';
import { createSubscriber, SvelteMap } from 'svelte/reactivity';

/** The read and invalidation surface exposed by SQLite workspace tables. */
export type ObservableTable<TRow extends { id: string }> = {
	get(id: TRow['id']): TRow | null;
	list(): readonly TRow[];
	observe(callback: (changedIds: ReadonlySet<TRow['id']>) => void): () => void;
};

/** A reactive view over rows that conform to one exact workspace schema. */
export type TableView<TRow extends { id: string }> = {
	readonly all: readonly TRow[];
	byId(id: TRow['id']): TRow | undefined;
};

/**
 * A synchronous UI projection of an async authoritative table.
 *
 * Await `whenReady` before reading the initial snapshot. Later committed
 * deltas update `all` and `byId` reactively without rescanning the database.
 * The projection is disposable cache state, never a durable mirror.
 */
export type AsyncTableView<TRow extends { id: string }> = TableView<TRow> & {
	readonly whenReady: Promise<void>;
	[Symbol.dispose](): void;
};

/**
 * A read-only reactive view of a workspace table: the conforming rows plus the
 * table's two issue buckets, all driven by one `observe()` subscription.
 *
 * The view holds no state. Every surface reads live through the table, so it can
 * never disagree with storage and there is nothing to dispose. Reads inside an
 * effect (a component, a `$derived`) re-run when the table changes; reads outside
 * one return the current value without subscribing.
 */
export type ReadonlyTableView<TRow extends BaseRow> = {
	/**
	 * Every conforming row, recomputed once per change. The array is the view's
	 * memoized scan, shared between reads, so the type is `readonly`: mutating it
	 * (e.g. `.sort()`) in place would corrupt that shared value and is a compile
	 * error. Take a copy first, e.g. `all.toSorted(...)`.
	 */
	readonly all: readonly TRow[];
	/** Stored entries this binary should understand but cannot parse. */
	readonly nonconforming: readonly TableParseError[];
	/** Stored entries written by a newer binary than this one. */
	readonly newerWriter: readonly TableNewerWriterError[];
	/** A single conforming row by id, or `undefined` if absent or unreadable. */
	byId(id: string): TRow | undefined;
};

/**
 * Create a read-only reactive view of an exact-schema workspace table.
 *
 * The view reads through the table instead of maintaining a second row mirror.
 * Its one ref-counted subscription invalidates both the memoized list and point
 * reads after local writes, remote pulls, snapshots, and imports.
 */
export function fromTable<TRow extends { id: string }>(
	table: AsyncTable<TRow>,
): AsyncTableView<TRow>;
export function fromTable<TRow extends { id: string }>(
	table: ObservableTable<TRow>,
): TableView<TRow>;
/** @deprecated Removed with the Yjs record table after app migration. */
export function fromTable<TRow extends BaseRow>(
	table: ReadonlyTable<TRow>,
): ReadonlyTableView<TRow>;
export function fromTable<TRow extends BaseRow>(
	table: AsyncTable<TRow> | ObservableTable<TRow> | ReadonlyTable<TRow>,
): AsyncTableView<TRow> | TableView<TRow> | ReadonlyTableView<TRow> {
	if (asyncWorkspaceHandle in table) {
		return createAsyncTableView(table as AsyncTable<TRow>);
	}
	if ('list' in table) {
		const subscribe = createSubscriber((update) =>
			(table as ObservableTable<TRow>).observe(() => update()),
		);
		const listed = $derived.by(() => {
			subscribe();
			return (table as ObservableTable<TRow>).list();
		});

		return {
			get all() {
				return listed;
			},
			byId(id: TRow['id']): TRow | undefined {
				subscribe();
				return (table as ObservableTable<TRow>).get(id) ?? undefined;
			},
		};
	}

	const subscribe = createSubscriber((update) => table.observe(update));
	// One scan feeds every list surface and recomputes once per change. Reading
	// `scanned` is what registers the dependency, so the list getters need no
	// separate `subscribe()` call.
	const scanned = $derived.by(() => {
		subscribe();
		return table.scan();
	});

	return {
		get all() {
			return scanned.rows;
		},
		get nonconforming() {
			return scanned.nonconforming;
		},
		get newerWriter() {
			return scanned.newerWriter;
		},
		byId(id: string): TRow | undefined {
			subscribe();
			return table.get(id).data ?? undefined;
		},
	};
}

function createAsyncTableView<TRow extends { id: string }>(
	table: AsyncTable<TRow>,
): AsyncTableView<TRow> {
	const rows = new SvelteMap<TRow['id'], TRow>();
	const pendingDeltas: TableCommitDelta<TRow>[] = [];
	let isHydrated = false;
	let isDisposed = false;

	function apply(delta: TableCommitDelta<TRow>) {
		for (const id of delta.removed) rows.delete(id as TRow['id']);
		for (const row of delta.upserted) rows.set(row.id, row);
	}

	const unobserve = table.observe((delta) => {
		if (isDisposed) return;
		if (!isHydrated) {
			pendingDeltas.push(delta);
			return;
		}
		apply(delta);
	});
	const initialRows = table.list();

	function dispose() {
		if (isDisposed) return;
		isDisposed = true;
		pendingDeltas.length = 0;
		unobserve();
	}

	const whenReady = initialRows.then(
		(snapshot) => {
			if (isDisposed) return;
			for (const row of snapshot) rows.set(row.id, row);
			for (const delta of pendingDeltas) apply(delta);
			pendingDeltas.length = 0;
			isHydrated = true;
		},
		(error: unknown) => {
			dispose();
			throw error;
		},
	);

	return {
		whenReady,
		get all() {
			return [...rows.values()];
		},
		byId(id) {
			return rows.get(id);
		},
		[Symbol.dispose]: dispose,
	};
}
