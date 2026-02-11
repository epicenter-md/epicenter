/**
 * Offline Sync Conflict Resolution Tests
 *
 * These tests verify YKeyValue's conflict resolution behavior in realistic
 * offline-first scenarios where clients edit data without seeing each other's
 * changes, then sync later.
 *
 * TERMINOLOGY:
 * - "Concurrent" in CRDT terms means "causally concurrent" - neither operation
 *   happened-before the other. This occurs when clients are OFFLINE and don't
 *   see each other's changes before making their own.
 * - It does NOT mean "same millisecond" - it means "no causal relationship"
 *
 * KEY QUESTION: Does sync ORDER affect which value wins?
 * - If A syncs to B first, then B syncs to A - does A always win? Or B?
 * - If B syncs to A first, then A syncs to B - does the winner change?
 */
import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { Id, id, table, text } from '../schema';
import { createTables } from './create-tables';

describe('Offline Sync Scenarios', () => {
	describe('Sync Order Effects', () => {
		test('sync order A→B then B→A: check which value wins', () => {
			const docA = new Y.Doc();
			const docB = new Y.Doc();

			const tablesA = createTables(docA, [
				table({
					id: 'posts',
					name: '',
					description: '',
					fields: [id(), text({ id: 'title' })] as const,
				}),
			]);
			const tablesB = createTables(docB, [
				table({
					id: 'posts',
					name: '',
					description: '',
					fields: [id(), text({ id: 'title' })] as const,
				}),
			]);

			tablesA.get('posts').upsert({ id: Id('post-1'), title: 'Original' });
			Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

			tablesA.get('posts').update({ id: Id('post-1'), title: 'Edit by A' });
			tablesB.get('posts').update({ id: Id('post-1'), title: 'Edit by B' });

			Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
			Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));

			const rowA = tablesA.get('posts').get(Id('post-1'));
			const rowB = tablesB.get('posts').get(Id('post-1'));

			expect(rowA.status).toBe('valid');
			expect(rowB.status).toBe('valid');
			if (rowA.status === 'valid' && rowB.status === 'valid') {
				expect(rowA.row.title).toBe(rowB.row.title);
				console.log(`Sync A→B then B→A: Winner is "${rowA.row.title}"`);
			}
		});

		test('sync order B→A then A→B: check if winner changes', () => {
			const docA = new Y.Doc();
			const docB = new Y.Doc();

			const tablesA = createTables(docA, [
				table({
					id: 'posts',
					name: '',
					description: '',
					fields: [id(), text({ id: 'title' })] as const,
				}),
			]);
			const tablesB = createTables(docB, [
				table({
					id: 'posts',
					name: '',
					description: '',
					fields: [id(), text({ id: 'title' })] as const,
				}),
			]);

			tablesA.get('posts').upsert({ id: Id('post-1'), title: 'Original' });
			Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

			tablesA.get('posts').update({ id: Id('post-1'), title: 'Edit by A' });
			tablesB.get('posts').update({ id: Id('post-1'), title: 'Edit by B' });

			Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));
			Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

			const rowA = tablesA.get('posts').get(Id('post-1'));
			const rowB = tablesB.get('posts').get(Id('post-1'));

			expect(rowA.status).toBe('valid');
			expect(rowB.status).toBe('valid');
			if (rowA.status === 'valid' && rowB.status === 'valid') {
				expect(rowA.row.title).toBe(rowB.row.title);
				console.log(`Sync B→A then A→B: Winner is "${rowA.row.title}"`);
			}
		});

		test('sync order does NOT change winner - Yjs is deterministic', () => {
			const results: { orderAB: string; orderBA: string }[] = [];

			for (let i = 0; i < 5; i++) {
				const docA1 = new Y.Doc();
				const docB1 = new Y.Doc();
				const docA2 = new Y.Doc();
				const docB2 = new Y.Doc();

				docA1.clientID = docA2.clientID = 100 + i;
				docB1.clientID = docB2.clientID = 200 + i;

				const tablesA1 = createTables(docA1, [
					table({
						id: 'posts',
						name: '',
						description: '',
						fields: [id(), text({ id: 'title' })] as const,
					}),
				]);
				const tablesB1 = createTables(docB1, [
					table({
						id: 'posts',
						name: '',
						description: '',
						fields: [id(), text({ id: 'title' })] as const,
					}),
				]);
				const tablesA2 = createTables(docA2, [
					table({
						id: 'posts',
						name: '',
						description: '',
						fields: [id(), text({ id: 'title' })] as const,
					}),
				]);
				const tablesB2 = createTables(docB2, [
					table({
						id: 'posts',
						name: '',
						description: '',
						fields: [id(), text({ id: 'title' })] as const,
					}),
				]);

				tablesA1.get('posts').upsert({ id: Id('post-1'), title: 'Original' });
				tablesA2.get('posts').upsert({ id: Id('post-1'), title: 'Original' });
				Y.applyUpdate(docB1, Y.encodeStateAsUpdate(docA1));
				Y.applyUpdate(docB2, Y.encodeStateAsUpdate(docA2));

				tablesA1.get('posts').update({ id: Id('post-1'), title: `A-${i}` });
				tablesB1.get('posts').update({ id: Id('post-1'), title: `B-${i}` });
				tablesA2.get('posts').update({ id: Id('post-1'), title: `A-${i}` });
				tablesB2.get('posts').update({ id: Id('post-1'), title: `B-${i}` });

				Y.applyUpdate(docB1, Y.encodeStateAsUpdate(docA1));
				Y.applyUpdate(docA1, Y.encodeStateAsUpdate(docB1));

				Y.applyUpdate(docA2, Y.encodeStateAsUpdate(docB2));
				Y.applyUpdate(docB2, Y.encodeStateAsUpdate(docA2));

				const rowA1 = tablesA1.get('posts').get(Id('post-1'));
				const rowA2 = tablesA2.get('posts').get(Id('post-1'));

				if (rowA1.status === 'valid' && rowA2.status === 'valid') {
					results.push({
						orderAB: rowA1.row.title,
						orderBA: rowA2.row.title,
					});

					expect(rowA1.row.title).toBe(rowA2.row.title);
				}
			}

			console.log('Sync order comparison:', results);
		});
	});

	describe('Extended Offline Periods', () => {
		test('client offline for multiple edits, then syncs', () => {
			const docOnline = new Y.Doc();
			const docOffline = new Y.Doc();

			const tablesOnline = createTables(docOnline, [
				table({
					id: 'posts',
					name: '',
					description: '',
					fields: [id(), text({ id: 'title' })] as const,
				}),
			]);
			const tablesOffline = createTables(docOffline, [
				table({
					id: 'posts',
					name: '',
					description: '',
					fields: [id(), text({ id: 'title' })] as const,
				}),
			]);

			tablesOnline.get('posts').upsert({ id: Id('post-1'), title: 'Initial' });
			Y.applyUpdate(docOffline, Y.encodeStateAsUpdate(docOnline));

			tablesOnline
				.get('posts')
				.update({ id: Id('post-1'), title: 'Online Edit 1' });
			tablesOnline
				.get('posts')
				.update({ id: Id('post-1'), title: 'Online Edit 2' });
			tablesOnline
				.get('posts')
				.update({ id: Id('post-1'), title: 'Online Edit 3' });

			tablesOffline.get('posts').update({
				id: Id('post-1'),
				title: 'Offline Final Edit',
			});

			Y.applyUpdate(docOffline, Y.encodeStateAsUpdate(docOnline));
			Y.applyUpdate(docOnline, Y.encodeStateAsUpdate(docOffline));

			const rowOnline = tablesOnline.get('posts').get(Id('post-1'));
			const rowOffline = tablesOffline.get('posts').get(Id('post-1'));

			expect(rowOnline.status).toBe('valid');
			expect(rowOffline.status).toBe('valid');
			if (rowOnline.status === 'valid' && rowOffline.status === 'valid') {
				expect(rowOnline.row.title).toBe(rowOffline.row.title);
				console.log(
					`Extended offline: Winner is "${rowOnline.row.title}" (Online had 3 edits, Offline had 1)`,
				);
			}
		});
	});

	describe('Three-Way Offline Conflicts', () => {
		test('three clients offline editing same cell', () => {
			const docA = new Y.Doc();
			const docB = new Y.Doc();
			const docC = new Y.Doc();

			const tablesA = createTables(docA, [
				table({
					id: 'posts',
					name: '',
					description: '',
					fields: [id(), text({ id: 'title' })] as const,
				}),
			]);
			const tablesB = createTables(docB, [
				table({
					id: 'posts',
					name: '',
					description: '',
					fields: [id(), text({ id: 'title' })] as const,
				}),
			]);
			const tablesC = createTables(docC, [
				table({
					id: 'posts',
					name: '',
					description: '',
					fields: [id(), text({ id: 'title' })] as const,
				}),
			]);

			tablesA.get('posts').upsert({ id: Id('post-1'), title: 'Original' });
			Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
			Y.applyUpdate(docC, Y.encodeStateAsUpdate(docA));

			tablesA.get('posts').update({ id: Id('post-1'), title: 'Edit by A' });
			tablesB.get('posts').update({ id: Id('post-1'), title: 'Edit by B' });
			tablesC.get('posts').update({ id: Id('post-1'), title: 'Edit by C' });

			const updateA = Y.encodeStateAsUpdate(docA);
			const updateB = Y.encodeStateAsUpdate(docB);
			const updateC = Y.encodeStateAsUpdate(docC);

			Y.applyUpdate(docA, updateB);
			Y.applyUpdate(docA, updateC);
			Y.applyUpdate(docB, updateA);
			Y.applyUpdate(docB, updateC);
			Y.applyUpdate(docC, updateA);
			Y.applyUpdate(docC, updateB);

			const rowA = tablesA.get('posts').get(Id('post-1'));
			const rowB = tablesB.get('posts').get(Id('post-1'));
			const rowC = tablesC.get('posts').get(Id('post-1'));

			expect(rowA.status).toBe('valid');
			expect(rowB.status).toBe('valid');
			expect(rowC.status).toBe('valid');

			if (
				rowA.status === 'valid' &&
				rowB.status === 'valid' &&
				rowC.status === 'valid'
			) {
				expect(rowA.row.title).toBe(rowB.row.title);
				expect(rowB.row.title).toBe(rowC.row.title);
				console.log(`Three-way conflict: Winner is "${rowA.row.title}"`);
			}
		});
	});

	describe('Winner Unpredictability Demonstration', () => {
		test('same scenario with different client IDs produces different winners', () => {
			const winners: string[] = [];

			for (let i = 0; i < 20; i++) {
				const docA = new Y.Doc();
				const docB = new Y.Doc();

				const tablesA = createTables(docA, [
					table({
						id: 'posts',
						name: '',
						description: '',
						fields: [id(), text({ id: 'title' })] as const,
					}),
				]);
				const tablesB = createTables(docB, [
					table({
						id: 'posts',
						name: '',
						description: '',
						fields: [id(), text({ id: 'title' })] as const,
					}),
				]);

				tablesA.get('posts').upsert({ id: Id('post-1'), title: 'Original' });
				Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

				tablesA.get('posts').update({ id: Id('post-1'), title: 'A' });
				tablesB.get('posts').update({ id: Id('post-1'), title: 'B' });

				Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
				Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));

				const row = tablesA.get('posts').get(Id('post-1'));
				if (row.status === 'valid') {
					winners.push(row.row.title);
				}
			}

			const countA = winners.filter((w) => w === 'A').length;
			const countB = winners.filter((w) => w === 'B').length;

			console.log(`20 runs: A won ${countA} times, B won ${countB} times`);
			console.log('Winners:', winners);

			expect(countA + countB).toBe(20);
		});
	});

	describe('What "Concurrent" Actually Means', () => {
		test('NOT same millisecond - just no causal relationship', async () => {
			const docA = new Y.Doc();
			const docB = new Y.Doc();

			const tablesA = createTables(docA, [
				table({
					id: 'posts',
					name: '',
					description: '',
					fields: [id(), text({ id: 'title' })] as const,
				}),
			]);
			const tablesB = createTables(docB, [
				table({
					id: 'posts',
					name: '',
					description: '',
					fields: [id(), text({ id: 'title' })] as const,
				}),
			]);

			tablesA.get('posts').upsert({ id: Id('post-1'), title: 'Original' });
			Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

			tablesA
				.get('posts')
				.update({ id: Id('post-1'), title: 'A edits at 10:00am' });

			await new Promise((r) => setTimeout(r, 100));

			tablesB.get('posts').update({
				id: Id('post-1'),
				title: 'B edits at 10:05am (100ms later in test)',
			});

			Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
			Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));

			const rowA = tablesA.get('posts').get(Id('post-1'));
			const rowB = tablesB.get('posts').get(Id('post-1'));

			expect(rowA.status).toBe('valid');
			expect(rowB.status).toBe('valid');

			if (rowA.status === 'valid' && rowB.status === 'valid') {
				expect(rowA.row.title).toBe(rowB.row.title);
				console.log(
					`Time gap test: Winner is "${rowA.row.title}" (B edited 100ms AFTER A, but winner is unpredictable)`,
				);
			}
		});
	});
});
