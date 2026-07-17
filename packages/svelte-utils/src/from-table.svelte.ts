import type {
	BaseRow,
	ReadonlyTable,
	TableNewerWriterError,
	TableParseError,
} from '@epicenter/workspace';
import { createSubscriber } from 'svelte/reactivity';

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
 *
 * @deprecated Removed with the Yjs record table after app migration. The
 * canonical SQLite runtime's tables are asynchronous and need their own
 * adapter (owned by the first migrating app's cutover).
 */
export function fromTable<TRow extends BaseRow>(
	table: ReadonlyTable<TRow>,
): ReadonlyTableView<TRow> {
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
