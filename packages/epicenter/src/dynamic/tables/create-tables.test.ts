import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { boolean, Id, id, integer, table, tags, text } from '../schema';
import { createTables } from './create-tables';

describe('createTables', () => {
	test('should create and retrieve rows correctly', () => {
		const ydoc = new Y.Doc({ guid: 'test-workspace' });
		const doc = createTables(ydoc, [
			table({
				id: 'posts',
				name: '',
				fields: [
					id(),
					text({ id: 'title' }),
					integer({ id: 'view_count' }),
					boolean({ id: 'published' }),
				] as const,
			}),
		]);

		// Create a row
		doc.get('posts').upsert({
			id: Id('1'),
			title: 'Test Post',
			view_count: 0,
			published: false,
		});

		// Retrieve the row
		const result = doc.get('posts').get(Id('1'));
		expect(result.status).toBe('valid');
		if (result.status === 'valid') {
			expect(result.row.title).toBe('Test Post');
			expect(result.row.view_count).toBe(0);
			expect(result.row.published).toBe(false);
		}
	});

	test('should handle batch operations', () => {
		const ydoc = new Y.Doc({ guid: 'test-workspace' });
		const doc = createTables(ydoc, [
			table({
				id: 'posts',
				name: '',
				fields: [
					id(),
					text({ id: 'title' }),
					integer({ id: 'view_count' }),
					boolean({ id: 'published' }),
				] as const,
			}),
		]);

		// Create multiple rows
		doc.get('posts').upsertMany([
			{ id: Id('1'), title: 'Post 1', view_count: 10, published: true },
			{ id: Id('2'), title: 'Post 2', view_count: 20, published: false },
		]);

		// Retrieve and verify rows
		const row1 = doc.get('posts').get(Id('1'));
		const row2 = doc.get('posts').get(Id('2'));
		expect(row1.status).toBe('valid');
		expect(row2.status).toBe('valid');
		if (row1.status === 'valid') {
			expect(row1.row.title).toBe('Post 1');
		}
		if (row2.status === 'valid') {
			expect(row2.row.title).toBe('Post 2');
		}
	});

	test('should filter and find rows correctly', () => {
		const ydoc = new Y.Doc({ guid: 'test-workspace' });
		const doc = createTables(ydoc, [
			table({
				id: 'posts',
				name: '',
				fields: [
					id(),
					text({ id: 'title' }),
					integer({ id: 'view_count' }),
					boolean({ id: 'published' }),
				] as const,
			}),
		]);

		doc.get('posts').upsertMany([
			{ id: Id('1'), title: 'Post 1', view_count: 10, published: true },
			{ id: Id('2'), title: 'Post 2', view_count: 20, published: false },
			{ id: Id('3'), title: 'Post 3', view_count: 30, published: true },
		]);

		// Filter published posts
		const publishedPosts = doc.get('posts').filter((post) => post.published);
		expect(publishedPosts).toHaveLength(2);

		// Find first unpublished post
		const firstDraft = doc.get('posts').find((post) => !post.published);
		expect(firstDraft).not.toBeNull();
		if (firstDraft) {
			expect(firstDraft.id).toBe(Id('2'));
		}
	});

	test('should return not_found status for non-existent rows', () => {
		const ydoc = new Y.Doc({ guid: 'test-workspace' });
		const doc = createTables(ydoc, [
			table({
				id: 'posts',
				name: '',
				fields: [
					id(),
					text({ id: 'title' }),
					integer({ id: 'view_count' }),
					boolean({ id: 'published' }),
				] as const,
			}),
		]);

		// Test get() with non-existent id
		const getResult = doc.get('posts').get(Id('non-existent'));
		expect(getResult.status).toBe('not_found');
		if (getResult.status === 'not_found') {
			expect(getResult.id).toBe(Id('non-existent'));
		}

		// Test find() with no matches
		const findResult = doc
			.get('posts')
			.find((post) => post.id === 'non-existent');
		expect(findResult).toBeNull();
	});

	test('should store and retrieve richtext and tags correctly', () => {
		const ydoc = new Y.Doc({ guid: 'test-workspace' });
		const doc = createTables(ydoc, [
			table({
				id: 'posts',
				name: '',
				fields: [
					id(),
					text({ id: 'title' }),
					tags({
						id: 'tags',
						options: ['typescript', 'javascript', 'python'] as const,
					}),
				] as const,
			}),
		]);

		doc.get('posts').upsert({
			id: Id('1'),
			title: 'hello123',
			tags: ['typescript', 'javascript'],
		});

		const result1 = doc.get('posts').get(Id('1'));
		expect(result1.status).toBe('valid');
		if (result1.status === 'valid') {
			expect(result1.row.title).toBe('hello123');
			expect(result1.row.tags).toEqual(['typescript', 'javascript']);
		}

		doc.get('posts').upsert({
			id: Id('2'),
			title: 'second456',
			tags: ['python'],
		});

		const rows = doc.get('posts').getAllValid();
		expect(rows).toHaveLength(2);
		const firstRow = rows[0]!;
		const secondRow = rows[1]!;
		expect(firstRow.title).toBe('hello123');
		expect(secondRow.title).toBe('second456');
	});

	test('rows are plain JSON-serializable objects', () => {
		const ydoc = new Y.Doc({ guid: 'test-workspace' });
		const doc = createTables(ydoc, [
			table({
				id: 'posts',
				name: '',
				fields: [
					id(),
					text({ id: 'title' }),
					boolean({ id: 'published' }),
				] as const,
			}),
		]);

		doc.get('posts').upsert({ id: Id('1'), title: 'Test', published: false });

		const result = doc.get('posts').get(Id('1'));
		expect(result.status).toBe('valid');
		if (result.status === 'valid') {
			const row = result.row;
			expect(row).toEqual({ id: Id('1'), title: 'Test', published: false });

			const serialized = JSON.stringify(row);
			const parsed = JSON.parse(serialized);
			expect(parsed).toEqual({ id: Id('1'), title: 'Test', published: false });
		}
	});

	describe('observe', () => {
		test('observe fires when row is added via upsert', () => {
			const ydoc = new Y.Doc({ guid: 'test-observe' });
			const tables = createTables(ydoc, [
				table({
					id: 'posts',
					name: '',
					fields: [
						id(),
						text({ id: 'title' }),
						boolean({ id: 'published' }),
					] as const,
				}),
			]);

			// Use a Set to collect unique IDs (observer may fire multiple times per transaction)
			const changedRows = new Set<string>();
			tables.get('posts').observe((changedIds) => {
				for (const id of changedIds) {
					changedRows.add(id);
				}
			});

			tables.get('posts').upsert({
				id: Id('post-1'),
				title: 'First',
				published: false,
			});
			tables.get('posts').upsert({
				id: Id('post-2'),
				title: 'Second',
				published: true,
			});

			expect(changedRows.has(Id('post-1'))).toBe(true);
			expect(changedRows.has(Id('post-2'))).toBe(true);
			expect(changedRows.size).toBe(2);
		});

		test('observe fires when row field is modified', () => {
			const ydoc = new Y.Doc({ guid: 'test-observe' });
			const tables = createTables(ydoc, [
				table({
					id: 'posts',
					name: '',
					fields: [
						id(),
						text({ id: 'title' }),
						integer({ id: 'view_count' }),
					] as const,
				}),
			]);

			tables.get('posts').upsert({
				id: Id('post-1'),
				title: 'Original',
				view_count: 0,
			});

			const updates: Array<{ id: string; title: string }> = [];
			tables.get('posts').observe((changedIds) => {
				for (const id of changedIds) {
					const result = tables.get('posts').get(id);
					// New API cannot distinguish add vs update, check if row exists
					if (result.status === 'valid') {
						updates.push({
							id,
							title: result.row.title,
						});
					}
				}
			});

			tables.get('posts').update({ id: Id('post-1'), title: 'Updated' });
			tables.get('posts').update({ id: Id('post-1'), view_count: 100 });

			expect(updates).toHaveLength(2);
			expect(updates[0]?.title).toBe('Updated');
		});

		test('observe fires when row is removed', () => {
			const ydoc = new Y.Doc({ guid: 'test-observe' });
			const tables = createTables(ydoc, [
				table({
					id: 'posts',
					name: '',
					fields: [id(), text({ id: 'title' })] as const,
				}),
			]);

			tables.get('posts').upsert({ id: Id('post-1'), title: 'First' });
			tables.get('posts').upsert({ id: Id('post-2'), title: 'Second' });

			const deletedIds: string[] = [];
			tables.get('posts').observe((changedIds) => {
				for (const id of changedIds) {
					// Check if row was deleted by seeing if it no longer exists
					const result = tables.get('posts').get(id);
					if (result.status === 'not_found') {
						deletedIds.push(id);
					}
				}
			});

			tables.get('posts').delete(Id('post-1'));

			expect(deletedIds).toEqual(['post-1']);
		});

		test('callbacks can access row data via get()', () => {
			const ydoc = new Y.Doc({ guid: 'test-observe' });
			const tables = createTables(ydoc, [
				table({
					id: 'posts',
					name: '',
					fields: [id(), text({ id: 'title' })] as const,
				}),
			]);

			const receivedRows: Array<{ id: string; title: string }> = [];

			tables.get('posts').observe((changedIds) => {
				for (const id of changedIds) {
					const result = tables.get('posts').get(id);
					// For non-deleted rows, we can access the data
					if (result.status === 'valid') {
						receivedRows.push({ id, title: result.row.title });
					}
				}
			});

			tables.get('posts').upsert({ id: Id('post-1'), title: 'Test' });

			expect(receivedRows).toHaveLength(1);
			expect(receivedRows[0]).toEqual({ id: Id('post-1'), title: 'Test' });
		});

		test('raw values passed through even for invalid data', () => {
			const ydoc = new Y.Doc({ guid: 'test-observe' });

			const tables = createTables(ydoc, [
				table({
					id: 'posts',
					name: '',
					fields: [id(), integer({ id: 'count' })] as const,
				}),
			]);

			let receivedResult: unknown = null;
			tables.get('posts').observe((changedIds) => {
				for (const rowId of changedIds) {
					receivedResult = tables.get('posts').get(rowId);
				}
			});

			// Directly manipulate the underlying Y.Array to insert invalid data
			// This simulates data coming from a remote peer with schema mismatch
			// With cell-level storage, we need to insert cell keys (rowId:fieldId)
			const yarray = ydoc.getArray<{ key: string; val: unknown; ts: number }>(
				'table:posts',
			);
			const now = Date.now();
			yarray.push([
				{ key: 'bad-row:id', val: 'bad-row', ts: now },
				{ key: 'bad-row:count', val: 'not a number', ts: now },
			]);

			expect(receivedResult).toMatchObject({
				status: 'invalid',
				row: { id: 'bad-row', count: 'not a number' },
			});
		});

		test('unsubscribe stops callbacks', () => {
			const ydoc = new Y.Doc({ guid: 'test-observe' });
			const tables = createTables(ydoc, [
				table({
					id: 'posts',
					name: '',
					fields: [id(), text({ id: 'title' })] as const,
				}),
			]);

			// Use a Set to collect unique IDs (observer may fire multiple times per transaction)
			const changedIds = new Set<string>();
			const unsubscribe = tables.get('posts').observe((ids) => {
				for (const id of ids) {
					changedIds.add(id);
				}
			});

			tables.get('posts').upsert({ id: Id('post-1'), title: 'First' });
			unsubscribe();
			tables.get('posts').upsert({ id: Id('post-2'), title: 'Second' });

			// Only post-1 should be observed; post-2 happened after unsubscribe
			expect(changedIds.has(Id('post-1'))).toBe(true);
			expect(changedIds.has(Id('post-2'))).toBe(false);
		});

		test('transaction batching: upsertMany fires callback once with all changes', () => {
			const ydoc = new Y.Doc({ guid: 'test-batch' });
			const tables = createTables(ydoc, [
				table({
					id: 'posts',
					name: '',
					fields: [id(), text({ id: 'title' })] as const,
				}),
			]);

			let callbackCount = 0;
			const allChangedIds: Set<string>[] = [];

			tables.get('posts').observe((changedIds) => {
				callbackCount++;
				allChangedIds.push(new Set(changedIds));
			});

			tables.get('posts').upsertMany([
				{ id: Id('post-1'), title: 'First' },
				{ id: Id('post-2'), title: 'Second' },
				{ id: Id('post-3'), title: 'Third' },
			]);

			expect(callbackCount).toBe(1);
			expect(allChangedIds[0]?.size).toBe(3);
			expect(allChangedIds[0]?.has(Id('post-1'))).toBe(true);
			expect(allChangedIds[0]?.has(Id('post-2'))).toBe(true);
			expect(allChangedIds[0]?.has('post-3')).toBe(true);
		});

		test('transaction batching: multiple updates in transact fires callback once', () => {
			const ydoc = new Y.Doc({ guid: 'test-batch-update' });
			const tables = createTables(ydoc, [
				table({
					id: 'posts',
					name: '',
					fields: [
						id(),
						text({ id: 'title' }),
						integer({ id: 'view_count' }),
					] as const,
				}),
			]);

			tables.get('posts').upsertMany([
				{ id: Id('post-1'), title: 'First', view_count: 0 },
				{ id: Id('post-2'), title: 'Second', view_count: 0 },
			]);

			let callbackCount = 0;
			const allChangedIds: Set<string>[] = [];

			tables.get('posts').observe((changedIds) => {
				callbackCount++;
				allChangedIds.push(new Set(changedIds));
			});

			ydoc.transact(() => {
				tables
					.get('posts')
					.update({ id: Id('post-1'), title: 'Updated First' });
				tables
					.get('posts')
					.update({ id: Id('post-2'), title: 'Updated Second' });
			});

			expect(callbackCount).toBe(1);
			expect(allChangedIds[0]?.size).toBe(2);
			expect(allChangedIds[0]?.has(Id('post-1'))).toBe(true);
			expect(allChangedIds[0]?.has(Id('post-2'))).toBe(true);
		});

		test('transaction batching: mixed operations in transact fires callback once', () => {
			const ydoc = new Y.Doc({ guid: 'test-batch-mixed' });
			const tables = createTables(ydoc, [
				table({
					id: 'posts',
					name: '',
					fields: [id(), text({ id: 'title' })] as const,
				}),
			]);

			tables.get('posts').upsert({ id: Id('post-1'), title: 'First' });

			let callbackCount = 0;
			let lastChangedIds: Set<string> = new Set();

			tables.get('posts').observe((changedIds) => {
				callbackCount++;
				lastChangedIds = new Set(changedIds);
			});

			ydoc.transact(() => {
				tables.get('posts').update({ id: Id('post-1'), title: 'Updated' });
				tables.get('posts').upsert({ id: Id('post-2'), title: 'New' });
				tables.get('posts').delete(Id('post-1'));
			});

			expect(callbackCount).toBe(1);
			// post-1 was deleted, post-2 was added - both should be in changed set
			expect(lastChangedIds.has(Id('post-1'))).toBe(true);
			expect(lastChangedIds.has(Id('post-2'))).toBe(true);
			// Verify the actual state: post-1 deleted, post-2 exists
			expect(tables.get('posts').get(Id('post-1')).status).toBe('not_found');
			expect(tables.get('posts').get(Id('post-2')).status).toBe('valid');
		});

		test('transaction batching: deleteMany fires callback once', () => {
			const ydoc = new Y.Doc({ guid: 'test-batch-delete' });
			const tables = createTables(ydoc, [
				table({
					id: 'posts',
					name: '',
					fields: [id(), text({ id: 'title' })] as const,
				}),
			]);

			tables.get('posts').upsertMany([
				{ id: Id('post-1'), title: 'First' },
				{ id: Id('post-2'), title: 'Second' },
				{ id: Id('post-3'), title: 'Third' },
			]);

			let callbackCount = 0;
			let lastChangedIds: Set<string> = new Set();

			tables.get('posts').observe((changedIds) => {
				callbackCount++;
				lastChangedIds = new Set(changedIds);
			});

			tables.get('posts').deleteMany([Id('post-1'), Id('post-2')]);

			expect(callbackCount).toBe(1);
			expect(lastChangedIds.size).toBe(2);
			expect(lastChangedIds.has(Id('post-1'))).toBe(true);
			expect(lastChangedIds.has(Id('post-2'))).toBe(true);
			// Verify they were actually deleted
			expect(tables.get('posts').get(Id('post-1')).status).toBe('not_found');
			expect(tables.get('posts').get(Id('post-2')).status).toBe('not_found');
		});

		test('same-row dedupe: multiple updates in one transaction emits final value', () => {
			const ydoc = new Y.Doc({ guid: 'test-dedupe' });
			const tables = createTables(ydoc, [
				table({
					id: 'posts',
					name: '',
					fields: [
						id(),
						text({ id: 'title' }),
						integer({ id: 'view_count' }),
					] as const,
				}),
			]);

			tables.get('posts').upsert({
				id: Id('post-1'),
				title: 'Original',
				view_count: 0,
			});

			let callbackCount = 0;
			type ChangeRecord = {
				title?: string;
				view_count?: number;
			};
			let lastChange: ChangeRecord | null = null;

			tables.get('posts').observe((changedIds) => {
				callbackCount++;
				if (changedIds.has(Id('post-1'))) {
					const result = tables.get('posts').get(Id('post-1'));
					if (result.status === 'valid') {
						lastChange = {
							title: result.row.title,
							view_count: result.row.view_count,
						};
					}
				}
			});

			ydoc.transact(() => {
				tables.get('posts').update({ id: Id('post-1'), title: 'First Update' });
				tables
					.get('posts')
					.update({ id: Id('post-1'), title: 'Second Update' });
				tables.get('posts').update({ id: Id('post-1'), view_count: 100 });
			});

			expect(callbackCount).toBe(1);
			expect(lastChange).not.toBeNull();
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			const change = lastChange!;
			// New API doesn't provide action type, but we can verify final values
			expect(change.title).toBe('Second Update');
			expect(change.view_count).toBe(100);
		});

		test('row added then deleted emits change', () => {
			const ydoc = new Y.Doc({ guid: 'test-row-add-delete' });

			const tables = createTables(ydoc, [
				table({
					id: 'posts',
					name: '',
					fields: [id(), text({ id: 'title' })] as const,
				}),
			]);

			// Use a Set to collect unique IDs (observer may fire multiple times)
			const changedRowIds = new Set<string>();
			tables.get('posts').observe((changedIds) => {
				for (const rowId of changedIds) {
					changedRowIds.add(rowId);
				}
			});

			// Directly manipulate the underlying Y.Array to simulate add then delete
			// With cell-level storage, we need to insert cell keys (rowId:fieldId)
			const yarray = ydoc.getArray<{ key: string; val: unknown; ts: number }>(
				'table:posts',
			);

			// Add a row (cell-level keys)
			const now = Date.now();
			yarray.push([
				{ key: 'temp-row:id', val: 'temp-row', ts: now },
				{ key: 'temp-row:title', val: 'Temporary', ts: now },
			]);

			// Delete the row (in YKeyValueLww, delete removes all cells)
			tables.get('posts').delete(Id('temp-row'));

			// The row ID should be in the changed set; verify deletion via get()
			expect(changedRowIds.has(Id('temp-row'))).toBe(true);
			expect(tables.get('posts').get(Id('temp-row')).status).toBe('not_found');
		});

		test('observer isolation: changes in other tables do not trigger callback', () => {
			const ydoc = new Y.Doc({ guid: 'test-isolation' });
			const tables = createTables(ydoc, [
				table({
					id: 'posts',
					name: '',
					fields: [id(), text({ id: 'title' })] as const,
				}),
				table({
					id: 'comments',
					name: '',
					fields: [id(), text({ id: 'content' })] as const,
				}),
			]);

			const postsChanges: string[] = [];
			tables.get('posts').observe((changedIds) => {
				for (const rowId of changedIds) {
					postsChanges.push(rowId);
				}
			});

			tables.get('comments').upsert({ id: Id('comment-1'), content: 'Hello' });
			tables
				.get('comments')
				.update({ id: Id('comment-1'), content: 'Updated' });
			tables.get('comments').delete(Id('comment-1'));

			expect(postsChanges).toHaveLength(0);

			tables.get('posts').upsert({ id: Id('post-1'), title: 'Test' });
			expect(postsChanges).toContain('post-1');
		});

		test('callback fires after transaction completes, not during', () => {
			const ydoc = new Y.Doc({ guid: 'test-timing' });
			const tables = createTables(ydoc, [
				table({
					id: 'posts',
					name: '',
					fields: [id(), text({ id: 'title' })] as const,
				}),
			]);

			tables.get('posts').upsert({ id: Id('post-1'), title: 'Original' });

			let callbackCalled = false;

			tables.get('posts').observe(() => {
				callbackCalled = true;
			});

			ydoc.transact(() => {
				tables.get('posts').update({ id: Id('post-1'), title: 'Updated' });
				expect(callbackCalled).toBe(false);
			});

			expect(callbackCalled).toBe(true);
		});

		test('multiple subscribers receive same changes', () => {
			const ydoc = new Y.Doc({ guid: 'test-multi-sub' });
			const tables = createTables(ydoc, [
				table({
					id: 'posts',
					name: '',
					fields: [id(), text({ id: 'title' })] as const,
				}),
			]);

			// Use Sets to collect unique IDs (observer may fire multiple times per transaction)
			const subscriber1Changes = new Set<string>();
			const subscriber2Changes = new Set<string>();

			const unsub1 = tables.get('posts').observe((changedIds) => {
				for (const rowId of changedIds) {
					subscriber1Changes.add(rowId);
				}
			});

			const unsub2 = tables.get('posts').observe((changedIds) => {
				for (const rowId of changedIds) {
					subscriber2Changes.add(rowId);
				}
			});

			tables.get('posts').upsert({ id: Id('post-1'), title: 'Test' });

			expect(subscriber1Changes.has(Id('post-1'))).toBe(true);
			expect(subscriber2Changes.has(Id('post-1'))).toBe(true);

			unsub1();

			tables.get('posts').upsert({ id: Id('post-2'), title: 'Second' });

			// Subscriber 1 unsubscribed, should not see post-2
			expect(subscriber1Changes.has(Id('post-2'))).toBe(false);
			// Subscriber 2 should see both
			expect(subscriber2Changes.has(Id('post-1'))).toBe(true);
			expect(subscriber2Changes.has(Id('post-2'))).toBe(true);

			unsub2();
		});
	});

	describe('dynamic table access', () => {
		test('table() returns typed helper for defined tables', () => {
			const ydoc = new Y.Doc({ guid: 'test-workspace' });
			const tables = createTables(ydoc, [
				table({
					id: 'posts',
					name: 'Posts',
					fields: [id(), text({ id: 'title' })] as const,
				}),
			]);

			// Access via table() should work the same as direct access
			tables.get('posts').upsert({ id: Id('1'), title: 'Hello' });
			const result = tables.get('posts').get(Id('1'));
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.row.title).toBe('Hello');
			}

			// Same as direct access
			expect(tables.get('posts').count()).toBe(tables.get('posts').count());
		});

		test('get() throws for undefined tables', () => {
			const ydoc = new Y.Doc({ guid: 'test-workspace' });
			const tables = createTables(ydoc, [
				table({
					id: 'posts',
					name: 'Posts',
					fields: [id(), text({ id: 'title' })] as const,
				}),
			]);

			// Accessing a table not in definition should throw
			// Use `as any` to bypass TypeScript - we're testing runtime error handling
			expect(() => tables.get('custom_data' as any)).toThrow(
				/Table 'custom_data' not found/,
			);
			expect(() => tables.get('custom_data' as any)).toThrow(
				/Available tables: posts/,
			);
		});

		test('get() returns the same helper instance on repeated calls', () => {
			const ydoc = new Y.Doc({ guid: 'test-workspace' });
			const tables = createTables(ydoc, [
				table({
					id: 'posts',
					name: 'Posts',
					fields: [id(), text({ id: 'title' })] as const,
				}),
			]);

			// Same instance is returned for defined tables
			expect(tables.get('posts')).toBe(tables.get('posts'));
		});

		test('has() checks if defined table has data', () => {
			const ydoc = new Y.Doc({ guid: 'test-workspace' });
			const tables = createTables(ydoc, [
				table({
					id: 'posts',
					name: 'Posts',
					fields: [id(), text({ id: 'title' })] as const,
				}),
			]);

			// Initially no data in defined tables
			expect(tables.has('posts')).toBe(false);

			// Undefined tables always return false
			expect(tables.has('custom')).toBe(false);

			// After upsert, table has data
			tables.get('posts').upsert({ id: Id('1'), title: 'Hello' });
			expect(tables.has('posts')).toBe(true);

			// Undefined tables still return false
			expect(tables.has('custom')).toBe(false);
		});
	});

	describe('iteration methods', () => {
		test('names() returns defined table names that have data', () => {
			const ydoc = new Y.Doc({ guid: 'test-workspace' });
			const tables = createTables(ydoc, [
				table({
					id: 'posts',
					name: 'Posts',
					fields: [id(), text({ id: 'title' })] as const,
				}),
				table({
					id: 'users',
					name: 'Users',
					fields: [id(), text({ id: 'name' })] as const,
				}),
			]);

			// Initially empty
			expect(tables.names()).toHaveLength(0);

			// After adding data to one table
			tables.get('posts').upsert({ id: Id('1'), title: 'Hello' });
			expect(tables.names()).toEqual(['posts']);

			// After adding data to another table
			tables.get('users').upsert({ id: Id('1'), name: 'Alice' });
			expect(tables.names().sort()).toEqual(['posts', 'users']);
		});
	});

	describe('new property names (non-$ prefixed)', () => {
		test('definitions property provides table definitions', () => {
			const ydoc = new Y.Doc({ guid: 'test-workspace' });
			const tables = createTables(ydoc, [
				table({
					id: 'posts',
					name: 'Posts',
					description: 'Blog posts',
					fields: [id(), text({ id: 'title' })] as const,
				}),
			]);

			const postsDefinition = tables.definitions.find((t) => t.id === 'posts');
			expect(postsDefinition?.name).toBe('Posts');
			expect(postsDefinition?.description).toBe('Blog posts');
			expect(postsDefinition?.fields[0]).toBeDefined();
		});
	});
});
