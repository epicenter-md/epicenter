/**
 * # YRowStore - Row Operations Wrapper over CellStore
 *
 * Provides row reconstruction, row-level writes (merge), batch operations,
 * row deletion, and row-level observation.
 * Does NOT store anything itself - delegates to the underlying CellStore.
 *
 * ## Design Principles
 *
 * - Composition over features: Takes a CellStore as its only argument
 * - No setCell/deleteCell: Cell writes go through CellStore directly
 * - merge() for row-level writes: Clear semantics — merges fields, creates if missing
 * - Row operations use an in-memory row index kept in sync via cellStore.observe()
 *
 * @example
 * ```typescript
 * import { createCellStore } from './y-cell-store.js';
 * import { createRowStore } from './y-row-store.js';
 *
 * const cells = createCellStore<unknown>(ydoc, 'table:posts');
 * const rows = createRowStore(cells);
 *
 * // Merge fields into a row (creates if missing, updates if present)
 * rows.merge('post-1', { title: 'Hello World', views: 0 });
 *
 * // Batch row operations (atomic, single observer notification)
 * rows.batch((tx) => {
 *   tx.merge('post-1', { title: 'Updated', views: 1 });
 *   tx.merge('post-2', { title: 'New Post' });
 *   tx.delete('post-3');
 * });
 *
 * // Read via rows (reconstructed)
 * const post = rows.get('post-1');
 * // { title: 'Updated', views: 1 }
 *
 * // Delete entire row
 * rows.delete('post-1');
 *
 * // Cell-level writes still go through CellStore
 * cells.setCell('post-2', 'draft', true);
 *
 * // Atomic mixed operations (Yjs transactions nest safely)
 * cells.doc.transact(() => {
 *   rows.merge('post-2', { title: 'Atomic' });
 *   cells.deleteCell('post-1', 'draft');
 *   rows.delete('post-3');
 * });
 * ```
 */
import type * as Y from 'yjs';
import type { CellStore } from './y-cell-store.js';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

/** Handler for row-level change notifications (deduplicated from cells). */
export type RowsChangedHandler = (
	changedRowIds: Set<string>,
	transaction: Y.Transaction,
) => void;

/** Operations available inside a row batch transaction. */
export type RowStoreBatchTransaction<T> = {
	/** Merge fields into a row. Only touches columns present in data. */
	merge(rowId: string, data: Record<string, T>): void;
	/** Delete all cells for a row. */
	delete(rowId: string): void;
};

/** Row operations wrapper over CellStore. */
export type RowStore<T> = {
	// ═══════════════════════════════════════════════════════════════════════
	// ROW READ
	// ═══════════════════════════════════════════════════════════════════════

	/**
	 * Reconstruct a row from its cells.
	 * Returns undefined if no cells exist for this row.
	 * O(k) where k = cells in the row.
	 */
	get(rowId: string): Record<string, T> | undefined;

	/** Check if any cells exist for a row. O(1). */
	has(rowId: string): boolean;

	/** Get all row IDs that have at least one cell. O(r) where r = number of rows. */
	ids(): string[];

	/** Get all rows reconstructed from cells. O(n) single pass. */
	getAll(): Map<string, Record<string, T>>;

	/** Number of unique rows. O(1). */
	count(): number;

	// ═══════════════════════════════════════════════════════════════════════
	// ROW WRITE
	// ═══════════════════════════════════════════════════════════════════════

	/**
	 * Merge fields into a row. Only sets columns present in data.
	 * Creates the row if it doesn't exist.
	 * Leaves unmentioned columns untouched.
	 */
	merge(rowId: string, data: Record<string, T>): void;

	// ═══════════════════════════════════════════════════════════════════════
	// ROW DELETE
	// ═══════════════════════════════════════════════════════════════════════

	/**
	 * Delete all cells for a row.
	 * Returns true if any cells existed.
	 * O(k) where k = cells in the row.
	 *
	 * **Note**: When called inside a `batch()`, the deletion is applied immediately
	 * but reads (`has`, `get`) will still see the old row until the batch completes.
	 * See `batch()` documentation for details and workarounds.
	 *
	 * @see {@link batch} for behavior inside transactions
	 */
	delete(rowId: string): boolean;

	// ═══════════════════════════════════════════════════════════════════════
	// BATCH
	// ═══════════════════════════════════════════════════════════════════════

	/**
	 * Execute multiple row operations atomically in a Y.js transaction.
	 *
	 * Benefits:
	 * - Single undo/redo step
	 * - Observers fire once (not per-operation)
	 * - Transaction has { merge, delete } — row-level operations only
	 *
	 * **Important**: Inside the batch callback, reads (`has`, `get`) may return
	 * stale state for rows deleted in the same batch. This is because the underlying
	 * cell store's CRDT observer only updates the internal cache when the transaction
	 * completes.
	 *
	 * @example
	 * ```typescript
	 * // ❌ Unexpected: has() returns true after delete
	 * rows.batch((tx) => {
	 *   tx.delete('row-1');
	 *   if (rows.has('row-1')) {
	 *     // This WILL execute! The row is marked for deletion but still
	 *     // appears to exist until the batch completes.
	 *     console.log('Still visible');
	 *   }
	 * });
	 *
	 * // ✅ After batch completes, reads are consistent
	 * rows.batch((tx) => {
	 *   tx.delete('row-1');
	 * });
	 * rows.has('row-1'); // false (correct)
	 * ```
	 *
	 * **Why does this happen?**
	 * RowStore delegates to CellStore, which uses a "pending + cache" architecture.
	 * The authoritative cache is only updated by a Yjs observer, which is deferred
	 * until the transaction ends. See CellStore's `batch()` documentation for details.
	 *
	 * **Workaround**: If you need to check deletion state inside a batch, track it manually:
	 * ```typescript
	 * const deleted = new Set<string>();
	 * rows.batch((tx) => {
	 *   tx.delete('row-1');
	 *   deleted.add('row-1');
	 *
	 *   if (!deleted.has('row-1') && rows.has('row-1')) {
	 *     // Safe: checks local tracking first
	 *   }
	 * });
	 * ```
	 *
	 * @see {@link CellStore.batch} for detailed explanation of the observer architecture
	 * @see {@link YKeyValueLww.delete} for technical details on deferred updates
	 */
	batch(fn: (tx: RowStoreBatchTransaction<T>) => void): void;

	// ═══════════════════════════════════════════════════════════════════════
	// OBSERVE
	// ═══════════════════════════════════════════════════════════════════════

	/**
	 * Watch for row-level changes (deduplicated from cell changes).
	 * Callback receives Set of row IDs that had any cell change.
	 * Returns unsubscribe function.
	 */
	observe(handler: RowsChangedHandler): () => void;
};

// ═══════════════════════════════════════════════════════════════════════════
// FACTORY FUNCTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create a row operations wrapper over an existing CellStore.
 *
 * ## In-Memory Row Index
 *
 * CellStore stores cells as flat compound keys (`rowId:columnId`) in a YKeyValueLww.
 * Without an index, every row operation requires an O(n) scan of all cells with
 * prefix matching. The row index groups cells by rowId for fast lookups:
 *
 * ```
 * CellStore (flat):                    Row Index (grouped):
 * ┌──────────────────────────┐         ┌─────────┬──────────────────┐
 * │ "post-1:title" → "Hello" │         │ "post-1"│ title → "Hello"  │
 * │ "post-1:views" → 42      │   ───►  │         │ views → 42       │
 * │ "post-2:title" → "World" │         ├─────────┼──────────────────┤
 * └──────────────────────────┘         │ "post-2"│ title → "World"  │
 *                                      └─────────┴──────────────────┘
 *
 * get("post-1"): O(n) scan  ───►  O(1) Map lookup
 * has("post-1"): O(n) scan  ───►  O(1) Map.has()
 * count():       O(n) dedup ───►  O(1) Map.size
 * ```
 *
 * The index follows the same "single-writer" architecture as YKeyValueLww's `map`:
 * - **Built once** at construction from `cellStore.cells()` (single pass)
 * - **Kept in sync** by an internal `cellStore.observe()` handler
 * - **Never written to directly** by methods — the observer is the sole writer
 * - **Lifetime** is tied to the CellStore (observer is never unsubscribed,
 *   matching how YKeyValueLww's observer lives as long as its Y.Array)
 *
 * @param cellStore - The CellStore to wrap
 */
export function createRowStore<T>(cellStore: CellStore<T>): RowStore<T> {
	const { doc } = cellStore;

	// Row index: Map<rowId, Map<columnId, value>>
	// Built from cellStore.cells(), kept in sync by observer below.
	const rowIndex = new Map<string, Map<string, T>>();

	for (const { rowId, columnId, value } of cellStore.cells()) {
		let row = rowIndex.get(rowId);
		if (!row) {
			row = new Map();
			rowIndex.set(rowId, row);
		}
		row.set(columnId, value);
	}

	// Observer: sole writer to rowIndex. Handles local writes, remote CRDT
	// sync, and deletes. Empty rows are removed to keep count()/has() accurate.
	cellStore.observe((changes) => {
		for (const change of changes) {
			switch (change.action) {
				case 'add':
				case 'update': {
					let row = rowIndex.get(change.rowId);
					if (!row) {
						row = new Map();
						rowIndex.set(change.rowId, row);
					}
					row.set(change.columnId, change.value);
					break;
				}
				case 'delete': {
					const row = rowIndex.get(change.rowId);
					if (row) {
						row.delete(change.columnId);
						if (row.size === 0) rowIndex.delete(change.rowId);
					}
					break;
				}
			}
		}
	});

	return {
		get(rowId) {
			const row = rowIndex.get(rowId);
			if (!row) return undefined;
			const cells: Record<string, T> = {};
			for (const [columnId, value] of row) {
				cells[columnId] = value;
			}
			return cells;
		},

		has(rowId) {
			return rowIndex.has(rowId);
		},

		ids() {
			return Array.from(rowIndex.keys());
		},

		getAll() {
			const rows = new Map<string, Record<string, T>>();
			for (const [rowId, columnMap] of rowIndex) {
				const cells: Record<string, T> = {};
				for (const [columnId, value] of columnMap) {
					cells[columnId] = value;
				}
				rows.set(rowId, cells);
			}
			return rows;
		},

		count() {
			return rowIndex.size;
		},

		merge(rowId, data) {
			doc.transact(() => {
				for (const [columnId, value] of Object.entries(data)) {
					cellStore.setCell(rowId, columnId, value);
				}
			});
		},

		delete(rowId) {
			const row = rowIndex.get(rowId);
			if (!row) return false;

			const columnIds = Array.from(row.keys());
			doc.transact(() => {
				for (const columnId of columnIds) {
					cellStore.deleteCell(rowId, columnId);
				}
			});

			return true;
		},

		batch(fn) {
			doc.transact(() => {
				fn({
					merge(rowId, data) {
						for (const [columnId, value] of Object.entries(data)) {
							cellStore.setCell(rowId, columnId, value);
						}
					},
					delete(rowId) {
						// Scan cellStore.cells() (includes pending writes from this batch)
						// so merge-then-delete in the same batch correctly removes new columns
						for (const cell of cellStore.cells()) {
							if (cell.rowId === rowId) {
								cellStore.deleteCell(rowId, cell.columnId);
							}
						}
					},
				});
			});
		},

		observe(handler) {
			return cellStore.observe((changes, transaction) => {
				const rowIds = new Set(changes.map((c) => c.rowId));
				if (rowIds.size > 0) {
					handler(rowIds, transaction);
				}
			});
		},
	};
}
