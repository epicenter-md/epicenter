/**
 * Cell-Level LWW (Last-Write-Wins) CRDT Sync Tests
 *
 * These tests verify cell-level LWW conflict resolution where each field
 * has its own timestamp. Unlike row-level LWW, concurrent edits to
 * DIFFERENT fields merge independently.
 *
 * Key behaviors:
 * - Concurrent edits to SAME field: latest timestamp wins
 * - Concurrent edits to DIFFERENT fields: BOTH preserved (merge)
 * - Delete removes all cells for a row
 */
import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { boolean, Id, id, integer, table, text } from '../schema';
import { createTables } from './create-tables';

describe('Cell-Level LWW CRDT Merging', () => {
	test('concurrent edits to different fields: both preserved (merge)', async () => {
		const doc1 = new Y.Doc();
		const doc2 = new Y.Doc();
		doc1.clientID = 1;
		doc2.clientID = 2;

		const tables1 = createTables(doc1, [
			table({
				id: 'posts',
				name: '',
				fields: [
					id(),
					text({ id: 'title' }),
					integer({ id: 'views' }),
					boolean({ id: 'published' }),
				] as const,
			}),
		]);

		const tables2 = createTables(doc2, [
			table({
				id: 'posts',
				name: '',
				fields: [
					id(),
					text({ id: 'title' }),
					integer({ id: 'views' }),
					boolean({ id: 'published' }),
				] as const,
			}),
		]);

		// Create initial row in doc1
		tables1.get('posts').upsert({
			id: Id('post-1'),
			title: 'Original',
			views: 0,
			published: false,
		});

		// Sync to doc2
		Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

		// Verify both have the same initial state
		const row1Before = tables1.get('posts').get(Id('post-1'));
		const row2Before = tables2.get('posts').get(Id('post-1'));
		expect(row1Before.status).toBe('valid');
		expect(row2Before.status).toBe('valid');

		// Small delay to ensure timestamps are different
		await new Promise((resolve) => setTimeout(resolve, 2));

		// User 1 updates title (earlier timestamp)
		tables1
			.get('posts')
			.update({ id: Id('post-1'), title: 'Updated by User 1' });

		// Small delay to ensure User 2's timestamp is later
		await new Promise((resolve) => setTimeout(resolve, 2));

		// User 2 updates views (later timestamp, DIFFERENT field)
		tables2.get('posts').update({ id: Id('post-1'), views: 100 });

		// Sync both ways
		Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));
		Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2));

		// After sync, both docs should have the SAME state
		// Cell-level LWW means BOTH edits are preserved (different fields)
		const row1After = tables1.get('posts').get(Id('post-1'));
		const row2After = tables2.get('posts').get(Id('post-1'));

		expect(row1After.status).toBe('valid');
		expect(row2After.status).toBe('valid');

		if (row1After.status === 'valid' && row2After.status === 'valid') {
			// Both should have identical state
			expect(row1After.row.title).toBe(row2After.row.title);
			expect(row1After.row.views).toBe(row2After.row.views);
			expect(row1After.row.published).toBe(row2After.row.published);

			// Cell-level merge: both edits preserved
			// User 1's title edit is preserved
			expect(row1After.row.title).toBe('Updated by User 1');
			// User 2's views edit is preserved
			expect(row1After.row.views).toBe(100);
		}
	});

	test('concurrent edits to same field: latest timestamp wins', async () => {
		const doc1 = new Y.Doc();
		const doc2 = new Y.Doc();
		doc1.clientID = 1;
		doc2.clientID = 2;

		const tables1 = createTables(doc1, [
			table({
				id: 'posts',
				name: '',
				fields: [
					id(),
					text({ id: 'title' }),
					integer({ id: 'views' }),
				] as const,
			}),
		]);

		const tables2 = createTables(doc2, [
			table({
				id: 'posts',
				name: '',
				fields: [
					id(),
					text({ id: 'title' }),
					integer({ id: 'views' }),
				] as const,
			}),
		]);

		// Create initial row in doc1
		tables1.get('posts').upsert({
			id: Id('post-1'),
			title: 'Original',
			views: 0,
		});

		// Sync to doc2
		Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

		// Small delay to ensure timestamps are different
		await new Promise((resolve) => setTimeout(resolve, 2));

		// User 1 updates title (earlier timestamp)
		tables1.get('posts').update({ id: Id('post-1'), title: 'Title by User 1' });

		// Small delay to ensure User 2's timestamp is later
		await new Promise((resolve) => setTimeout(resolve, 2));

		// User 2 updates the SAME field (title) with later timestamp
		tables2.get('posts').update({ id: Id('post-1'), title: 'Title by User 2' });

		// Sync both ways
		Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));
		Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2));

		// After sync, the later timestamp should win
		const row1After = tables1.get('posts').get(Id('post-1'));
		const row2After = tables2.get('posts').get(Id('post-1'));

		expect(row1After.status).toBe('valid');
		expect(row2After.status).toBe('valid');

		if (row1After.status === 'valid' && row2After.status === 'valid') {
			// Both should have identical state
			expect(row1After.row.title).toBe(row2After.row.title);

			// User 2's edit had the later timestamp, so it wins
			expect(row1After.row.title).toBe('Title by User 2');
		}
	});

	test('concurrent edits to different rows: both preserved', () => {
		const doc1 = new Y.Doc();
		const doc2 = new Y.Doc();
		doc1.clientID = 1;
		doc2.clientID = 2;

		const tables1 = createTables(doc1, [
			table({
				id: 'posts',
				name: '',
				fields: [id(), text({ id: 'title' })] as const,
			}),
		]);

		const tables2 = createTables(doc2, [
			table({
				id: 'posts',
				name: '',
				fields: [id(), text({ id: 'title' })] as const,
			}),
		]);

		// Each user creates a different row
		tables1.get('posts').upsert({ id: Id('post-1'), title: 'Post by User 1' });
		tables2.get('posts').upsert({ id: Id('post-2'), title: 'Post by User 2' });

		// Sync both ways
		Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));
		Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2));

		// Both docs should have both rows
		expect(tables1.get('posts').count()).toBe(2);
		expect(tables2.get('posts').count()).toBe(2);

		const doc1Post1 = tables1.get('posts').get(Id('post-1'));
		const doc1Post2 = tables1.get('posts').get(Id('post-2'));
		const doc2Post1 = tables2.get('posts').get(Id('post-1'));
		const doc2Post2 = tables2.get('posts').get(Id('post-2'));

		expect(doc1Post1.status).toBe('valid');
		expect(doc1Post2.status).toBe('valid');
		expect(doc2Post1.status).toBe('valid');
		expect(doc2Post2.status).toBe('valid');

		if (doc1Post1.status === 'valid') {
			expect(doc1Post1.row.title).toBe('Post by User 1');
		}
		if (doc1Post2.status === 'valid') {
			expect(doc1Post2.row.title).toBe('Post by User 2');
		}
	});

	test('upsert survives concurrent delete (no tombstones)', async () => {
		/**
		 * YKeyValueLww uses Y.Array without tombstones for deletes.
		 * This means:
		 * - Delete removes all cells for the row
		 * - Upsert adds new cells with a higher timestamp
		 * - After sync, the upsert entries arrive and win
		 *
		 * Note: With cell-level storage, a partial `update()` after delete would
		 * only restore the updated cells, leaving the row incomplete. Use `upsert`
		 * to fully restore a row after concurrent delete.
		 */
		const doc1 = new Y.Doc();
		const doc2 = new Y.Doc();
		doc1.clientID = 1;
		doc2.clientID = 2;

		const tables1 = createTables(doc1, [
			table({
				id: 'posts',
				name: '',
				fields: [
					id(),
					text({ id: 'title' }),
					integer({ id: 'views' }),
				] as const,
			}),
		]);

		const tables2 = createTables(doc2, [
			table({
				id: 'posts',
				name: '',
				fields: [
					id(),
					text({ id: 'title' }),
					integer({ id: 'views' }),
				] as const,
			}),
		]);

		// Create initial row
		tables1
			.get('posts')
			.upsert({ id: Id('post-1'), title: 'Original', views: 0 });
		Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

		// Small delay
		await new Promise((resolve) => setTimeout(resolve, 2));

		// User 2 deletes the row first
		tables2.get('posts').delete(Id('post-1'));

		// Small delay to ensure upsert has later timestamp
		await new Promise((resolve) => setTimeout(resolve, 2));

		// User 1 upserts the row (later timestamp) - full row, not partial update
		tables1
			.get('posts')
			.upsert({ id: Id('post-1'), title: 'Restored', views: 100 });

		// Sync both ways
		Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));
		Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2));

		// Without tombstones, the upsert entries survive and win
		// The row exists on both docs with User 1's values
		const row1After = tables1.get('posts').get(Id('post-1'));
		const row2After = tables2.get('posts').get(Id('post-1'));

		expect(row1After.status).toBe('valid');
		expect(row2After.status).toBe('valid');

		if (row1After.status === 'valid' && row2After.status === 'valid') {
			expect(row1After.row.title).toBe('Restored');
			expect(row1After.row.views).toBe(100);
			expect(row2After.row.title).toBe('Restored');
			expect(row2After.row.views).toBe(100);
		}
	});

	test('three-way sync: all docs converge (same field conflict)', async () => {
		const doc1 = new Y.Doc();
		const doc2 = new Y.Doc();
		const doc3 = new Y.Doc();
		doc1.clientID = 1;
		doc2.clientID = 2;
		doc3.clientID = 3;

		const tableDef = [
			table({
				id: 'posts',
				name: '',
				fields: [id(), text({ id: 'title' })] as const,
			}),
		];

		const tables1 = createTables(doc1, tableDef);
		const tables2 = createTables(doc2, tableDef);
		const tables3 = createTables(doc3, tableDef);

		// Create initial row in doc1
		tables1.get('posts').upsert({ id: Id('post-1'), title: 'Original' });

		// Sync to all docs
		Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));
		Y.applyUpdate(doc3, Y.encodeStateAsUpdate(doc1));

		// Each user makes concurrent edits to the SAME field with increasing timestamps
		await new Promise((resolve) => setTimeout(resolve, 2));
		tables1.get('posts').update({ id: Id('post-1'), title: 'Title by User 1' });

		await new Promise((resolve) => setTimeout(resolve, 2));
		tables2.get('posts').update({ id: Id('post-1'), title: 'Title by User 2' });

		await new Promise((resolve) => setTimeout(resolve, 2));
		tables3.get('posts').update({ id: Id('post-1'), title: 'Title by User 3' });

		// Full mesh sync
		Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));
		Y.applyUpdate(doc3, Y.encodeStateAsUpdate(doc1));
		Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2));
		Y.applyUpdate(doc3, Y.encodeStateAsUpdate(doc2));
		Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc3));
		Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc3));

		// All should converge to User 3's title (latest timestamp)
		const row1 = tables1.get('posts').get(Id('post-1'));
		const row2 = tables2.get('posts').get(Id('post-1'));
		const row3 = tables3.get('posts').get(Id('post-1'));

		expect(row1.status).toBe('valid');
		expect(row2.status).toBe('valid');
		expect(row3.status).toBe('valid');

		if (
			row1.status === 'valid' &&
			row2.status === 'valid' &&
			row3.status === 'valid'
		) {
			// All should have the same value
			expect(row1.row.title).toBe(row2.row.title);
			expect(row2.row.title).toBe(row3.row.title);

			// User 3 had the latest timestamp
			expect(row3.row.title).toBe('Title by User 3');
		}
	});

	test('timestamp-based determinism: same operations produce same result regardless of sync order', async () => {
		// Create the same scenario twice with different sync orders
		// Both should produce identical final states

		// Scenario A: sync 1→2 then 2→1
		const docA1 = new Y.Doc();
		const docA2 = new Y.Doc();
		docA1.clientID = 1;
		docA2.clientID = 2;

		const tablesA1 = createTables(docA1, [
			table({
				id: 'posts',
				name: '',
				fields: [id(), text({ id: 'title' })] as const,
			}),
		]);
		const tablesA2 = createTables(docA2, [
			table({
				id: 'posts',
				name: '',
				fields: [id(), text({ id: 'title' })] as const,
			}),
		]);

		// Scenario B: sync 2→1 then 1→2
		const docB1 = new Y.Doc();
		const docB2 = new Y.Doc();
		docB1.clientID = 1;
		docB2.clientID = 2;

		const tablesB1 = createTables(docB1, [
			table({
				id: 'posts',
				name: '',
				fields: [id(), text({ id: 'title' })] as const,
			}),
		]);
		const tablesB2 = createTables(docB2, [
			table({
				id: 'posts',
				name: '',
				fields: [id(), text({ id: 'title' })] as const,
			}),
		]);

		// Create initial state (synced)
		tablesA1.get('posts').upsert({ id: Id('post-1'), title: 'Original' });
		tablesB1.get('posts').upsert({ id: Id('post-1'), title: 'Original' });

		Y.applyUpdate(docA2, Y.encodeStateAsUpdate(docA1));
		Y.applyUpdate(docB2, Y.encodeStateAsUpdate(docB1));

		// Concurrent edits with controlled timestamps
		await new Promise((resolve) => setTimeout(resolve, 2));
		const editTime1 = Date.now();
		tablesA1.get('posts').update({ id: Id('post-1'), title: 'Edit by 1' });
		tablesB1.get('posts').update({ id: Id('post-1'), title: 'Edit by 1' });

		await new Promise((resolve) => setTimeout(resolve, 2));
		const editTime2 = Date.now();
		tablesA2.get('posts').update({ id: Id('post-1'), title: 'Edit by 2' });
		tablesB2.get('posts').update({ id: Id('post-1'), title: 'Edit by 2' });

		// Different sync orders
		// Scenario A: 1→2 then 2→1
		Y.applyUpdate(docA2, Y.encodeStateAsUpdate(docA1));
		Y.applyUpdate(docA1, Y.encodeStateAsUpdate(docA2));

		// Scenario B: 2→1 then 1→2
		Y.applyUpdate(docB1, Y.encodeStateAsUpdate(docB2));
		Y.applyUpdate(docB2, Y.encodeStateAsUpdate(docB1));

		// Both scenarios should produce identical results
		const rowA1 = tablesA1.get('posts').get(Id('post-1'));
		const rowA2 = tablesA2.get('posts').get(Id('post-1'));
		const rowB1 = tablesB1.get('posts').get(Id('post-1'));
		const rowB2 = tablesB2.get('posts').get(Id('post-1'));

		expect(rowA1.status).toBe('valid');
		expect(rowA2.status).toBe('valid');
		expect(rowB1.status).toBe('valid');
		expect(rowB2.status).toBe('valid');

		if (
			rowA1.status === 'valid' &&
			rowA2.status === 'valid' &&
			rowB1.status === 'valid' &&
			rowB2.status === 'valid'
		) {
			// All four should converge to the same value
			expect(rowA1.row.title).toBe(rowA2.row.title);
			expect(rowB1.row.title).toBe(rowB2.row.title);
			expect(rowA1.row.title).toBe(rowB1.row.title);

			// User 2's edit had a later timestamp, so it should win
			expect(rowA1.row.title).toBe('Edit by 2');
		}
	});

	test('upsert creates new entry even if previously deleted', async () => {
		const doc1 = new Y.Doc();
		const doc2 = new Y.Doc();
		doc1.clientID = 1;
		doc2.clientID = 2;

		const tables1 = createTables(doc1, [
			table({
				id: 'posts',
				name: '',
				fields: [id(), text({ id: 'title' })] as const,
			}),
		]);

		const tables2 = createTables(doc2, [
			table({
				id: 'posts',
				name: '',
				fields: [id(), text({ id: 'title' })] as const,
			}),
		]);

		// Create and delete a row
		tables1.get('posts').upsert({ id: Id('post-1'), title: 'First version' });
		Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

		await new Promise((resolve) => setTimeout(resolve, 2));
		tables1.get('posts').delete(Id('post-1'));
		Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

		// Verify deleted on both
		expect(tables1.get('posts').get(Id('post-1')).status).toBe('not_found');
		expect(tables2.get('posts').get(Id('post-1')).status).toBe('not_found');

		// Re-create with same ID (later timestamp)
		await new Promise((resolve) => setTimeout(resolve, 2));
		tables1.get('posts').upsert({ id: Id('post-1'), title: 'Second version' });
		Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

		// Both should see the new version
		const row1 = tables1.get('posts').get(Id('post-1'));
		const row2 = tables2.get('posts').get(Id('post-1'));

		expect(row1.status).toBe('valid');
		expect(row2.status).toBe('valid');

		if (row1.status === 'valid' && row2.status === 'valid') {
			expect(row1.row.title).toBe('Second version');
			expect(row2.row.title).toBe('Second version');
		}
	});
});
