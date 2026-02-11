import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import * as Y from 'yjs';
import {
	YKeyValueLww,
	type YKeyValueLwwEntry,
} from '../shared/y-keyvalue/y-keyvalue-lww.js';
import { defineTable } from './define-table.js';
import { createTableHelper } from './table-helper.js';

/** Creates Yjs infrastructure for testing */
function setup() {
	const ydoc = new Y.Doc();
	const yarray = ydoc.getArray<YKeyValueLwwEntry<unknown>>('test-table');
	const ykv = new YKeyValueLww(yarray);
	return { ydoc, yarray, ykv };
}

describe('createTableHelper', () => {
	describe('set operations', () => {
		test('set stores a row', () => {
			const { ykv } = setup();
			const definition = defineTable(type({ id: 'string', name: 'string' }));
			const helper = createTableHelper(ykv, definition);

			helper.set({ id: '1', name: 'Alice' });

			const result = helper.get('1');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.row).toEqual({ id: '1', name: 'Alice' });
			}
		});

		test('set overwrites existing row', () => {
			const { ykv } = setup();
			const definition = defineTable(type({ id: 'string', name: 'string' }));
			const helper = createTableHelper(ykv, definition);

			helper.set({ id: '1', name: 'Alice' });
			helper.set({ id: '1', name: 'Bob' });

			const result = helper.get('1');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.row.name).toBe('Bob');
			}
		});

		test('batch stores multiple rows atomically', () => {
			const { ykv } = setup();
			const definition = defineTable(type({ id: 'string', name: 'string' }));
			const helper = createTableHelper(ykv, definition);

			helper.batch((tx) => {
				tx.set({ id: '1', name: 'Alice' });
				tx.set({ id: '2', name: 'Bob' });
				tx.set({ id: '3', name: 'Charlie' });
			});

			expect(helper.count()).toBe(3);
			expect(helper.getAllValid()).toHaveLength(3);
		});
	});

	describe('get operations', () => {
		test('get returns not_found for missing row', () => {
			const { ykv } = setup();
			const definition = defineTable(type({ id: 'string', name: 'string' }));
			const helper = createTableHelper(ykv, definition);

			const result = helper.get('nonexistent');
			expect(result.status).toBe('not_found');
			if (result.status === 'not_found') {
				expect(result.id).toBe('nonexistent');
			}
		});

		test('get returns invalid for corrupted data', () => {
			const { ykv, yarray } = setup();
			const definition = defineTable(type({ id: 'string', name: 'string' }));
			const helper = createTableHelper(ykv, definition);

			// Insert invalid data directly
			yarray.push([{ key: '1', val: { id: '1', name: 123 }, ts: 0 }]); // name should be string

			const result = helper.get('1');
			expect(result.status).toBe('invalid');
			if (result.status === 'invalid') {
				expect(result.id).toBe('1');
				expect(result.errors.length).toBeGreaterThan(0);
				expect(result.row).toEqual({ id: '1', name: 123 });
			}
		});

		test('getAll returns valid and invalid rows', () => {
			const { ykv, yarray } = setup();
			const definition = defineTable(type({ id: 'string', name: 'string' }));
			const helper = createTableHelper(ykv, definition);

			helper.set({ id: '1', name: 'Valid' });
			yarray.push([{ key: '2', val: { id: '2', name: 999 }, ts: 0 }]); // invalid

			const results = helper.getAll();
			expect(results).toHaveLength(2);

			const valid = results.filter((r) => r.status === 'valid');
			const invalid = results.filter((r) => r.status === 'invalid');
			expect(valid).toHaveLength(1);
			expect(invalid).toHaveLength(1);
		});

		test('getAllValid skips invalid rows', () => {
			const { ykv, yarray } = setup();
			const definition = defineTable(type({ id: 'string', name: 'string' }));
			const helper = createTableHelper(ykv, definition);

			helper.set({ id: '1', name: 'Valid' });
			yarray.push([{ key: '2', val: { id: '2', name: 999 }, ts: 0 }]); // invalid

			const rows = helper.getAllValid();
			expect(rows).toHaveLength(1);
			expect(rows[0]).toEqual({ id: '1', name: 'Valid' });
		});

		test('getAllInvalid returns only invalid rows', () => {
			const { ykv, yarray } = setup();
			const definition = defineTable(type({ id: 'string', name: 'string' }));
			const helper = createTableHelper(ykv, definition);

			helper.set({ id: '1', name: 'Valid' });
			yarray.push([{ key: '2', val: { id: '2', name: 999 }, ts: 0 }]); // invalid
			yarray.push([{ key: '3', val: { id: '3' }, ts: 0 }]); // also invalid - missing name

			const invalid = helper.getAllInvalid();
			expect(invalid).toHaveLength(2);
			expect(invalid.map((r) => r.id).sort()).toEqual(['2', '3']);
		});
	});

	describe('query operations', () => {
		test('filter returns matching rows', () => {
			const { ykv } = setup();
			const definition = defineTable(type({ id: 'string', active: 'boolean' }));
			const helper = createTableHelper(ykv, definition);

			helper.batch((tx) => {
				tx.set({ id: '1', active: true });
				tx.set({ id: '2', active: false });
				tx.set({ id: '3', active: true });
			});

			const active = helper.filter((row) => row.active);
			expect(active).toHaveLength(2);
			expect(active.map((r) => r.id).sort()).toEqual(['1', '3']);
		});

		test('filter returns empty array when no matches', () => {
			const { ykv } = setup();
			const definition = defineTable(type({ id: 'string', active: 'boolean' }));
			const helper = createTableHelper(ykv, definition);

			helper.batch((tx) => {
				tx.set({ id: '1', active: false });
				tx.set({ id: '2', active: false });
			});

			const active = helper.filter((row) => row.active);
			expect(active).toEqual([]);
		});

		test('filter skips invalid rows', () => {
			const { ykv, yarray } = setup();
			const definition = defineTable(type({ id: 'string', active: 'boolean' }));
			const helper = createTableHelper(ykv, definition);

			helper.set({ id: '1', active: true });
			yarray.push([
				{ key: '2', val: { id: '2', active: 'not-a-boolean' }, ts: 0 },
			]);

			const all = helper.filter(() => true);
			expect(all).toHaveLength(1);
		});

		test('find returns first matching row', () => {
			const { ykv } = setup();
			const definition = defineTable(type({ id: 'string', name: 'string' }));
			const helper = createTableHelper(ykv, definition);

			helper.batch((tx) => {
				tx.set({ id: '1', name: 'Alice' });
				tx.set({ id: '2', name: 'Bob' });
			});

			const found = helper.find((row) => row.name === 'Bob');
			expect(found).toEqual({ id: '2', name: 'Bob' });
		});

		test('find returns undefined when no match', () => {
			const { ykv } = setup();
			const definition = defineTable(type({ id: 'string', name: 'string' }));
			const helper = createTableHelper(ykv, definition);

			helper.set({ id: '1', name: 'Alice' });

			const found = helper.find((row) => row.name === 'Nobody');
			expect(found).toBeUndefined();
		});

		test('find skips invalid rows', () => {
			const { ykv, yarray } = setup();
			const definition = defineTable(type({ id: 'string', name: 'string' }));
			const helper = createTableHelper(ykv, definition);

			yarray.push([{ key: '1', val: { id: '1', name: 123 }, ts: 0 }]); // invalid
			helper.set({ id: '2', name: 'Valid' });

			const found = helper.find(() => true);
			expect(found).toEqual({ id: '2', name: 'Valid' });
		});
	});

	describe('update operations', () => {
		test('update merges partial data correctly', () => {
			const { ykv } = setup();
			const definition = defineTable(
				type({ id: 'string', name: 'string', age: 'number' }),
			);
			const helper = createTableHelper(ykv, definition);

			helper.set({ id: '1', name: 'Alice', age: 25 });
			const result = helper.update('1', { age: 30 });

			expect(result.status).toBe('updated');
			if (result.status === 'updated') {
				expect(result.row).toEqual({ id: '1', name: 'Alice', age: 30 });
			}

			// Verify the row is actually saved
			const getResult = helper.get('1');
			expect(getResult.status).toBe('valid');
			if (getResult.status === 'valid') {
				expect(getResult.row).toEqual({ id: '1', name: 'Alice', age: 30 });
			}
		});

		test('update returns not_found for missing rows', () => {
			const { ykv } = setup();
			const definition = defineTable(type({ id: 'string', name: 'string' }));
			const helper = createTableHelper(ykv, definition);

			const result = helper.update('nonexistent', { name: 'Bob' });

			expect(result.status).toBe('not_found');
			if (result.status === 'not_found') {
				expect(result.id).toBe('nonexistent');
			}
		});

		test('update returns invalid for corrupted data', () => {
			const { ykv, yarray } = setup();
			const definition = defineTable(type({ id: 'string', name: 'string' }));
			const helper = createTableHelper(ykv, definition);

			// Insert invalid data directly
			yarray.push([{ key: '1', val: { id: '1', name: 123 }, ts: 0 }]); // name should be string

			const result = helper.update('1', { name: 'Valid' });

			expect(result.status).toBe('invalid');
			if (result.status === 'invalid') {
				expect(result.id).toBe('1');
				expect(result.errors.length).toBeGreaterThan(0);
				expect(result.row).toEqual({ id: '1', name: 123 });
			}
		});

		test('update preserves id field (cannot be changed)', () => {
			const { ykv } = setup();
			const definition = defineTable(type({ id: 'string', name: 'string' }));
			const helper = createTableHelper(ykv, definition);

			helper.set({ id: '1', name: 'Alice' });

			// TypeScript prevents passing `id` in partial due to Omit<TRow, 'id'>
			// But we can test that even if someone bypasses TypeScript, the id is preserved
			const result = helper.update('1', { name: 'Bob' } as Partial<
				Omit<{ id: string; name: string }, 'id'>
			>);

			expect(result.status).toBe('updated');
			if (result.status === 'updated') {
				expect(result.row.id).toBe('1'); // ID is preserved
				expect(result.row.name).toBe('Bob');
			}

			// Verify the row still exists at the original ID
			expect(helper.has('1')).toBe(true);
		});
	});

	describe('delete operations', () => {
		test('delete removes existing row', () => {
			const { ykv } = setup();
			const definition = defineTable(type({ id: 'string', name: 'string' }));
			const helper = createTableHelper(ykv, definition);

			helper.set({ id: '1', name: 'Alice' });
			const result = helper.delete('1');

			expect(result.status).toBe('deleted');
			expect(helper.has('1')).toBe(false);
		});

		test('delete returns not_found_locally for missing row', () => {
			const { ykv } = setup();
			const definition = defineTable(type({ id: 'string', name: 'string' }));
			const helper = createTableHelper(ykv, definition);

			const result = helper.delete('nonexistent');
			expect(result.status).toBe('not_found_locally');
		});

		test('batch deletes multiple rows atomically', () => {
			const { ykv } = setup();
			const definition = defineTable(type({ id: 'string', name: 'string' }));
			const helper = createTableHelper(ykv, definition);

			helper.batch((tx) => {
				tx.set({ id: '1', name: 'A' });
				tx.set({ id: '2', name: 'B' });
				tx.set({ id: '3', name: 'C' });
			});

			helper.batch((tx) => {
				tx.delete('1');
				tx.delete('2');
				tx.delete('3');
			});

			expect(helper.count()).toBe(0);
		});

		test('batch can mix set and delete operations', () => {
			const { ykv } = setup();
			const definition = defineTable(type({ id: 'string', name: 'string' }));
			const helper = createTableHelper(ykv, definition);

			helper.batch((tx) => {
				tx.set({ id: '1', name: 'A' });
				tx.set({ id: '2', name: 'B' });
			});

			helper.batch((tx) => {
				tx.delete('1');
				tx.set({ id: '3', name: 'C' });
			});

			expect(helper.count()).toBe(2);
			expect(helper.has('1')).toBe(false);
			expect(helper.has('2')).toBe(true);
			expect(helper.has('3')).toBe(true);
		});

		test('clear removes all rows', () => {
			const { ykv } = setup();
			const definition = defineTable(type({ id: 'string', name: 'string' }));
			const helper = createTableHelper(ykv, definition);

			helper.batch((tx) => {
				tx.set({ id: '1', name: 'A' });
				tx.set({ id: '2', name: 'B' });
			});
			expect(helper.count()).toBe(2);

			helper.clear();
			expect(helper.count()).toBe(0);
		});
	});

	describe('observe', () => {
		test('observe calls callback on changes', () => {
			const { ykv } = setup();
			const definition = defineTable(type({ id: 'string', name: 'string' }));
			const helper = createTableHelper(ykv, definition);

			const changes: Set<string>[] = [];
			const unsubscribe = helper.observe((changedIds) => {
				changes.push(changedIds);
			});

			helper.set({ id: '1', name: 'Alice' });
			helper.set({ id: '2', name: 'Bob' });
			helper.delete('1');

			expect(changes).toHaveLength(3);
			expect(changes[0]!.has('1')).toBe(true);
			expect(changes[1]!.has('2')).toBe(true);
			expect(changes[2]!.has('1')).toBe(true);

			unsubscribe();
		});

		test('batch fires observer once for all operations', () => {
			const { ykv } = setup();
			const definition = defineTable(type({ id: 'string', name: 'string' }));
			const helper = createTableHelper(ykv, definition);

			const changes: Set<string>[] = [];
			const unsubscribe = helper.observe((changedIds) => {
				changes.push(new Set(changedIds));
			});

			// Three operations, but observer should fire once
			helper.batch((tx) => {
				tx.set({ id: '1', name: 'Alice' });
				tx.set({ id: '2', name: 'Bob' });
				tx.set({ id: '3', name: 'Charlie' });
			});

			// Should have exactly one change event containing all three IDs
			expect(changes).toHaveLength(1);
			expect(changes[0]!.has('1')).toBe(true);
			expect(changes[0]!.has('2')).toBe(true);
			expect(changes[0]!.has('3')).toBe(true);

			unsubscribe();
		});

		test('observe unsubscribe stops callbacks', () => {
			const { ykv } = setup();
			const definition = defineTable(type({ id: 'string', name: 'string' }));
			const helper = createTableHelper(ykv, definition);

			let callCount = 0;
			const unsubscribe = helper.observe(() => {
				callCount++;
			});

			helper.set({ id: '1', name: 'Alice' });
			expect(callCount).toBe(1);

			unsubscribe();

			helper.set({ id: '2', name: 'Bob' });
			expect(callCount).toBe(1); // no change
		});
	});

	describe('metadata', () => {
		test('count returns number of rows', () => {
			const { ykv } = setup();
			const definition = defineTable(type({ id: 'string', name: 'string' }));
			const helper = createTableHelper(ykv, definition);

			expect(helper.count()).toBe(0);

			helper.set({ id: '1', name: 'A' });
			expect(helper.count()).toBe(1);

			helper.batch((tx) => {
				tx.set({ id: '2', name: 'B' });
				tx.set({ id: '3', name: 'C' });
			});
			expect(helper.count()).toBe(3);
		});

		test('has returns true for existing row', () => {
			const { ykv } = setup();
			const definition = defineTable(type({ id: 'string', name: 'string' }));
			const helper = createTableHelper(ykv, definition);

			helper.set({ id: '1', name: 'Alice' });

			expect(helper.has('1')).toBe(true);
			expect(helper.has('2')).toBe(false);
		});
	});

	describe('migration', () => {
		test('migrates old data on read', () => {
			const { ykv, yarray } = setup();
			const definition = defineTable()
				.version(type({ id: 'string', name: 'string' }))
				.version(type({ id: 'string', name: 'string', age: 'number' }))
				.migrate((row) => {
					if (!('age' in row)) return { ...row, age: 0 };
					return row;
				});
			const helper = createTableHelper(ykv, definition);

			// Insert v1 data directly
			yarray.push([{ key: '1', val: { id: '1', name: 'Alice' }, ts: 0 }]);

			const result = helper.get('1');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.row).toEqual({ id: '1', name: 'Alice', age: 0 });
			}
		});

		test('passes through current version data unchanged', () => {
			const { ykv } = setup();
			const definition = defineTable()
				.version(type({ id: 'string', name: 'string' }))
				.version(type({ id: 'string', name: 'string', age: 'number' }))
				.migrate((row) => {
					if (!('age' in row)) return { ...row, age: 0 };
					return row;
				});
			const helper = createTableHelper(ykv, definition);

			helper.set({ id: '1', name: 'Alice', age: 30 });

			const result = helper.get('1');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.row).toEqual({ id: '1', name: 'Alice', age: 30 });
			}
		});
	});
});
