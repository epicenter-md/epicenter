/**
 * createTable: CRUD, query, observation, and migration over EncryptedYKeyValueLww.
 */

import { describe, expect, test } from 'bun:test';
import { expectErr, expectOk } from '@epicenter/test-utils/result';
import { type } from 'arktype';
import * as Y from 'yjs';
import { createEncryptedYkvLww } from '../shared/y-keyvalue/y-keyvalue-lww-encrypted.js';
import {
	attachReadonlyTable,
	attachTable,
	createReadonlyTable,
	createTable,
} from './attach-table.js';
import { defineTable } from './define-table.js';

/** Creates Yjs infrastructure for testing */
function setup() {
	const ydoc = new Y.Doc();
	const ykv = createEncryptedYkvLww<unknown>(ydoc, 'test-table');
	return { ydoc, yarray: ykv.yarray, ykv };
}

describe('createTable', () => {
	describe('readonly helpers', () => {
		test('createReadonlyTable reads rows without exposing write methods', () => {
			const { ykv } = setup();
			const definition = defineTable(
				type({ id: 'string', name: 'string', _v: '1' }),
			);
			const helper = createReadonlyTable(ykv, definition, 'test');
			ykv.set('1', { id: '1', name: 'Alice', _v: 1 });

			expect(helper.getAllValid()).toEqual([{ id: '1', name: 'Alice', _v: 1 }]);
			expect(helper.count()).toBe(1);
			expect(helper.has('1')).toBe(true);
			expect('set' in helper).toBe(false);
			expect('bulkSet' in helper).toBe(false);
			expect('update' in helper).toBe(false);
			expect('delete' in helper).toBe(false);
			expect('bulkDelete' in helper).toBe(false);
			expect('clear' in helper).toBe(false);
		});

		test('attachReadonlyTable reads the same Y.Doc slot without write methods', () => {
			const ydoc = new Y.Doc();
			const definition = defineTable(
				type({ id: 'string', name: 'string', _v: '1' }),
			);
			const writer = attachTable(ydoc, 'people', definition);
			const reader = attachReadonlyTable(ydoc, 'people', definition);

			writer.set({ id: '1', name: 'Alice', _v: 1 });

			expect(reader.get('1').data).toEqual({
				id: '1',
				name: 'Alice',
				_v: 1,
			});
			expect('set' in reader).toBe(false);
			expect('bulkSet' in reader).toBe(false);
			expect('update' in reader).toBe(false);
			expect('delete' in reader).toBe(false);
			expect('bulkDelete' in reader).toBe(false);
			expect('clear' in reader).toBe(false);
		});
	});

	describe('set operations', () => {
		test('set stores a row that get returns as valid', () => {
			const { ykv } = setup();
			const definition = defineTable(
				type({ id: 'string', name: 'string', _v: '1' }),
			);
			const helper = createTable(ykv, definition, 'test');

			helper.set({ id: '1', name: 'Alice', _v: 1 });

			const data = expectOk(helper.get('1'));
			expect(data).toEqual({ id: '1', name: 'Alice', _v: 1 });
		});

		test('bulkSet stores rows in chunks and reports progress', async () => {
			const { ykv } = setup();
			const definition = defineTable(
				type({ id: 'string', name: 'string', _v: '1' }),
			);
			const helper = createTable(ykv, definition, 'test');
			const progress: number[] = [];

			await helper.bulkSet(
				[
					{ id: '1', name: 'Alice', _v: 1 },
					{ id: '2', name: 'Bob', _v: 1 },
					{ id: '3', name: 'Charlie', _v: 1 },
					{ id: '4', name: 'Dora', _v: 1 },
					{ id: '5', name: 'Eve', _v: 1 },
				],
				{
					chunkSize: 2,
					onProgress: (percent) => progress.push(percent),
				},
			);

			expect(helper.getAllValid()).toHaveLength(5);
			expect(progress).toEqual([0.4, 0.8, 1]);
		});
	});

	describe('get operations', () => {
		test('get returns null for missing row', () => {
			const { ykv } = setup();
			const definition = defineTable(
				type({ id: 'string', name: 'string', _v: '1' }),
			);
			const helper = createTable(ykv, definition, 'test');

			const data = expectOk(helper.get('nonexistent'));
			expect(data).toBeNull();
		});

		test('get returns ValidationFailed error for corrupted data', () => {
			const { ykv, yarray } = setup();
			const definition = defineTable(
				type({ id: 'string', name: 'string', _v: '1' }),
			);
			const helper = createTable(ykv, definition, 'test');

			// Insert invalid data directly
			yarray.push([{ key: '1', val: { id: '1', name: 123, _v: 1 }, ts: 0 }]); // name should be string

			const error = expectErr(helper.get('1'));
			expect(error.name).toBe('ValidationFailed');
			if (error.name !== 'ValidationFailed')
				throw new Error('Expected ValidationFailed');
			expect(error.id).toBe('1');
			expect(error.issues.length).toBeGreaterThan(0);
			expect(error.row).toEqual({ id: '1', name: 123, _v: 1 });
		});

		test('getAll / getAllValid / getAllInvalid partition results by validity', () => {
			const { ykv, yarray } = setup();
			const definition = defineTable(
				type({ id: 'string', name: 'string', _v: '1' }),
			);
			const helper = createTable(ykv, definition, 'test');

			helper.set({ id: '1', name: 'Valid', _v: 1 });
			yarray.push([{ key: '2', val: { id: '2', name: 999, _v: 1 }, ts: 0 }]); // invalid: name type
			yarray.push([{ key: '3', val: { id: '3', _v: 1 }, ts: 0 }]); // invalid: missing name

			const results = helper.getAll();
			expect(results).toHaveLength(3);
			expect(results.filter((r) => !r.error)).toHaveLength(1);
			expect(results.filter((r) => r.error)).toHaveLength(2);

			const valid = helper.getAllValid();
			expect(valid).toEqual([{ id: '1', name: 'Valid', _v: 1 }]);

			const invalid = helper.getAllInvalid();
			expect(invalid.map((r) => r.id).sort()).toEqual(['2', '3']);
		});
	});

	describe('query operations', () => {
		test('filter returns matching rows', () => {
			const { ydoc, ykv } = setup();
			const definition = defineTable(
				type({ id: 'string', active: 'boolean', _v: '1' }),
			);
			const helper = createTable(ykv, definition, 'test');

			ydoc.transact(() => {
				helper.set({ id: '1', active: true, _v: 1 });
				helper.set({ id: '2', active: false, _v: 1 });
				helper.set({ id: '3', active: true, _v: 1 });
			});

			const active = helper.filter((row) => row.active);
			expect(active).toHaveLength(2);
			expect(active.map((r) => r.id).sort()).toEqual(['1', '3']);
		});

		test('filter returns empty array when no matches', () => {
			const { ydoc, ykv } = setup();
			const definition = defineTable(
				type({ id: 'string', active: 'boolean', _v: '1' }),
			);
			const helper = createTable(ykv, definition, 'test');

			ydoc.transact(() => {
				helper.set({ id: '1', active: false, _v: 1 });
				helper.set({ id: '2', active: false, _v: 1 });
			});

			const active = helper.filter((row) => row.active);
			expect(active).toEqual([]);
		});

		test('filter skips invalid rows', () => {
			const { ykv, yarray } = setup();
			const definition = defineTable(
				type({ id: 'string', active: 'boolean', _v: '1' }),
			);
			const helper = createTable(ykv, definition, 'test');

			helper.set({ id: '1', active: true, _v: 1 });
			yarray.push([
				{ key: '2', val: { id: '2', active: 'not-a-boolean', _v: 1 }, ts: 0 },
			]);

			const all = helper.filter(() => true);
			expect(all).toHaveLength(1);
		});

		test('find returns first matching row', () => {
			const { ydoc, ykv } = setup();
			const definition = defineTable(
				type({ id: 'string', name: 'string', _v: '1' }),
			);
			const helper = createTable(ykv, definition, 'test');

			ydoc.transact(() => {
				helper.set({ id: '1', name: 'Alice', _v: 1 });
				helper.set({ id: '2', name: 'Bob', _v: 1 });
			});

			const found = helper.find((row) => row.name === 'Bob');
			expect(found).toEqual({ id: '2', name: 'Bob', _v: 1 });
		});

		test('find returns undefined when no rows match', () => {
			const { ykv } = setup();
			const definition = defineTable(
				type({ id: 'string', name: 'string', _v: '1' }),
			);
			const helper = createTable(ykv, definition, 'test');

			helper.set({ id: '1', name: 'Alice', _v: 1 });

			const found = helper.find((row) => row.name === 'Nobody');
			expect(found).toBeUndefined();
		});

		test('find skips invalid rows', () => {
			const { ykv, yarray } = setup();
			const definition = defineTable(
				type({ id: 'string', name: 'string', _v: '1' }),
			);
			const helper = createTable(ykv, definition, 'test');

			yarray.push([{ key: '1', val: { id: '1', name: 123, _v: 1 }, ts: 0 }]); // invalid
			helper.set({ id: '2', name: 'Valid', _v: 1 });

			const found = helper.find(() => true);
			expect(found).toEqual({ id: '2', name: 'Valid', _v: 1 });
		});
	});

	describe('update operations', () => {
		test('update merges partial data correctly', () => {
			const { ykv } = setup();
			const definition = defineTable(
				type({ id: 'string', name: 'string', age: 'number', _v: '1' }),
			);
			const helper = createTable(ykv, definition, 'test');

			helper.set({ id: '1', name: 'Alice', age: 25, _v: 1 });
			const data = expectOk(helper.update('1', { age: 30 }));

			expect(data).toEqual({ id: '1', name: 'Alice', age: 30, _v: 1 });

			// Verify the row is actually saved
			const { data: saved } = helper.get('1');
			expect(saved).toEqual({ id: '1', name: 'Alice', age: 30, _v: 1 });
		});

		test('update returns null data for missing rows', () => {
			const { ykv } = setup();
			const definition = defineTable(
				type({ id: 'string', name: 'string', _v: '1' }),
			);
			const helper = createTable(ykv, definition, 'test');

			const data = expectOk(helper.update('nonexistent', { name: 'Bob' }));

			expect(data).toBeNull();
		});

		test('update can be called after destructuring', () => {
			const { ykv } = setup();
			const definition = defineTable(
				type({ id: 'string', name: 'string', _v: '1' }),
			);
			const helper = createTable(ykv, definition, 'test');
			const update = helper.update;

			helper.set({ id: '1', name: 'Alice', _v: 1 });
			const data = expectOk(update('1', { name: 'Bob' }));

			expect(data).toEqual({ id: '1', name: 'Bob', _v: 1 });
			expect(helper.get('1').data).toEqual({ id: '1', name: 'Bob', _v: 1 });
		});

		test('update returns ValidationFailed for corrupted data', () => {
			const { ykv, yarray } = setup();
			const definition = defineTable(
				type({ id: 'string', name: 'string', _v: '1' }),
			);
			const helper = createTable(ykv, definition, 'test');

			// Insert invalid data directly
			yarray.push([{ key: '1', val: { id: '1', name: 123, _v: 1 }, ts: 0 }]); // name should be string

			const error = expectErr(helper.update('1', { name: 'Valid' }));
			expect(error.name).toBe('ValidationFailed');
			if (error.name !== 'ValidationFailed')
				throw new Error('Expected ValidationFailed');
			expect(error.id).toBe('1');
			expect(error.issues.length).toBeGreaterThan(0);
			expect(error.row).toEqual({ id: '1', name: 123, _v: 1 });
		});

		test('update preserves id field', () => {
			const { ykv } = setup();
			const definition = defineTable(
				type({ id: 'string', name: 'string', _v: '1' }),
			);
			const helper = createTable(ykv, definition, 'test');

			helper.set({ id: '1', name: 'Alice', _v: 1 });
			const data = expectOk(helper.update('1', { name: 'Bob' }));

			expect(data?.id).toBe('1');
			expect(data?.name).toBe('Bob');
			expect(helper.has('1')).toBe(true);
		});
	});

	describe('delete operations', () => {
		test('delete removes an existing row and is a no-op for a missing one', () => {
			const { ykv } = setup();
			const definition = defineTable(
				type({ id: 'string', name: 'string', _v: '1' }),
			);
			const helper = createTable(ykv, definition, 'test');

			helper.set({ id: '1', name: 'Alice', _v: 1 });
			helper.delete('1');
			expect(helper.has('1')).toBe(false);

			// Missing row delete doesn't throw and leaves state empty.
			expect(() => helper.delete('nonexistent')).not.toThrow();
			expect(helper.has('nonexistent')).toBe(false);
		});

		test('transact can mix set and delete operations', () => {
			const { ydoc, ykv } = setup();
			const definition = defineTable(
				type({ id: 'string', name: 'string', _v: '1' }),
			);
			const helper = createTable(ykv, definition, 'test');

			ydoc.transact(() => {
				helper.set({ id: '1', name: 'A', _v: 1 });
				helper.set({ id: '2', name: 'B', _v: 1 });
			});

			ydoc.transact(() => {
				helper.delete('1');
				helper.set({ id: '3', name: 'C', _v: 1 });
			});

			expect(helper.count()).toBe(2);
			expect(helper.has('1')).toBe(false);
			expect(helper.has('2')).toBe(true);
			expect(helper.has('3')).toBe(true);
		});

		test('clear removes all rows', () => {
			const { ydoc, ykv } = setup();
			const definition = defineTable(
				type({ id: 'string', name: 'string', _v: '1' }),
			);
			const helper = createTable(ykv, definition, 'test');

			ydoc.transact(() => {
				helper.set({ id: '1', name: 'A', _v: 1 });
				helper.set({ id: '2', name: 'B', _v: 1 });
			});
			expect(helper.count()).toBe(2);

			helper.clear();
			expect(helper.count()).toBe(0);
		});

		test('bulkDelete removes rows in chunks and reports progress', async () => {
			const { ykv } = setup();
			const definition = defineTable(
				type({ id: 'string', name: 'string', _v: '1' }),
			);
			const helper = createTable(ykv, definition, 'test');
			const progress: number[] = [];

			await helper.bulkSet([
				{ id: '1', name: 'Alice', _v: 1 },
				{ id: '2', name: 'Bob', _v: 1 },
				{ id: '3', name: 'Charlie', _v: 1 },
				{ id: '4', name: 'Dora', _v: 1 },
				{ id: '5', name: 'Eve', _v: 1 },
			]);

			await helper.bulkDelete(['1', '3', '5'], {
				chunkSize: 2,
				onProgress: (percent) => progress.push(percent),
			});

			expect(
				helper
					.getAllValid()
					.map((row) => row.id)
					.sort(),
			).toEqual(['2', '4']);
			expect(progress).toEqual([2 / 3, 1]);
		});
	});

	describe('observe', () => {
		test('observe calls callback on changes', () => {
			const { ykv } = setup();
			const definition = defineTable(
				type({ id: 'string', name: 'string', _v: '1' }),
			);
			const helper = createTable(ykv, definition, 'test');

			const changes: ReadonlySet<string>[] = [];
			const unsubscribe = helper.observe((changedIds) => {
				changes.push(changedIds);
			});

			helper.set({ id: '1', name: 'Alice', _v: 1 });
			helper.set({ id: '2', name: 'Bob', _v: 1 });
			helper.delete('1');

			expect(changes).toHaveLength(3);
			expect(changes[0]?.has('1')).toBe(true);
			expect(changes[1]?.has('2')).toBe(true);
			expect(changes[2]?.has('1')).toBe(true);

			unsubscribe();
		});

		test('transact fires observer once for all operations', () => {
			const { ydoc, ykv } = setup();
			const definition = defineTable(
				type({ id: 'string', name: 'string', _v: '1' }),
			);
			const helper = createTable(ykv, definition, 'test');

			const changes: Set<string>[] = [];
			const unsubscribe = helper.observe((changedIds) => {
				changes.push(new Set(changedIds));
			});

			// Three operations, but observer should fire once
			ydoc.transact(() => {
				helper.set({ id: '1', name: 'Alice', _v: 1 });
				helper.set({ id: '2', name: 'Bob', _v: 1 });
				helper.set({ id: '3', name: 'Charlie', _v: 1 });
			});

			// Should have exactly one change event containing all three IDs
			expect(changes).toHaveLength(1);
			expect(changes[0]?.has('1')).toBe(true);
			expect(changes[0]?.has('2')).toBe(true);
			expect(changes[0]?.has('3')).toBe(true);

			unsubscribe();
		});

		test('observe unsubscribe stops callbacks', () => {
			const { ykv } = setup();
			const definition = defineTable(
				type({ id: 'string', name: 'string', _v: '1' }),
			);
			const helper = createTable(ykv, definition, 'test');

			let callCount = 0;
			const unsubscribe = helper.observe(() => {
				callCount++;
			});

			helper.set({ id: '1', name: 'Alice', _v: 1 });
			expect(callCount).toBe(1);

			unsubscribe();

			helper.set({ id: '2', name: 'Bob', _v: 1 });
			expect(callCount).toBe(1); // no change
		});
	});

	describe('metadata', () => {
		test('count returns the current number of rows', () => {
			const { ydoc, ykv } = setup();
			const definition = defineTable(
				type({ id: 'string', name: 'string', _v: '1' }),
			);
			const helper = createTable(ykv, definition, 'test');

			expect(helper.count()).toBe(0);

			helper.set({ id: '1', name: 'A', _v: 1 });
			expect(helper.count()).toBe(1);

			ydoc.transact(() => {
				helper.set({ id: '2', name: 'B', _v: 1 });
				helper.set({ id: '3', name: 'C', _v: 1 });
			});
			expect(helper.count()).toBe(3);
		});

		test('has returns true for existing row', () => {
			const { ykv } = setup();
			const definition = defineTable(
				type({ id: 'string', name: 'string', _v: '1' }),
			);
			const helper = createTable(ykv, definition, 'test');

			helper.set({ id: '1', name: 'Alice', _v: 1 });

			expect(helper.has('1')).toBe(true);
			expect(helper.has('2')).toBe(false);
		});
	});

	describe('migration', () => {
		test('migrates old data on read', () => {
			const { ykv, yarray } = setup();
			const definition = defineTable(
				type({ id: 'string', name: 'string', _v: '1' }),
				type({ id: 'string', name: 'string', age: 'number', _v: '2' }),
			).migrate((row) => {
				if (row._v === 1) return { ...row, age: 0, _v: 2 };
				return row;
			});
			const helper = createTable(ykv, definition, 'test');

			// Insert v1 data directly
			yarray.push([
				{ key: '1', val: { id: '1', name: 'Alice', _v: 1 }, ts: 0 },
			]);

			const data = expectOk(helper.get('1'));
			expect(data).toEqual({ id: '1', name: 'Alice', age: 0, _v: 2 });
		});

		test('passes through current version data unchanged', () => {
			const { ykv } = setup();
			const definition = defineTable(
				type({ id: 'string', name: 'string', _v: '1' }),
				type({ id: 'string', name: 'string', age: 'number', _v: '2' }),
			).migrate((row) => {
				if (row._v === 1) return { ...row, age: 0, _v: 2 };
				return row;
			});
			const helper = createTable(ykv, definition, 'test');

			helper.set({ id: '1', name: 'Alice', age: 30, _v: 2 });

			const data = expectOk(helper.get('1'));
			expect(data).toEqual({ id: '1', name: 'Alice', age: 30, _v: 2 });
		});

		test('three-version migration chain v1→v2→v3 composes at read time', () => {
			const { ykv, yarray } = setup();
			const definition = defineTable(
				type({ id: 'string', title: 'string', _v: '1' }),
				type({ id: 'string', title: 'string', views: 'number', _v: '2' }),
				type({
					id: 'string',
					title: 'string',
					views: 'number',
					author: 'string',
					_v: '3',
				}),
			).migrate((row) => {
				switch (row._v) {
					case 1:
						return { ...row, views: 0, author: 'unknown', _v: 3 };
					case 2:
						return { ...row, author: 'unknown', _v: 3 };
					case 3:
						return row;
				}
			});
			const helper = createTable(ykv, definition, 'test');

			yarray.push([
				{ key: 'a', val: { id: 'a', title: 'V1', _v: 1 }, ts: 0 },
				{ key: 'b', val: { id: 'b', title: 'V2', views: 7, _v: 2 }, ts: 0 },
			]);

			expect(helper.get('a').data).toEqual({
				id: 'a',
				title: 'V1',
				views: 0,
				author: 'unknown',
				_v: 3,
			});
			expect(helper.get('b').data).toEqual({
				id: 'b',
				title: 'V2',
				views: 7,
				author: 'unknown',
				_v: 3,
			});
		});

		test('returns MigrationFailed when the migrator throws', () => {
			const { ykv, yarray } = setup();
			const definition = defineTable(
				type({ id: 'string', name: 'string', _v: '1' }),
				type({ id: 'string', name: 'string', age: 'number', _v: '2' }),
			).migrate((row) => {
				if (row._v === 1) throw new Error('migration broke');
				return row;
			});
			const helper = createTable(ykv, definition, 'test');

			yarray.push([
				{ key: '1', val: { id: '1', name: 'Alice', _v: 1 }, ts: 0 },
			]);

			const error = expectErr(helper.get('1'));
			expect(error.name).toBe('MigrationFailed');
			if (error.name !== 'MigrationFailed')
				throw new Error('Expected MigrationFailed');
			expect(error.id).toBe('1');
			expect(error.cause).toBeInstanceOf(Error);
			expect((error.cause as Error).message).toBe('migration broke');
		});
	});

	describe('async schema', () => {
		test('get returns AsyncSchemaNotSupported when validate yields a Promise', () => {
			const { ykv } = setup();
			const syncDef = defineTable(
				type({ id: 'string', name: 'string', _v: '1' }),
			);
			// Swap in an async-returning validate to exercise the async guard.
			const asyncDef = {
				...syncDef,
				schema: {
					...syncDef.schema,
					'~standard': {
						...syncDef.schema['~standard'],
						validate: () => Promise.resolve({ value: {} }),
					},
				},
			} as unknown as typeof syncDef;
			const helper = createTable(ykv, asyncDef, 'test');

			// Any stored row triggers parseRow, which must detect the Promise.
			ykv.set('1', { id: '1', name: 'Alice', _v: 1 });

			const error = expectErr(helper.get('1'));
			expect(error.name).toBe('AsyncSchemaNotSupported');
			if (error.name !== 'AsyncSchemaNotSupported')
				throw new Error('Expected AsyncSchemaNotSupported');
			expect(error.id).toBe('1');
		});
	});

	describe('update validation', () => {
		test('returns ValidationFailed when the merged row fails schema', () => {
			const { ykv } = setup();
			const definition = defineTable(
				type({ id: 'string', name: 'string', age: 'number>0', _v: '1' }),
			);
			const helper = createTable(ykv, definition, 'test');

			helper.set({ id: '1', name: 'Alice', age: 25, _v: 1 });

			// Current row is valid; the partial update violates age>0.
			const error = expectErr(
				helper.update('1', {
					age: -5,
				} as unknown as Partial<{ name: string; age: number }>),
			);

			expect(error.name).toBe('ValidationFailed');

			// And the stored row is unchanged.
			expect(helper.get('1').data).toEqual({
				id: '1',
				name: 'Alice',
				age: 25,
				_v: 1,
			});
		});
	});
});
