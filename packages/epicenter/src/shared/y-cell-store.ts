/**
 * # YCellStore - Schema-agnostic Sparse Grid Storage
 *
 * A pure cell primitive that stores cells with compound keys `rowId:columnId`.
 * Built on top of YKeyValueLww for CRDT conflict resolution.
 *
 * ## Key Format
 *
 * - Cell key: `rowId:columnId`
 * - `rowId` MUST NOT contain `:` (throws error)
 * - `columnId` MAY contain `:` (separator is first occurrence only)
 *
 * ## Design Principles
 *
 * - Schema decoupled: No validation, pure storage primitive
 * - Single responsibility: Only handles cell operations
 * - Escape hatches: Exposes `ykv` and `doc` for advanced use
 *
 * @example
 * ```typescript
 * import { createCellStore } from './y-cell-store.js';
 *
 * const cells = createCellStore<unknown>(ydoc, 'table:posts');
 *
 * cells.setCell('row-1', 'title', 'Hello');
 * cells.setCell('row-1', 'views', 42);
 * cells.getCell('row-1', 'title'); // 'Hello'
 *
 * // Batch operations (atomic, single observer notification)
 * cells.batch((tx) => {
 *   tx.setCell('row-1', 'title', 'Updated');
 *   tx.setCell('row-2', 'title', 'New Row');
 *   tx.deleteCell('row-1', 'views');
 * });
 * ```
 */
import type * as Y from 'yjs';
import { CellKey, parseCellKey } from './cell-keys.js';
import {
	YKeyValueLww,
	type YKeyValueLwwChange,
	type YKeyValueLwwEntry,
} from './y-keyvalue/y-keyvalue-lww.js';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

/** A single cell's location and value. */
export type Cell<T> = {
	rowId: string;
	columnId: string;
	value: T;
};

/** Change event for a single cell. */
export type CellChange<T> =
	| { action: 'add'; rowId: string; columnId: string; value: T }
	| {
			action: 'update';
			rowId: string;
			columnId: string;
			oldValue: T;
			value: T;
	  }
	| { action: 'delete'; rowId: string; columnId: string; oldValue: T };

/** Handler for cell change events. */
export type CellChangeHandler<T> = (
	changes: CellChange<T>[],
	transaction: Y.Transaction,
) => void;

/** Operations available inside a batch transaction. */
export type CellStoreBatchTransaction<T> = {
	setCell(rowId: string, columnId: string, value: T): void;
	deleteCell(rowId: string, columnId: string): void;
};

/** Pure cell-level storage primitive. */
export type CellStore<T> = {
	// ═══════════════════════════════════════════════════════════════════════
	// CELL CRUD
	// ═══════════════════════════════════════════════════════════════════════

	/** Set a single cell value. */
	setCell(rowId: string, columnId: string, value: T): void;

	/** Get a single cell value. Returns undefined if not found. */
	getCell(rowId: string, columnId: string): T | undefined;

	/** Check if a cell exists. */
	hasCell(rowId: string, columnId: string): boolean;

	/**
	 * Delete a single cell. Returns true if existed.
	 *
	 * **Note**: When called inside a `batch()`, the deletion is applied immediately
	 * but reads (`hasCell`, `getCell`) will still see the old value until the batch
	 * completes. See `batch()` documentation for details and workarounds.
	 *
	 * @see {@link batch} for behavior inside transactions
	 */
	deleteCell(rowId: string, columnId: string): boolean;

	// ═══════════════════════════════════════════════════════════════════════
	// BATCH
	// ═══════════════════════════════════════════════════════════════════════

	/**
	 * Execute multiple operations atomically in a Y.js transaction.
	 *
	 * Benefits:
	 * - Single undo/redo step
	 * - Observers fire once (not per-operation)
	 * - All changes applied together
	 *
	 * **Important**: Inside the batch callback, reads (`hasCell`, `getCell`) may return
	 * stale state for cells deleted in the same batch. This is because the underlying
	 * CRDT observer only updates the internal cache when the transaction completes.
	 *
	 * @example
	 * ```typescript
	 * // ❌ Unexpected: hasCell returns true after delete
	 * cells.batch((tx) => {
	 *   tx.deleteCell('row-1', 'status');
	 *   if (cells.hasCell('row-1', 'status')) {
	 *     // This WILL execute! The cell is marked for deletion but still
	 *     // appears to exist until the batch completes.
	 *     console.log('Still visible');
	 *   }
	 * });
	 *
	 * // ✅ After batch completes, reads are consistent
	 * cells.batch((tx) => {
	 *   tx.deleteCell('row-1', 'status');
	 * });
	 * cells.hasCell('row-1', 'status'); // false (correct)
	 * ```
	 *
	 * **Why does this happen?**
	 * The store uses a "pending + cache" architecture where the authoritative cache
	 * is only updated by a Yjs observer. During a transaction, the observer is
	 * deferred until the transaction ends. Newly-written cells are visible immediately
	 * via a `pending` buffer, but deleted cells remain in the cache until the observer
	 * processes them.
	 *
	 * **Workaround**: If you need to check deletion state inside a batch, track it manually:
	 * ```typescript
	 * const deleted = new Set<string>();
	 * cells.batch((tx) => {
	 *   const key = 'row-1:status';
	 *   tx.deleteCell('row-1', 'status');
	 *   deleted.add(key);
	 *
	 *   if (!deleted.has(key) && cells.hasCell('row-1', 'status')) {
	 *     // Safe: checks local tracking first
	 *   }
	 * });
	 * ```
	 *
	 * @see {@link YKeyValueLww.delete} for technical details on the observer architecture
	 */
	batch(fn: (tx: CellStoreBatchTransaction<T>) => void): void;

	// ═══════════════════════════════════════════════════════════════════════
	// ITERATION & METADATA
	// ═══════════════════════════════════════════════════════════════════════

	/** Iterate all cells with parsed components. */
	cells(): IterableIterator<Cell<T>>;

	/** Total number of cells. */
	count(): number;

	/** Delete all cells. */
	clear(): void;

	// ═══════════════════════════════════════════════════════════════════════
	// OBSERVE
	// ═══════════════════════════════════════════════════════════════════════

	/** Watch for cell changes. Returns unsubscribe function. */
	observe(handler: CellChangeHandler<T>): () => void;

	// ═══════════════════════════════════════════════════════════════════════
	// ESCAPE HATCH
	// ═══════════════════════════════════════════════════════════════════════

	/** The underlying YKeyValueLww for advanced use cases. */
	readonly ykv: YKeyValueLww<T>;

	/** The Y.Doc for transaction control. */
	readonly doc: Y.Doc;
};

// ═══════════════════════════════════════════════════════════════════════════
// FACTORY FUNCTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create a schema-agnostic cell store backed by YKeyValueLww.
 *
 * @param ydoc - The Y.Doc to store data in
 * @param arrayKey - The key name for the Y.Array (e.g., 'table:posts')
 */
export function createCellStore<T>(
	ydoc: Y.Doc,
	arrayKey: string,
): CellStore<T> {
	const yarray = ydoc.getArray<YKeyValueLwwEntry<T>>(arrayKey);
	const ykv = new YKeyValueLww<T>(yarray);

	return {
		setCell(rowId, columnId, value) {
			ykv.set(CellKey(rowId, columnId), value);
		},

		getCell(rowId, columnId) {
			return ykv.get(CellKey(rowId, columnId));
		},

		hasCell(rowId, columnId) {
			return ykv.has(CellKey(rowId, columnId));
		},

		deleteCell(rowId, columnId) {
			const key = CellKey(rowId, columnId);
			if (!ykv.has(key)) return false;
			ykv.delete(key);
			return true;
		},

		batch(fn) {
			ydoc.transact(() => {
				fn({
					setCell: (rowId, columnId, value) =>
						ykv.set(CellKey(rowId, columnId), value),
					deleteCell: (rowId, columnId) => ykv.delete(CellKey(rowId, columnId)),
				});
			});
		},

		*cells() {
			for (const [key, entry] of ykv.entries()) {
				const { rowId, columnId } = parseCellKey(key);
				yield { rowId, columnId, value: entry.val };
			}
		},

		count() {
			return ykv.map.size;
		},

		clear() {
			const keys = Array.from(ykv.map.keys());
			ydoc.transact(() => {
				for (const key of keys) {
					ykv.delete(key);
				}
			});
		},

		observe(handler) {
			const ykvHandler = (
				changes: Map<string, YKeyValueLwwChange<T>>,
				transaction: Y.Transaction,
			) => {
				const cellChanges: CellChange<T>[] = [];

				for (const [key, change] of changes) {
					const { rowId, columnId } = parseCellKey(key);

					switch (change.action) {
						case 'add':
							cellChanges.push({
								action: 'add',
								rowId,
								columnId,
								value: change.newValue,
							});
							break;
						case 'update':
							cellChanges.push({
								action: 'update',
								rowId,
								columnId,
								oldValue: change.oldValue,
								value: change.newValue,
							});
							break;
						case 'delete':
							cellChanges.push({
								action: 'delete',
								rowId,
								columnId,
								oldValue: change.oldValue,
							});
							break;
					}
				}

				if (cellChanges.length > 0) {
					handler(cellChanges, transaction);
				}
			};

			ykv.observe(ykvHandler);
			return () => ykv.unobserve(ykvHandler);
		},

		ykv,
		doc: ydoc,
	};
}
