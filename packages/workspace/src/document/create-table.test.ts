/**
 * createTable: CRUD, query, observation, and migration over EncryptedYKeyValueLww.
 */

import { describe, expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import * as Y from 'yjs';
import { createEncryptedYkvLww } from '../shared/y-keyvalue/y-keyvalue-lww-encrypted.js';
import { field } from '@epicenter/field';
import { defineTable } from './define-table.js';
import { createReadonlyTable, createTable } from './table.js';

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
			const definition = defineTable({
				id: field.string(),
				name: field.string(),
			});
			const helper = createReadonlyTable(ykv, definition, 'test');
			// Raw ykv.set bypasses the table layer's `_v` stamping; include it
			// manually so the read path can route to v1's schema.
			ykv.set('1', { id: '1', name: 'Alice', _v: 1 });

			expect(helper.getAllValid()).toEqual([{ id: '1', name: 'Alice' }]);
			expect(helper.count()).toBe(1);
			expect(helper.has('1')).toBe(true);
			expect('set' in helper).toBe(false);
			expect('bulkSet' in helper).toBe(false);
			expect('update' in helper).toBe(false);
			expect('delete' in helper).toBe(false);
			expect('bulkDelete' in helper).toBe(false);
			expect('clear' in helper).toBe(false);
		});
	});

	describe('set operations', () => {
		test('set stores a row that get returns as valid', () => {
			const { ykv } = setup();
			const definition = defineTable({
				id: field.string(),
				name: field.string(),
			});
			const helper = createTable(ykv, definition, 'test');

			helper.set({ id: '1', name: 'Alice' });

			const data = expectOk(helper.get('1'));
			expect(data).toEqual({ id: '1', name: 'Alice' });
		});

		test('bulkSet stores rows in chunks and reports progress', async () => {
			const { ykv } = setup();
			const definition = defineTable({
				id: field.string(),
				name: field.string(),
			});
			const helper = createTable(ykv, definition, 'test');
			const progress: number[] = [];

			await helper.bulkSet(
				[
					{ id: '1', name: 'Alice' },
					{ id: '2', name: 'Bob' },
					{ id: '3', name: 'Charlie' },
					{ id: '4', name: 'Dora' },
					{ id: '5', name: 'Eve' },
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
			const definition = defineTable({
				id: field.string(),
				name: field.string(),
			});
			const helper = createTable(ykv, definition, 'test');

			const data = expectOk(helper.get('nonexistent'));
			expect(data).toBeNull();
		});

		test('get returns ValidationFailed error for corrupted data', () => {
			const { ykv, yarray } = setup();
			const definition = defineTable({
				id: field.string(),
				name: field.string(),
			});
			const helper = createTable(ykv, definition, 'test');

			// Insert invalid data directly. The library reads `_v` from the
			// stored value to route to the matching schema, so fixtures that
			// simulate raw storage must include `_v: 1`.
			yarray.push([{ key: '1', val: { id: '1', name: 123, _v: 1 }, ts: 0 }]); // name should be string

			const error = expectErr(helper.get('1'));
			expect(error.name).toBe('ValidationFailed');
			if (error.name !== 'ValidationFailed')
				throw new Error('Expected ValidationFailed');
			expect(error.id).toBe('1');
			expect(error.errors.length).toBeGreaterThan(0);
			expect(error.row).toEqual({ id: '1', name: 123, _v: 1 });
		});

		test('getAll / getAllValid / getAllInvalid partition results by validity', () => {
			const { ykv, yarray } = setup();
			const definition = defineTable({
				id: field.string(),
				name: field.string(),
			});
			const helper = createTable(ykv, definition, 'test');

			helper.set({ id: '1', name: 'Valid' });
			yarray.push([{ key: '2', val: { id: '2', name: 999, _v: 1 }, ts: 0 }]); // invalid: name type
			yarray.push([{ key: '3', val: { id: '3', _v: 1 }, ts: 0 }]); // invalid: missing name

			const results = helper.getAll();
			expect(results).toHaveLength(3);
			expect(results.filter((r) => !r.error)).toHaveLength(1);
			expect(results.filter((r) => r.error)).toHaveLength(2);

			const valid = helper.getAllValid();
			expect(valid).toEqual([{ id: '1', name: 'Valid' }]);

			const invalid = helper.getAllInvalid();
			expect(invalid.map((r) => r.id).sort()).toEqual(['2', '3']);
		});
	});

	describe('query operations', () => {
		test('filter returns matching rows', () => {
			const { ydoc, ykv } = setup();
			const definition = defineTable({
				id: field.string(),
				active: field.boolean(),
			});
			const helper = createTable(ykv, definition, 'test');

			ydoc.transact(() => {
				helper.set({ id: '1', active: true });
				helper.set({ id: '2', active: false });
				helper.set({ id: '3', active: true });
			});

			const active = helper.filter((row) => row.active);
			expect(active).toHaveLength(2);
			expect(active.map((r) => r.id).sort()).toEqual(['1', '3']);
		});

		test('filter returns empty array when no matches', () => {
			const { ydoc, ykv } = setup();
			const definition = defineTable({
				id: field.string(),
				active: field.boolean(),
			});
			const helper = createTable(ykv, definition, 'test');

			ydoc.transact(() => {
				helper.set({ id: '1', active: false });
				helper.set({ id: '2', active: false });
			});

			const active = helper.filter((row) => row.active);
			expect(active).toEqual([]);
		});

		test('filter skips invalid rows', () => {
			const { ykv, yarray } = setup();
			const definition = defineTable({
				id: field.string(),
				active: field.boolean(),
			});
			const helper = createTable(ykv, definition, 'test');

			helper.set({ id: '1', active: true });
			yarray.push([
				{ key: '2', val: { id: '2', active: 'not-a-boolean', _v: 1 }, ts: 0 },
			]);

			const all = helper.filter(() => true);
			expect(all).toHaveLength(1);
		});

		test('find returns first matching row', () => {
			const { ydoc, ykv } = setup();
			const definition = defineTable({
				id: field.string(),
				name: field.string(),
			});
			const helper = createTable(ykv, definition, 'test');

			ydoc.transact(() => {
				helper.set({ id: '1', name: 'Alice' });
				helper.set({ id: '2', name: 'Bob' });
			});

			const found = helper.find((row) => row.name === 'Bob');
			expect(found).toEqual({ id: '2', name: 'Bob' });
		});

		test('find returns undefined when no rows match', () => {
			const { ykv } = setup();
			const definition = defineTable({
				id: field.string(),
				name: field.string(),
			});
			const helper = createTable(ykv, definition, 'test');

			helper.set({ id: '1', name: 'Alice' });

			const found = helper.find((row) => row.name === 'Nobody');
			expect(found).toBeUndefined();
		});

		test('find skips invalid rows', () => {
			const { ykv, yarray } = setup();
			const definition = defineTable({
				id: field.string(),
				name: field.string(),
			});
			const helper = createTable(ykv, definition, 'test');

			yarray.push([{ key: '1', val: { id: '1', name: 123, _v: 1 }, ts: 0 }]); // invalid
			helper.set({ id: '2', name: 'Valid' });

			const found = helper.find(() => true);
			expect(found).toEqual({ id: '2', name: 'Valid' });
		});
	});

	describe('update operations', () => {
		test('update merges partial data correctly', () => {
			const { ykv } = setup();
			const definition = defineTable({
				id: field.string(),
				name: field.string(),
				age: field.number(),
			});
			const helper = createTable(ykv, definition, 'test');

			helper.set({ id: '1', name: 'Alice', age: 25 });
			const data = expectOk(helper.update('1', { age: 30 }));

			expect(data).toEqual({ id: '1', name: 'Alice', age: 30 });

			// Verify the row is actually saved
			const { data: saved } = helper.get('1');
			expect(saved).toEqual({ id: '1', name: 'Alice', age: 30 });
		});

		test('update returns null data for missing rows', () => {
			const { ykv } = setup();
			const definition = defineTable({
				id: field.string(),
				name: field.string(),
			});
			const helper = createTable(ykv, definition, 'test');

			const data = expectOk(helper.update('nonexistent', { name: 'Bob' }));

			expect(data).toBeNull();
		});

		test('update can be called after destructuring', () => {
			const { ykv } = setup();
			const definition = defineTable({
				id: field.string(),
				name: field.string(),
			});
			const helper = createTable(ykv, definition, 'test');
			const update = helper.update;

			helper.set({ id: '1', name: 'Alice' });
			const data = expectOk(update('1', { name: 'Bob' }));

			expect(data).toEqual({ id: '1', name: 'Bob' });
			expect(helper.get('1').data).toEqual({ id: '1', name: 'Bob' });
		});

		test('update returns ValidationFailed for corrupted data', () => {
			const { ykv, yarray } = setup();
			const definition = defineTable({
				id: field.string(),
				name: field.string(),
			});
			const helper = createTable(ykv, definition, 'test');

			// Insert invalid data directly (raw yarray.push needs `_v` for routing).
			yarray.push([{ key: '1', val: { id: '1', name: 123, _v: 1 }, ts: 0 }]); // name should be string

			const error = expectErr(helper.update('1', { name: 'Valid' }));
			expect(error.name).toBe('ValidationFailed');
			if (error.name !== 'ValidationFailed')
				throw new Error('Expected ValidationFailed');
			expect(error.id).toBe('1');
			expect(error.errors.length).toBeGreaterThan(0);
			expect(error.row).toEqual({ id: '1', name: 123, _v: 1 });
		});
	});

	describe('delete operations', () => {
		test('delete removes an existing row and is a no-op for a missing one', () => {
			const { ykv } = setup();
			const definition = defineTable({
				id: field.string(),
				name: field.string(),
			});
			const helper = createTable(ykv, definition, 'test');

			helper.set({ id: '1', name: 'Alice' });
			helper.delete('1');
			expect(helper.has('1')).toBe(false);

			// Missing row delete doesn't throw and leaves state empty.
			expect(() => helper.delete('nonexistent')).not.toThrow();
			expect(helper.has('nonexistent')).toBe(false);
		});

		test('transact can mix set and delete operations', () => {
			const { ydoc, ykv } = setup();
			const definition = defineTable({
				id: field.string(),
				name: field.string(),
			});
			const helper = createTable(ykv, definition, 'test');

			ydoc.transact(() => {
				helper.set({ id: '1', name: 'A' });
				helper.set({ id: '2', name: 'B' });
			});

			ydoc.transact(() => {
				helper.delete('1');
				helper.set({ id: '3', name: 'C' });
			});

			expect(helper.count()).toBe(2);
			expect(helper.has('1')).toBe(false);
			expect(helper.has('2')).toBe(true);
			expect(helper.has('3')).toBe(true);
		});

		test('clear removes all rows', () => {
			const { ydoc, ykv } = setup();
			const definition = defineTable({
				id: field.string(),
				name: field.string(),
			});
			const helper = createTable(ykv, definition, 'test');

			ydoc.transact(() => {
				helper.set({ id: '1', name: 'A' });
				helper.set({ id: '2', name: 'B' });
			});
			expect(helper.count()).toBe(2);

			helper.clear();
			expect(helper.count()).toBe(0);
		});

		test('bulkDelete removes rows in chunks and reports progress', async () => {
			const { ykv } = setup();
			const definition = defineTable({
				id: field.string(),
				name: field.string(),
			});
			const helper = createTable(ykv, definition, 'test');
			const progress: number[] = [];

			await helper.bulkSet([
				{ id: '1', name: 'Alice' },
				{ id: '2', name: 'Bob' },
				{ id: '3', name: 'Charlie' },
				{ id: '4', name: 'Dora' },
				{ id: '5', name: 'Eve' },
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
			const definition = defineTable({
				id: field.string(),
				name: field.string(),
			});
			const helper = createTable(ykv, definition, 'test');

			const changes: ReadonlySet<string>[] = [];
			const unsubscribe = helper.observe((changedIds) => {
				changes.push(changedIds);
			});

			helper.set({ id: '1', name: 'Alice' });
			helper.set({ id: '2', name: 'Bob' });
			helper.delete('1');

			expect(changes).toHaveLength(3);
			expect(changes[0]?.has('1')).toBe(true);
			expect(changes[1]?.has('2')).toBe(true);
			expect(changes[2]?.has('1')).toBe(true);

			unsubscribe();
		});

		test('transact fires observer once for all operations', () => {
			const { ydoc, ykv } = setup();
			const definition = defineTable({
				id: field.string(),
				name: field.string(),
			});
			const helper = createTable(ykv, definition, 'test');

			const changes: Set<string>[] = [];
			const unsubscribe = helper.observe((changedIds) => {
				changes.push(new Set(changedIds));
			});

			// Three operations, but observer should fire once
			ydoc.transact(() => {
				helper.set({ id: '1', name: 'Alice' });
				helper.set({ id: '2', name: 'Bob' });
				helper.set({ id: '3', name: 'Charlie' });
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
			const definition = defineTable({
				id: field.string(),
				name: field.string(),
			});
			const helper = createTable(ykv, definition, 'test');

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
		test('count returns the current number of rows', () => {
			const { ydoc, ykv } = setup();
			const definition = defineTable({
				id: field.string(),
				name: field.string(),
			});
			const helper = createTable(ykv, definition, 'test');

			expect(helper.count()).toBe(0);

			helper.set({ id: '1', name: 'A' });
			expect(helper.count()).toBe(1);

			ydoc.transact(() => {
				helper.set({ id: '2', name: 'B' });
				helper.set({ id: '3', name: 'C' });
			});
			expect(helper.count()).toBe(3);
		});

		test('has returns true for existing row', () => {
			const { ykv } = setup();
			const definition = defineTable({
				id: field.string(),
				name: field.string(),
			});
			const helper = createTable(ykv, definition, 'test');

			helper.set({ id: '1', name: 'Alice' });

			expect(helper.has('1')).toBe(true);
			expect(helper.has('2')).toBe(false);
		});
	});

	describe('migration', () => {
		test('migrates old data on read', () => {
			const { ykv, yarray } = setup();
			const definition = defineTable(
				{
					id: field.string(),
					name: field.string(),
				},
				{
					id: field.string(),
					name: field.string(),
					age: field.number(),
				},
			).migrate(({ value, version }) => {
				switch (version) {
					case 1:
						return { ...value, age: 0 };
					case 2:
						return value;
				}
			});
			const helper = createTable(ykv, definition, 'test');

			// Insert v1 data directly (raw yarray.push needs `_v` for routing).
			yarray.push([
				{ key: '1', val: { id: '1', name: 'Alice', _v: 1 }, ts: 0 },
			]);

			const data = expectOk(helper.get('1'));
			expect(data).toEqual({ id: '1', name: 'Alice', age: 0 });
		});

		test('three-version migration chain v1→v2→v3 composes at read time', () => {
			const { ykv, yarray } = setup();
			const definition = defineTable(
				{
					id: field.string(),
					title: field.string(),
				},
				{
					id: field.string(),
					title: field.string(),
					views: field.number(),
				},
				{
					id: field.string(),
					title: field.string(),
					views: field.number(),
					author: field.string(),
				},
			).migrate(({ value, version }) => {
				switch (version) {
					case 1:
						return { ...value, views: 0, author: 'unknown' };
					case 2:
						return { ...value, author: 'unknown' };
					case 3:
						return value;
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
			});
			expect(helper.get('b').data).toEqual({
				id: 'b',
				title: 'V2',
				views: 7,
				author: 'unknown',
			});
		});

		test('returns MigrationFailed when the migrator throws', () => {
			const { ykv, yarray } = setup();
			const definition = defineTable(
				{
					id: field.string(),
					name: field.string(),
				},
				{
					id: field.string(),
					name: field.string(),
					age: field.number(),
				},
			).migrate(({ value, version }) => {
				switch (version) {
					case 1:
						throw new Error('migration broke');
					case 2:
						return value;
				}
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

	describe('update validation', () => {
		test('returns ValidationFailed when the merged row fails schema', () => {
			const { ykv } = setup();
			const definition = defineTable({
				id: field.string(),
				name: field.string(),
				age: field.number({ exclusiveMinimum: 0 }),
			});
			const helper = createTable(ykv, definition, 'test');

			helper.set({ id: '1', name: 'Alice', age: 25 });

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
			});
		});
	});
});
