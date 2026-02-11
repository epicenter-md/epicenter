/**
 * YRowStore Tests - Row Operations Wrapper over CellStore
 *
 * Tests cover:
 * 1. Row reconstruction: get() assembles cells correctly
 * 2. Row existence: has() returns true only if cells exist
 * 3. Row IDs: ids() returns deduplicated list
 * 4. Get all rows: getAll() reconstructs all rows
 * 5. Row count: count() matches unique row count
 * 6. Row deletion: delete() removes all cells for row
 * 7. Merge: merge() sets multiple cells, creates rows, preserves unmentioned columns
 * 8. Batch operations: batch() executes merge + delete atomically
 * 9. Atomic operations via doc.transact(): mixed cell/row ops in single transaction
 * 10. Observe dedupe: observe() fires with Set of changed row IDs
 * 11. Sparse rows: rows with different columns work correctly
 * 12. Column IDs with colons
 * 13. CRDT sync between documents
 */
import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { createCellStore } from './y-cell-store';
import { createRowStore } from './y-row-store';

describe('YRowStore', () => {
	describe('Row Reconstruction', () => {
		test('get() assembles cells into a row object', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<unknown>(ydoc, 'cells');
			const rows = createRowStore(cells);

			cells.batch((tx) => {
				tx.setCell('row-1', 'title', 'Hello');
				tx.setCell('row-1', 'views', 42);
				tx.setCell('row-1', 'published', true);
			});

			const row = rows.get('row-1');
			expect(row).toEqual({
				title: 'Hello',
				views: 42,
				published: true,
			});
		});

		test('get() returns undefined for non-existent row', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');
			const rows = createRowStore(cells);

			expect(rows.get('non-existent')).toBeUndefined();
		});

		test('get() returns undefined after row is deleted', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');
			const rows = createRowStore(cells);

			cells.setCell('row-1', 'title', 'Hello');
			rows.delete('row-1');

			expect(rows.get('row-1')).toBeUndefined();
		});
	});

	describe('Row Existence', () => {
		test('has() returns true when row has cells', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');
			const rows = createRowStore(cells);

			cells.setCell('row-1', 'title', 'Hello');
			expect(rows.has('row-1')).toBe(true);
		});

		test('has() returns false for non-existent row', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');
			const rows = createRowStore(cells);

			expect(rows.has('non-existent')).toBe(false);
		});

		test('has() returns false after row is deleted', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');
			const rows = createRowStore(cells);

			cells.setCell('row-1', 'title', 'Hello');
			rows.delete('row-1');

			expect(rows.has('row-1')).toBe(false);
		});

		test('has() early-exits on first cell found', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');
			const rows = createRowStore(cells);

			// Add many cells for row-1
			cells.batch((tx) => {
				for (let i = 0; i < 100; i++) {
					tx.setCell('row-1', `col-${i}`, `value-${i}`);
				}
			});

			// has() should find the first cell and return true without scanning all
			expect(rows.has('row-1')).toBe(true);
		});

		test('has() does not false-match on rowId prefix substring', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');
			const rows = createRowStore(cells);

			// "ab" exists, but "a" does not - they are distinct rows
			cells.setCell('ab', 'title', 'Hello');

			expect(rows.has('ab')).toBe(true);
			expect(rows.has('a')).toBe(false); // "a" is prefix of "ab" but not a match
		});

		test('get() does not include cells from prefix-matching rows', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');
			const rows = createRowStore(cells);

			cells.setCell('a', 'col1', 'value-a');
			cells.setCell('ab', 'col1', 'value-ab');

			expect(rows.get('a')).toEqual({ col1: 'value-a' });
			expect(rows.get('ab')).toEqual({ col1: 'value-ab' });

			// Deleting 'a' should NOT affect 'ab'
			rows.delete('a');
			expect(rows.has('a')).toBe(false);
			expect(rows.has('ab')).toBe(true);
			expect(rows.get('ab')).toEqual({ col1: 'value-ab' });
		});
	});

	describe('Row IDs', () => {
		test('ids() returns all unique row IDs', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');
			const rows = createRowStore(cells);

			cells.batch((tx) => {
				tx.setCell('row-1', 'title', 'Hello');
				tx.setCell('row-2', 'title', 'World');
				tx.setCell('row-3', 'title', 'Test');
			});

			const ids = rows.ids();
			expect(ids.sort()).toEqual(['row-1', 'row-2', 'row-3']);
		});

		test('ids() returns deduplicated list', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');
			const rows = createRowStore(cells);

			// Multiple cells for same row
			cells.batch((tx) => {
				tx.setCell('row-1', 'a', '1');
				tx.setCell('row-1', 'b', '2');
				tx.setCell('row-1', 'c', '3');
			});

			const ids = rows.ids();
			expect(ids).toEqual(['row-1']);
		});

		test('ids() returns empty array for empty store', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');
			const rows = createRowStore(cells);

			expect(rows.ids()).toEqual([]);
		});
	});

	describe('Get All Rows', () => {
		test('getAll() reconstructs all rows', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<unknown>(ydoc, 'cells');
			const rows = createRowStore(cells);

			cells.batch((tx) => {
				tx.setCell('row-1', 'title', 'First');
				tx.setCell('row-1', 'views', 10);
				tx.setCell('row-2', 'title', 'Second');
				tx.setCell('row-2', 'views', 20);
			});

			const allRows = rows.getAll();

			expect(allRows.size).toBe(2);
			expect(allRows.get('row-1')).toEqual({ title: 'First', views: 10 });
			expect(allRows.get('row-2')).toEqual({ title: 'Second', views: 20 });
		});

		test('getAll() returns empty Map for empty store', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');
			const rows = createRowStore(cells);

			expect(rows.getAll().size).toBe(0);
		});
	});

	describe('Row Count', () => {
		test('count() returns number of unique rows', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');
			const rows = createRowStore(cells);

			cells.batch((tx) => {
				tx.setCell('row-1', 'a', '1');
				tx.setCell('row-1', 'b', '2');
				tx.setCell('row-2', 'a', '3');
				tx.setCell('row-3', 'a', '4');
			});

			expect(rows.count()).toBe(3);
		});

		test('count() returns 0 for empty store', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');
			const rows = createRowStore(cells);

			expect(rows.count()).toBe(0);
		});

		test('count() decreases after row deletion', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');
			const rows = createRowStore(cells);

			cells.batch((tx) => {
				tx.setCell('row-1', 'title', 'First');
				tx.setCell('row-2', 'title', 'Second');
			});

			expect(rows.count()).toBe(2);

			rows.delete('row-1');

			expect(rows.count()).toBe(1);
		});
	});

	describe('Row Deletion', () => {
		test('delete() removes all cells for a row', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');
			const rows = createRowStore(cells);

			cells.batch((tx) => {
				tx.setCell('row-1', 'title', 'Hello');
				tx.setCell('row-1', 'views', '42');
				tx.setCell('row-1', 'published', 'true');
			});

			const result = rows.delete('row-1');

			expect(result).toBe(true);
			expect(rows.has('row-1')).toBe(false);
			expect(cells.hasCell('row-1', 'title')).toBe(false);
			expect(cells.hasCell('row-1', 'views')).toBe(false);
			expect(cells.hasCell('row-1', 'published')).toBe(false);
		});

		test('delete() returns false for non-existent row', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');
			const rows = createRowStore(cells);

			const result = rows.delete('non-existent');
			expect(result).toBe(false);
		});

		test('delete() does not affect other rows', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');
			const rows = createRowStore(cells);

			cells.batch((tx) => {
				tx.setCell('row-1', 'title', 'First');
				tx.setCell('row-2', 'title', 'Second');
			});

			rows.delete('row-1');

			expect(rows.has('row-1')).toBe(false);
			expect(rows.has('row-2')).toBe(true);
			expect(rows.get('row-2')).toEqual({ title: 'Second' });
		});

		test('delete() fires single observer notification', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');
			const rows = createRowStore(cells);

			cells.batch((tx) => {
				tx.setCell('row-1', 'a', '1');
				tx.setCell('row-1', 'b', '2');
				tx.setCell('row-1', 'c', '3');
			});

			let callCount = 0;
			rows.observe(() => {
				callCount++;
			});

			rows.delete('row-1');

			expect(callCount).toBe(1);
		});
	});

	describe('Merge', () => {
		test('merge() sets multiple cells for a row', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<unknown>(ydoc, 'cells');
			const rows = createRowStore(cells);

			rows.merge('row-1', { title: 'Hello', views: '42' });

			expect(rows.get('row-1')).toEqual({ title: 'Hello', views: '42' });
		});

		test("merge() creates a new row if it doesn't exist", () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');
			const rows = createRowStore(cells);

			expect(rows.has('row-1')).toBe(false);

			rows.merge('row-1', { title: 'Created' });

			expect(rows.has('row-1')).toBe(true);
			expect(rows.get('row-1')).toEqual({ title: 'Created' });
		});

		test('merge() preserves unmentioned columns', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');
			const rows = createRowStore(cells);

			rows.merge('row-1', { a: '1', b: '2' });
			rows.merge('row-1', { b: '3', c: '4' });

			expect(rows.get('row-1')).toEqual({ a: '1', b: '3', c: '4' });
		});

		test('merge() fires single observer notification', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');
			const rows = createRowStore(cells);

			let callCount = 0;
			rows.observe(() => {
				callCount++;
			});

			rows.merge('row-1', { a: '1', b: '2', c: '3' });

			expect(callCount).toBe(1);
		});

		test('merge() with empty object is a no-op', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');
			const rows = createRowStore(cells);

			let callCount = 0;
			rows.observe(() => {
				callCount++;
			});

			rows.merge('row-1', {});

			expect(callCount).toBe(0);
			expect(rows.has('row-1')).toBe(false);
		});
	});

	describe('Batch Operations', () => {
		test('batch merge sets cells atomically', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');
			const rows = createRowStore(cells);

			rows.batch((tx) => {
				tx.merge('row-1', { title: 'First', views: '10' });
				tx.merge('row-2', { title: 'Second', views: '20' });
			});

			expect(rows.get('row-1')).toEqual({ title: 'First', views: '10' });
			expect(rows.get('row-2')).toEqual({ title: 'Second', views: '20' });
		});

		test('batch fires single observer notification', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');
			const rows = createRowStore(cells);

			let callCount = 0;
			rows.observe(() => {
				callCount++;
			});

			rows.batch((tx) => {
				tx.merge('row-1', { a: '1' });
				tx.merge('row-2', { b: '2' });
				tx.merge('row-3', { c: '3' });
			});

			expect(callCount).toBe(1);
		});

		test('batch observer receives all changed row IDs', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');
			const rows = createRowStore(cells);

			const changedRows: string[][] = [];
			rows.observe((rowIds) => {
				changedRows.push(Array.from(rowIds).sort());
			});

			rows.batch((tx) => {
				tx.merge('row-1', { a: '1' });
				tx.merge('row-2', { b: '2' });
			});

			expect(changedRows).toHaveLength(1);
			expect(changedRows[0]).toEqual(['row-1', 'row-2']);
		});

		test('batch merge and delete in single transaction', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');
			const rows = createRowStore(cells);

			rows.merge('row-1', { title: 'Delete Me' });

			const changedRows: string[][] = [];
			rows.observe((rowIds) => {
				changedRows.push(Array.from(rowIds).sort());
			});

			rows.batch((tx) => {
				tx.merge('row-2', { title: 'New' });
				tx.delete('row-1');
			});

			expect(changedRows).toHaveLength(1);
			expect(changedRows[0]).toEqual(['row-1', 'row-2']);
			expect(rows.has('row-1')).toBe(false);
			expect(rows.get('row-2')).toEqual({ title: 'New' });
		});

		test('batch delete after merge removes newly-added columns', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');
			const rows = createRowStore(cells);

			rows.merge('row-1', { existing: 'val' });

			rows.batch((tx) => {
				tx.merge('row-1', { newCol: 'added' });
				tx.delete('row-1');
			});

			expect(rows.has('row-1')).toBe(false);
			expect(rows.get('row-1')).toBeUndefined();
		});

		test('batch delete of non-existent row is a no-op', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');
			const rows = createRowStore(cells);

			rows.merge('row-1', { title: 'Keep' });

			rows.batch((tx) => {
				tx.delete('non-existent');
			});

			expect(rows.get('row-1')).toEqual({ title: 'Keep' });
		});

		test('batch with empty callback is a no-op', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');
			const rows = createRowStore(cells);

			let callCount = 0;
			rows.observe(() => {
				callCount++;
			});

			rows.batch(() => {});

			expect(callCount).toBe(0);
		});
	});

	describe('Atomic Operations via doc.transact()', () => {
		test('doc.transact() groups multiple row deletes into single observer notification', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');
			const rows = createRowStore(cells);

			cells.batch((tx) => {
				tx.setCell('row-1', 'a', '1');
				tx.setCell('row-2', 'a', '2');
				tx.setCell('row-3', 'a', '3');
			});

			const changedRows: string[][] = [];
			rows.observe((rowIds) => {
				changedRows.push(Array.from(rowIds).sort());
			});

			cells.doc.transact(() => {
				rows.delete('row-1');
				rows.delete('row-3');
			});

			expect(changedRows).toHaveLength(1);
			expect(changedRows[0]).toEqual(['row-1', 'row-3']);
		});

		test('doc.transact() combines cell writes and row deletes atomically', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');
			const rows = createRowStore(cells);

			cells.batch((tx) => {
				tx.setCell('row-1', 'title', 'First');
			});

			const changedRows: string[][] = [];
			rows.observe((rowIds) => {
				changedRows.push(Array.from(rowIds).sort());
			});

			cells.doc.transact(() => {
				cells.setCell('row-2', 'title', 'Second');
				rows.delete('row-1');
			});

			expect(changedRows).toHaveLength(1);
			expect(changedRows[0]).toEqual(['row-1', 'row-2']);
			expect(rows.has('row-1')).toBe(false);
			expect(rows.get('row-2')).toEqual({ title: 'Second' });
		});
	});

	describe('Observe', () => {
		test('observe() fires with Set of changed row IDs', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');
			const rows = createRowStore(cells);

			const changedRows: string[][] = [];
			rows.observe((rowIds) => {
				changedRows.push(Array.from(rowIds).sort());
			});

			cells.batch((tx) => {
				tx.setCell('row-1', 'a', '1');
				tx.setCell('row-2', 'b', '2');
			});

			expect(changedRows).toEqual([['row-1', 'row-2']]);
		});

		test('observe() deduplicates changes to same row', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');
			const rows = createRowStore(cells);

			const changedRows: string[][] = [];
			rows.observe((rowIds) => {
				changedRows.push(Array.from(rowIds));
			});

			// Multiple changes to same row
			cells.batch((tx) => {
				tx.setCell('row-1', 'a', '1');
				tx.setCell('row-1', 'b', '2');
				tx.setCell('row-1', 'c', '3');
			});

			// Should only have row-1 once
			expect(changedRows).toEqual([['row-1']]);
		});

		test('unsubscribe stops receiving events', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');
			const rows = createRowStore(cells);

			let callCount = 0;
			const unsubscribe = rows.observe(() => {
				callCount++;
			});

			cells.setCell('row-1', 'title', 'Hello');
			expect(callCount).toBe(1);

			unsubscribe();

			cells.setCell('row-1', 'title', 'World');
			expect(callCount).toBe(1); // Still 1
		});
	});

	describe('Sparse Rows', () => {
		test('rows can have different columns', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<unknown>(ydoc, 'cells');
			const rows = createRowStore(cells);

			cells.batch((tx) => {
				// row-1 has title and views
				tx.setCell('row-1', 'title', 'First');
				tx.setCell('row-1', 'views', 10);

				// row-2 has title and author
				tx.setCell('row-2', 'title', 'Second');
				tx.setCell('row-2', 'author', 'Alice');
			});

			expect(rows.get('row-1')).toEqual({ title: 'First', views: 10 });
			expect(rows.get('row-2')).toEqual({ title: 'Second', author: 'Alice' });
		});

		test('deleting some cells makes row sparse but still exists', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');
			const rows = createRowStore(cells);

			cells.batch((tx) => {
				tx.setCell('row-1', 'title', 'Hello');
				tx.setCell('row-1', 'views', '42');
			});

			cells.deleteCell('row-1', 'views');

			expect(rows.has('row-1')).toBe(true);
			expect(rows.get('row-1')).toEqual({ title: 'Hello' });
		});
	});

	describe('Column ID with Colons', () => {
		test('handles column IDs containing colons', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');
			const rows = createRowStore(cells);

			cells.setCell('row-1', 'nested:column:id', 'value');

			const row = rows.get('row-1');
			expect(row).toEqual({ 'nested:column:id': 'value' });
		});
	});

	describe('Row Index Consistency', () => {
		test('row index is correct when RowStore wraps pre-populated CellStore', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');

			// Populate BEFORE creating RowStore
			cells.batch((tx) => {
				tx.setCell('row-1', 'title', 'First');
				tx.setCell('row-2', 'title', 'Second');
				tx.setCell('row-2', 'author', 'Alice');
			});

			const rows = createRowStore(cells);

			expect(rows.count()).toBe(2);
			expect(rows.has('row-1')).toBe(true);
			expect(rows.has('row-2')).toBe(true);
			expect(rows.get('row-1')).toEqual({ title: 'First' });
			expect(rows.get('row-2')).toEqual({ title: 'Second', author: 'Alice' });
		});

		test('row index updates when individual cell is deleted via CellStore', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');
			const rows = createRowStore(cells);

			cells.batch((tx) => {
				tx.setCell('row-1', 'title', 'Hello');
				tx.setCell('row-1', 'views', '42');
			});

			expect(rows.count()).toBe(1);

			// Delete one cell — row should still exist
			cells.deleteCell('row-1', 'views');
			expect(rows.has('row-1')).toBe(true);
			expect(rows.get('row-1')).toEqual({ title: 'Hello' });

			// Delete remaining cell — row should disappear
			cells.deleteCell('row-1', 'title');
			expect(rows.has('row-1')).toBe(false);
			expect(rows.count()).toBe(0);
		});

		test('row index reflects updated cell values', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');
			const rows = createRowStore(cells);

			cells.setCell('row-1', 'title', 'Original');
			expect(rows.get('row-1')).toEqual({ title: 'Original' });

			cells.setCell('row-1', 'title', 'Updated');
			expect(rows.get('row-1')).toEqual({ title: 'Updated' });
			expect(rows.count()).toBe(1);
		});

		test('row index stays consistent under interleaved operations', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');
			const rows = createRowStore(cells);

			// Add 50 rows
			cells.batch((tx) => {
				for (let i = 0; i < 50; i++) {
					tx.setCell(`row-${i}`, 'col-a', `val-${i}`);
					tx.setCell(`row-${i}`, 'col-b', `val-${i}`);
				}
			});

			expect(rows.count()).toBe(50);

			// Delete even rows
			for (let i = 0; i < 50; i += 2) {
				rows.delete(`row-${i}`);
			}

			expect(rows.count()).toBe(25);

			// Verify odd rows are intact
			for (let i = 1; i < 50; i += 2) {
				expect(rows.has(`row-${i}`)).toBe(true);
				expect(rows.get(`row-${i}`)).toEqual({
					'col-a': `val-${i}`,
					'col-b': `val-${i}`,
				});
			}

			// Verify even rows are gone
			for (let i = 0; i < 50; i += 2) {
				expect(rows.has(`row-${i}`)).toBe(false);
			}
		});
	});

	describe('CRDT Sync', () => {
		test('changes sync between documents', () => {
			const doc1 = new Y.Doc({ guid: 'shared' });
			const doc2 = new Y.Doc({ guid: 'shared' });

			const cells1 = createCellStore<string>(doc1, 'cells');
			createRowStore(cells1); // Creates row view but we write via cells

			const cells2 = createCellStore<string>(doc2, 'cells');
			const rows2 = createRowStore(cells2);

			cells1.batch((tx) => {
				tx.setCell('row-1', 'title', 'Hello');
				tx.setCell('row-1', 'views', '42');
			});

			// Sync doc1 to doc2
			Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

			expect(rows2.get('row-1')).toEqual({ title: 'Hello', views: '42' });
		});

		test('row index stays consistent after CRDT sync adds cells', () => {
			const doc1 = new Y.Doc({ guid: 'shared' });
			const doc2 = new Y.Doc({ guid: 'shared' });

			const cells1 = createCellStore<string>(doc1, 'cells');
			createRowStore(cells1);

			const cells2 = createCellStore<string>(doc2, 'cells');
			const rows2 = createRowStore(cells2);

			// Write on doc1
			cells1.batch((tx) => {
				tx.setCell('row-1', 'title', 'Hello');
				tx.setCell('row-1', 'views', '100');
			});

			// Sync to doc2
			Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

			// Row index on doc2 should reflect the synced cells
			expect(rows2.has('row-1')).toBe(true);
			expect(rows2.count()).toBe(1);
			expect(rows2.ids()).toEqual(['row-1']);
			expect(rows2.get('row-1')).toEqual({ title: 'Hello', views: '100' });
		});

		test('row deletion syncs', () => {
			const doc1 = new Y.Doc({ guid: 'shared' });
			const doc2 = new Y.Doc({ guid: 'shared' });

			const cells1 = createCellStore<string>(doc1, 'cells');
			const rows1 = createRowStore(cells1);

			const cells2 = createCellStore<string>(doc2, 'cells');
			const rows2 = createRowStore(cells2);

			// Create row in doc1
			cells1.setCell('row-1', 'title', 'Hello');
			Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

			expect(rows2.has('row-1')).toBe(true);

			// Delete row in doc1
			rows1.delete('row-1');
			Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

			expect(rows2.has('row-1')).toBe(false);
		});
	});
});
