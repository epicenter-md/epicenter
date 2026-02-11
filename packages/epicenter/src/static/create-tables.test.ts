import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import * as Y from 'yjs';
import type { YKeyValueLwwEntry } from '../shared/y-keyvalue/y-keyvalue-lww.js';
import { createTables } from './create-tables.js';
import { defineTable } from './define-table.js';

describe('createTables', () => {
	test('set and get a row', () => {
		const ydoc = new Y.Doc();
		const tables = createTables(ydoc, {
			posts: defineTable(type({ id: 'string', title: 'string' })),
		});

		tables.posts.set({ id: '1', title: 'Hello' });

		const result = tables.posts.get('1');
		expect(result.status).toBe('valid');
		if (result.status === 'valid') {
			expect(result.row).toEqual({ id: '1', title: 'Hello' });
		}
	});

	test('get returns not_found for missing row', () => {
		const ydoc = new Y.Doc();
		const tables = createTables(ydoc, {
			posts: defineTable(type({ id: 'string', title: 'string' })),
		});

		const result = tables.posts.get('nonexistent');
		expect(result.status).toBe('not_found');
	});

	test('getAll returns all rows', () => {
		const ydoc = new Y.Doc();
		const tables = createTables(ydoc, {
			posts: defineTable(type({ id: 'string', title: 'string' })),
		});

		tables.posts.set({ id: '1', title: 'First' });
		tables.posts.set({ id: '2', title: 'Second' });

		const results = tables.posts.getAll();
		expect(results).toHaveLength(2);
	});

	test('getAllValid returns only valid rows', () => {
		const ydoc = new Y.Doc();
		const tables = createTables(ydoc, {
			posts: defineTable(type({ id: 'string', title: 'string' })),
		});

		tables.posts.set({ id: '1', title: 'Valid' });

		const rows = tables.posts.getAllValid();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toEqual({ id: '1', title: 'Valid' });
	});

	test('filter returns matching rows', () => {
		const ydoc = new Y.Doc();
		const tables = createTables(ydoc, {
			posts: defineTable(
				type({ id: 'string', title: 'string', published: 'boolean' }),
			),
		});

		tables.posts.set({ id: '1', title: 'Draft', published: false });
		tables.posts.set({ id: '2', title: 'Published', published: true });
		tables.posts.set({ id: '3', title: 'Another Published', published: true });

		const published = tables.posts.filter((row) => row.published);
		expect(published).toHaveLength(2);
	});

	test('find returns first matching row', () => {
		const ydoc = new Y.Doc();
		const tables = createTables(ydoc, {
			posts: defineTable(type({ id: 'string', title: 'string' })),
		});

		tables.posts.set({ id: '1', title: 'First' });
		tables.posts.set({ id: '2', title: 'Second' });

		const found = tables.posts.find((row) => row.title === 'Second');
		expect(found).toEqual({ id: '2', title: 'Second' });
	});

	test('delete removes a row', () => {
		const ydoc = new Y.Doc();
		const tables = createTables(ydoc, {
			posts: defineTable(type({ id: 'string', title: 'string' })),
		});

		tables.posts.set({ id: '1', title: 'Hello' });
		expect(tables.posts.has('1')).toBe(true);

		const result = tables.posts.delete('1');
		expect(result.status).toBe('deleted');
		expect(tables.posts.has('1')).toBe(false);
	});

	test('delete returns not_found_locally for missing row', () => {
		const ydoc = new Y.Doc();
		const tables = createTables(ydoc, {
			posts: defineTable(type({ id: 'string', title: 'string' })),
		});

		const result = tables.posts.delete('nonexistent');
		expect(result.status).toBe('not_found_locally');
	});

	test('count returns number of rows', () => {
		const ydoc = new Y.Doc();
		const tables = createTables(ydoc, {
			posts: defineTable(type({ id: 'string', title: 'string' })),
		});

		expect(tables.posts.count()).toBe(0);

		tables.posts.set({ id: '1', title: 'First' });
		tables.posts.set({ id: '2', title: 'Second' });

		expect(tables.posts.count()).toBe(2);
	});

	test('clear removes all rows', () => {
		const ydoc = new Y.Doc();
		const tables = createTables(ydoc, {
			posts: defineTable(type({ id: 'string', title: 'string' })),
		});

		tables.posts.set({ id: '1', title: 'First' });
		tables.posts.set({ id: '2', title: 'Second' });
		expect(tables.posts.count()).toBe(2);

		tables.posts.clear();
		expect(tables.posts.count()).toBe(0);
	});

	test('migrates old data on read', () => {
		const ydoc = new Y.Doc();
		const tables = createTables(ydoc, {
			posts: defineTable()
				.version(type({ id: 'string', title: 'string' }))
				.version(type({ id: 'string', title: 'string', views: 'number' }))
				.migrate((row) => {
					if (!('views' in row)) return { ...row, views: 0 };
					return row;
				}),
		});

		// Simulate writing old data by accessing the raw array
		const yarray = ydoc.getArray<YKeyValueLwwEntry<unknown>>('table:posts');
		yarray.push([{ key: '1', val: { id: '1', title: 'Old Post' }, ts: 0 }]);

		// Read should migrate
		const result = tables.posts.get('1');
		expect(result.status).toBe('valid');
		if (result.status === 'valid') {
			expect(result.row.views).toBe(0);
		}
	});
});

describe('migration scenarios', () => {
	test('three version migration with explicit _v field', () => {
		const ydoc = new Y.Doc();
		const tables = createTables(ydoc, {
			posts: defineTable()
				.version(type({ id: 'string', title: 'string', _v: '"1"' }))
				.version(
					type({ id: 'string', title: 'string', views: 'number', _v: '"2"' }),
				)
				.version(
					type({
						id: 'string',
						title: 'string',
						views: 'number',
						author: 'string | null',
						_v: '"3"',
					}),
				)
				.migrate((row) => {
					if (row._v === '1') {
						return { ...row, views: 0, author: null, _v: '3' };
					}
					if (row._v === '2') {
						return { ...row, author: null, _v: '3' };
					}
					return row;
				}),
		});

		// Insert v1 data directly
		const yarray = ydoc.getArray<YKeyValueLwwEntry<unknown>>('table:posts');
		yarray.push([{ key: '1', val: { id: '1', title: 'Old', _v: '1' }, ts: 0 }]);
		yarray.push([
			{
				key: '2',
				val: { id: '2', title: 'Medium', views: 10, _v: '2' },
				ts: 0,
			},
		]);

		// Read should migrate both
		const v1Result = tables.posts.get('1');
		expect(v1Result.status).toBe('valid');
		if (v1Result.status === 'valid') {
			expect(v1Result.row._v).toBe('3');
			expect(v1Result.row.views).toBe(0);
			expect(v1Result.row.author).toBeNull();
		}

		const v2Result = tables.posts.get('2');
		expect(v2Result.status).toBe('valid');
		if (v2Result.status === 'valid') {
			expect(v2Result.row._v).toBe('3');
			expect(v2Result.row.views).toBe(10);
			expect(v2Result.row.author).toBeNull();
		}
	});

	test('migration without explicit version field', () => {
		const ydoc = new Y.Doc();
		const tables = createTables(ydoc, {
			posts: defineTable()
				.version(type({ id: 'string', title: 'string' }))
				.version(type({ id: 'string', title: 'string', views: 'number' }))
				.version(
					type({
						id: 'string',
						title: 'string',
						views: 'number',
						tags: 'string[]',
					}),
				)
				.migrate((row) => {
					let current = row as {
						id: string;
						title: string;
						views?: number;
						tags?: string[];
					};
					if (!('views' in current)) {
						current = { ...current, views: 0 };
					}
					if (!('tags' in current)) {
						current = { ...current, tags: [] };
					}
					return current as {
						id: string;
						title: string;
						views: number;
						tags: string[];
					};
				}),
		});

		// Insert v1 data
		const yarray = ydoc.getArray<YKeyValueLwwEntry<unknown>>('table:posts');
		yarray.push([{ key: '1', val: { id: '1', title: 'Old' }, ts: 0 }]);

		const result = tables.posts.get('1');
		expect(result.status).toBe('valid');
		if (result.status === 'valid') {
			expect(result.row.views).toBe(0);
			expect(result.row.tags).toEqual([]);
		}
	});
});
