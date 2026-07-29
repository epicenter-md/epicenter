import type {
	NonconformingRowError,
	RowFor,
	TableDefinition,
	TableInvalidation,
	TableLens,
} from '@epicenter/data';
import { createSubscriber } from 'svelte/reactivity';

export type ReadonlyTableView<TDefinition extends TableDefinition> = {
	readonly all: readonly RowFor<TDefinition>[];
	readonly nonconforming: readonly NonconformingRowError[];
	readonly loadError: unknown;
	readonly whenReady: Promise<void>;
	byId(id: string): RowFor<TDefinition> | undefined;
	refresh(): Promise<void>;
};

/**
 * Create a reactive classified view over one bound Data table lens.
 *
 * This is where the row ids in a `rows` invalidation are actually spent. A
 * caller that only wants correctness can ignore the payload entirely and
 * rescan; this adapter exists so the common case does not have to. A commit
 * that touched three rows of a ten thousand row table re-reads three rows.
 *
 * There is deliberately no size threshold that flips point-reads back into a
 * full scan. A threshold would be a number nobody can defend without measuring
 * one workload and then applying it to every other, and the honest fallback is
 * already free: table scope rescans, and so does anything the point-read path
 * could not interpret.
 *
 * Work is drained through one serialized loop, so an invalidation that arrives
 * while a scan is in flight is applied after it rather than racing it, and a
 * table-scope invalidation collapses every row id still waiting: it already
 * says everything reachable here may be stale.
 */
export function fromTable<TDefinition extends TableDefinition>(
	table: TableLens<TDefinition>,
): ReadonlyTableView<TDefinition> {
	let rows = $state.raw<RowFor<TDefinition>[]>([]);
	let nonconforming = $state.raw<NonconformingRowError[]>([]);
	let loadError = $state.raw<unknown>(null);

	let pendingRowIds: Set<string> | undefined;
	let pendingRescan = false;
	let draining: Promise<void> | undefined;

	/** Rows in stable row-ID order, which is the order `scan()` promises. */
	function sortById(next: RowFor<TDefinition>[]): RowFor<TDefinition>[] {
		return next.sort((left, right) => (left.id < right.id ? -1 : 1));
	}

	async function rescan(): Promise<void> {
		const { rows: nextRows, nonconforming: nextNonconforming } =
			await table.scan();
		rows = nextRows;
		nonconforming = nextNonconforming;
		loadError = null;
	}

	/**
	 * Re-read exactly the named rows.
	 *
	 * A read that answers `undefined` is a row that is no longer live, so it
	 * leaves both buckets. A read that answers a nonconforming row moves it into
	 * the second bucket rather than dropping it, which is the same classification
	 * `scan()` performs and the reason this adapter can stay incremental without
	 * quietly losing the rows a Lens cannot interpret.
	 *
	 * Anything else is operational: storage or transport failed and this pass
	 * cannot say what the table holds. Rather than guess, it asks for a rescan,
	 * which is always allowed because invalidation is a superset.
	 */
	async function applyRowIds(rowIds: Set<string>): Promise<void> {
		const byId = new Map(rows.map((row) => [row.id, row]));
		const badById = new Map(
			nonconforming.map((issue) => [issue.id, issue] as const),
		);
		for (const id of rowIds) {
			const result = await table.get(id);
			if (result.error !== null) {
				if (result.error.name !== 'NonconformingRow') throw result.error;
				byId.delete(id);
				badById.set(id, result.error);
				continue;
			}
			badById.delete(id);
			if (result.data === undefined) byId.delete(id);
			else byId.set(id, result.data);
		}
		rows = sortById([...byId.values()]);
		nonconforming = [...badById.values()];
		loadError = null;
	}

	function drain(): Promise<void> {
		draining ??= (async () => {
			try {
				while (pendingRescan || pendingRowIds !== undefined) {
					if (pendingRescan) {
						pendingRescan = false;
						pendingRowIds = undefined;
						await rescan();
						continue;
					}
					const rowIds = pendingRowIds;
					pendingRowIds = undefined;
					if (rowIds === undefined) continue;
					try {
						await applyRowIds(rowIds);
					} catch {
						// The point-read path could not answer. Fall back rather than
						// report: the caller asked for the table's contents, not for
						// this adapter's opinion about one read.
						pendingRescan = true;
					}
				}
			} catch (cause) {
				loadError = cause;
				throw cause;
			} finally {
				draining = undefined;
			}
		})();
		return draining;
	}

	function requestRescan(): Promise<void> {
		pendingRescan = true;
		pendingRowIds = undefined;
		return drain();
	}

	function requestRowIds(rowIds: readonly string[]): Promise<void> {
		if (!pendingRescan) {
			pendingRowIds ??= new Set();
			for (const id of rowIds) pendingRowIds.add(id);
		}
		return drain();
	}

	function apply(invalidation: TableInvalidation): Promise<void> {
		return invalidation.scope === 'table'
			? requestRescan()
			: requestRowIds(invalidation.rowIds);
	}

	const subscribe = createSubscriber((update) =>
		table.subscribe((invalidation) => {
			void apply(invalidation).then(update, update);
		}),
	);
	const whenReady = requestRescan();

	return {
		get all() {
			subscribe();
			return rows;
		},
		get nonconforming() {
			subscribe();
			return nonconforming;
		},
		get loadError() {
			subscribe();
			return loadError;
		},
		whenReady,
		byId(id: string) {
			subscribe();
			return rows.find((row) => row.id === id);
		},
		refresh: requestRescan,
	};
}
