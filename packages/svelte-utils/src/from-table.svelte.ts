import type {
	BaseRow,
	ReadonlyTable,
	TableNewerWriterError,
	TableParseError,
} from '@epicenter/workspace';
import { createSubscriber } from 'svelte/reactivity';

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
	table: ObservableTable<TRow>,
): TableView<TRow>;
/** @deprecated Removed with the Yjs record table after app migration. */
export function fromTable<TRow extends BaseRow>(
	table: ReadonlyTable<TRow>,
): ReadonlyTableView<TRow>;
export function fromTable<TRow extends BaseRow>(
	table: ObservableTable<TRow> | ReadonlyTable<TRow>,
): TableView<TRow> | ReadonlyTableView<TRow> {
	if ('list' in table) {
		const subscribe = createSubscriber((update) =>
			table.observe(() => update()),
		);
		const listed = $derived.by(() => {
			subscribe();
			return table.list();
		});

		return {
			get all() {
				return listed;
			},
			byId(id: TRow['id']): TRow | undefined {
				subscribe();
				return table.get(id) ?? undefined;
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
