/**
 * YCellStore Tests - Schema-agnostic Sparse Grid Storage
 *
 * Tests cover:
 * 1. Cell CRUD: setCell, getCell, hasCell, deleteCell
 * 2. Key validation: rowId with ':' throws error
 * 3. Batch operations: multiple cell operations atomically
 * 4. Observer fires once per batch: not per operation
 * 5. Change types: add, update, delete events with correct rowId/columnId
 * 6. Iteration: cells() yields all cells with parsed components
 * 7. Count accuracy: after various operations
 * 8. Clear: removes all cells
 * 9. Escape hatch: ykv and doc accessible
 */
import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { type CellChange, createCellStore } from './y-cell-store';

describe('YCellStore', () => {
	describe('Cell CRUD', () => {
		test('setCell and getCell work correctly', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');

			cells.setCell('row-1', 'title', 'Hello');
			expect(cells.getCell('row-1', 'title')).toBe('Hello');
		});

		test('setCell overwrites existing value', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');

			cells.setCell('row-1', 'title', 'First');
			cells.setCell('row-1', 'title', 'Second');
			expect(cells.getCell('row-1', 'title')).toBe('Second');
		});

		test('getCell returns undefined for non-existent cell', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');

			expect(cells.getCell('row-1', 'title')).toBeUndefined();
		});

		test('hasCell returns true for existing cell', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');

			cells.setCell('row-1', 'title', 'Hello');
			expect(cells.hasCell('row-1', 'title')).toBe(true);
		});

		test('hasCell returns false for non-existent cell', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');

			expect(cells.hasCell('row-1', 'title')).toBe(false);
		});

		test('deleteCell removes cell and returns true', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');

			cells.setCell('row-1', 'title', 'Hello');
			const result = cells.deleteCell('row-1', 'title');

			expect(result).toBe(true);
			expect(cells.getCell('row-1', 'title')).toBeUndefined();
			expect(cells.hasCell('row-1', 'title')).toBe(false);
		});

		test('deleteCell returns false for non-existent cell', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');

			const result = cells.deleteCell('row-1', 'title');
			expect(result).toBe(false);
		});

		test('supports different value types', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<unknown>(ydoc, 'cells');

			cells.setCell('row-1', 'string', 'hello');
			cells.setCell('row-1', 'number', 42);
			cells.setCell('row-1', 'boolean', true);
			cells.setCell('row-1', 'object', { nested: 'value' });
			cells.setCell('row-1', 'null', null);

			expect(cells.getCell('row-1', 'string')).toBe('hello');
			expect(cells.getCell('row-1', 'number')).toBe(42);
			expect(cells.getCell('row-1', 'boolean')).toBe(true);
			expect(cells.getCell('row-1', 'object')).toEqual({ nested: 'value' });
			expect(cells.getCell('row-1', 'null')).toBeNull();
		});
	});

	describe('Key Validation', () => {
		test('rowId with colon throws error', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');

			expect(() => cells.setCell('row:1', 'title', 'Hello')).toThrow(
				'rowId cannot contain \':\': "row:1"',
			);
		});

		test('columnId with colon is allowed', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');

			cells.setCell('row-1', 'nested:column:id', 'Hello');
			expect(cells.getCell('row-1', 'nested:column:id')).toBe('Hello');
		});

		test('empty rowId is allowed', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');

			cells.setCell('', 'title', 'Hello');
			expect(cells.getCell('', 'title')).toBe('Hello');
		});

		test('empty columnId is allowed', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');

			cells.setCell('row-1', '', 'Hello');
			expect(cells.getCell('row-1', '')).toBe('Hello');
		});
	});

	describe('Batch Operations', () => {
		test('batch executes multiple operations atomically', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');

			cells.batch((tx) => {
				tx.setCell('row-1', 'title', 'Hello');
				tx.setCell('row-1', 'views', '42');
				tx.setCell('row-2', 'title', 'World');
			});

			expect(cells.getCell('row-1', 'title')).toBe('Hello');
			expect(cells.getCell('row-1', 'views')).toBe('42');
			expect(cells.getCell('row-2', 'title')).toBe('World');
		});

		test('batch deleteCell removes cells', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');

			cells.setCell('row-1', 'title', 'Hello');
			cells.setCell('row-1', 'views', '42');

			cells.batch((tx) => {
				tx.deleteCell('row-1', 'title');
			});

			expect(cells.hasCell('row-1', 'title')).toBe(false);
			expect(cells.hasCell('row-1', 'views')).toBe(true);
		});

		test('values set in batch are readable within batch', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');

			let valueInBatch: string | undefined;

			cells.batch((tx) => {
				tx.setCell('row-1', 'title', 'Hello');
				valueInBatch = cells.getCell('row-1', 'title');
			});

			expect(valueInBatch).toBe('Hello');
		});
	});

	describe('Observer', () => {
		test('observer fires once per batch, not per operation', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');

			let callCount = 0;
			cells.observe(() => {
				callCount++;
			});

			cells.batch((tx) => {
				tx.setCell('row-1', 'a', '1');
				tx.setCell('row-1', 'b', '2');
				tx.setCell('row-2', 'a', '3');
			});

			expect(callCount).toBe(1);
		});

		test('observer receives all changes from batch', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');

			const changes: CellChange<string>[] = [];
			cells.observe((c) => {
				changes.push(...c);
			});

			cells.batch((tx) => {
				tx.setCell('row-1', 'a', '1');
				tx.setCell('row-2', 'b', '2');
			});

			expect(changes.length).toBe(2);
			expect(changes[0]).toEqual({
				action: 'add',
				rowId: 'row-1',
				columnId: 'a',
				value: '1',
			});
			expect(changes[1]).toEqual({
				action: 'add',
				rowId: 'row-2',
				columnId: 'b',
				value: '2',
			});
		});

		test('observer fires add event for new cell', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');

			const changes: CellChange<string>[] = [];
			cells.observe((c) => {
				changes.push(...c);
			});

			cells.setCell('row-1', 'title', 'Hello');

			expect(changes).toEqual([
				{ action: 'add', rowId: 'row-1', columnId: 'title', value: 'Hello' },
			]);
		});

		test('observer fires update event when value changes', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');

			cells.setCell('row-1', 'title', 'First');

			const changes: CellChange<string>[] = [];
			cells.observe((c) => {
				changes.push(...c);
			});

			cells.setCell('row-1', 'title', 'Second');

			expect(changes).toEqual([
				{
					action: 'update',
					rowId: 'row-1',
					columnId: 'title',
					oldValue: 'First',
					value: 'Second',
				},
			]);
		});

		test('observer fires delete event when cell removed', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');

			cells.setCell('row-1', 'title', 'Hello');

			const changes: CellChange<string>[] = [];
			cells.observe((c) => {
				changes.push(...c);
			});

			cells.deleteCell('row-1', 'title');

			expect(changes).toEqual([
				{
					action: 'delete',
					rowId: 'row-1',
					columnId: 'title',
					oldValue: 'Hello',
				},
			]);
		});

		test('unsubscribe stops receiving events', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');

			let callCount = 0;
			const unsubscribe = cells.observe(() => {
				callCount++;
			});

			cells.setCell('row-1', 'title', 'Hello');
			expect(callCount).toBe(1);

			unsubscribe();

			cells.setCell('row-1', 'title', 'World');
			expect(callCount).toBe(1); // Still 1, no new call
		});
	});

	describe('Iteration', () => {
		test('cells() yields all cells with parsed components', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');

			cells.setCell('row-1', 'title', 'Hello');
			cells.setCell('row-1', 'views', '42');
			cells.setCell('row-2', 'title', 'World');

			const result = Array.from(cells.cells());

			expect(result).toHaveLength(3);
			expect(result).toContainEqual({
				rowId: 'row-1',
				columnId: 'title',
				value: 'Hello',
			});
			expect(result).toContainEqual({
				rowId: 'row-1',
				columnId: 'views',
				value: '42',
			});
			expect(result).toContainEqual({
				rowId: 'row-2',
				columnId: 'title',
				value: 'World',
			});
		});

		test('cells() returns empty iterator for empty store', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');

			const result = Array.from(cells.cells());
			expect(result).toEqual([]);
		});

		test('cells() correctly parses columnId with colon', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');

			cells.setCell('row-1', 'nested:column:id', 'value');

			const result = Array.from(cells.cells());
			expect(result).toEqual([
				{ rowId: 'row-1', columnId: 'nested:column:id', value: 'value' },
			]);
		});
	});

	describe('Count', () => {
		test('count returns 0 for empty store', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');

			expect(cells.count()).toBe(0);
		});

		test('count returns correct number after adds', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');

			cells.setCell('row-1', 'a', '1');
			cells.setCell('row-1', 'b', '2');
			cells.setCell('row-2', 'a', '3');

			expect(cells.count()).toBe(3);
		});

		test('count decreases after delete', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');

			cells.setCell('row-1', 'a', '1');
			cells.setCell('row-1', 'b', '2');
			cells.deleteCell('row-1', 'a');

			expect(cells.count()).toBe(1);
		});

		test('count unchanged when updating existing cell', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');

			cells.setCell('row-1', 'a', '1');
			cells.setCell('row-1', 'a', '2');

			expect(cells.count()).toBe(1);
		});
	});

	describe('Clear', () => {
		test('clear removes all cells', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');

			cells.setCell('row-1', 'a', '1');
			cells.setCell('row-1', 'b', '2');
			cells.setCell('row-2', 'a', '3');

			cells.clear();

			expect(cells.count()).toBe(0);
			expect(cells.hasCell('row-1', 'a')).toBe(false);
			expect(cells.hasCell('row-1', 'b')).toBe(false);
			expect(cells.hasCell('row-2', 'a')).toBe(false);
		});

		test('clear on empty store is no-op', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');

			cells.clear();
			expect(cells.count()).toBe(0);
		});

		test('clear fires single observer notification', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');

			cells.setCell('row-1', 'a', '1');
			cells.setCell('row-1', 'b', '2');

			let callCount = 0;
			cells.observe(() => {
				callCount++;
			});

			cells.clear();

			expect(callCount).toBe(1);
		});
	});

	describe('Escape Hatch', () => {
		test('ykv property is accessible', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');

			expect(cells.ykv).toBeDefined();
			expect(cells.ykv.map).toBeInstanceOf(Map);
		});

		test('doc property is accessible', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');

			expect(cells.doc).toBe(ydoc);
		});

		test('can use ykv directly for advanced operations', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const cells = createCellStore<string>(ydoc, 'cells');

			cells.setCell('row-1', 'title', 'Hello');

			// Direct access to underlying map
			expect(cells.ykv.map.size).toBe(1);
			expect(cells.ykv.has('row-1:title')).toBe(true);
		});
	});

	describe('CRDT Sync', () => {
		test('changes sync between documents', () => {
			const doc1 = new Y.Doc({ guid: 'shared' });
			const doc2 = new Y.Doc({ guid: 'shared' });

			const cells1 = createCellStore<string>(doc1, 'cells');
			const cells2 = createCellStore<string>(doc2, 'cells');

			cells1.setCell('row-1', 'title', 'Hello');

			// Sync doc1 to doc2
			Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

			expect(cells2.getCell('row-1', 'title')).toBe('Hello');
		});

		test('concurrent edits to different cells merge correctly', () => {
			const doc1 = new Y.Doc({ guid: 'shared' });
			const doc2 = new Y.Doc({ guid: 'shared' });

			const cells1 = createCellStore<string>(doc1, 'cells');
			const cells2 = createCellStore<string>(doc2, 'cells');

			// Both edit different cells offline
			cells1.setCell('row-1', 'title', 'From doc1');
			cells2.setCell('row-1', 'views', 'From doc2');

			// Sync both directions
			Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));
			Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2));

			// Both cells exist in both docs
			expect(cells1.getCell('row-1', 'title')).toBe('From doc1');
			expect(cells1.getCell('row-1', 'views')).toBe('From doc2');
			expect(cells2.getCell('row-1', 'title')).toBe('From doc1');
			expect(cells2.getCell('row-1', 'views')).toBe('From doc2');
		});

		test('concurrent edits to same cell use LWW resolution', () => {
			const doc1 = new Y.Doc({ guid: 'shared' });
			const doc2 = new Y.Doc({ guid: 'shared' });

			const cells1 = createCellStore<string>(doc1, 'cells');
			const cells2 = createCellStore<string>(doc2, 'cells');

			// Both edit same cell offline
			cells1.setCell('row-1', 'title', 'From doc1');
			// Small delay to ensure different timestamps
			cells2.setCell('row-1', 'title', 'From doc2');

			// Sync both directions
			Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));
			Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2));

			// Both should have same value (LWW winner)
			expect(cells1.getCell('row-1', 'title')).toBe(
				cells2.getCell('row-1', 'title'),
			);
		});
	});
});
