/**
 * The Case FOR Y.Map of Y.Maps (Native YJS)
 *
 * This test file explores whether the simplicity of native Y.Map
 * outweighs the benefits of YKeyValue approaches.
 */
import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';

// ============================================================================
// HELPER: Native Y.Map Table (dead simple)
// ============================================================================

function createSimpleTable(ydoc: Y.Doc, name: string) {
	const table = ydoc.getMap<Y.Map<unknown>>(name);

	return {
		upsert(row: Record<string, unknown>) {
			const id = row.id as string;
			let rowMap = table.get(id);
			if (!rowMap) {
				rowMap = new Y.Map();
				table.set(id, rowMap);
			}
			ydoc.transact(() => {
				for (const [key, val] of Object.entries(row)) {
					rowMap!.set(key, val);
				}
			});
		},
		get(id: string) {
			const rowMap = table.get(id);
			if (!rowMap) return undefined;
			const row: Record<string, unknown> = {};
			for (const [key, val] of rowMap.entries()) {
				row[key] = val;
			}
			return row;
		},
		update(partial: Record<string, unknown>) {
			const id = partial.id as string;
			const rowMap = table.get(id);
			if (!rowMap) return;
			ydoc.transact(() => {
				for (const [key, val] of Object.entries(partial)) {
					rowMap.set(key, val);
				}
			});
		},
		count: () => table.size,
	};
}

// ============================================================================
// REALISTIC USAGE PATTERNS
// ============================================================================

describe('Realistic Storage Comparison', () => {
	test('SCENARIO 1: Blog posts - write once, rarely update', () => {
		console.log(
			'\n=== SCENARIO 1: Blog Posts (Write Once, Rarely Update) ===\n',
		);

		const ydoc = new Y.Doc();
		const posts = createSimpleTable(ydoc, 'posts');

		// Create 100 blog posts (typical small blog)
		for (let i = 0; i < 100; i++) {
			posts.upsert({
				id: `post-${i}`,
				title: `Blog Post Title ${i}`,
				content: `This is the content of blog post ${i}. `.repeat(10), // ~400 chars
				author: 'john_doe',
				publishedAt: new Date().toISOString(),
				views: 0,
				tags: ['blog', 'tech'],
			});
		}

		// Occasional updates: 10% of posts get edited once
		for (let i = 0; i < 10; i++) {
			posts.update({ id: `post-${i}`, title: `Updated: Blog Post Title ${i}` });
		}

		// Views counter updates: 20 posts get 5 view increments each
		for (let i = 0; i < 20; i++) {
			for (let v = 1; v <= 5; v++) {
				posts.update({ id: `post-${i}`, views: v * 10 });
			}
		}

		const size = Y.encodeStateAsUpdate(ydoc).byteLength;
		console.log(`100 posts, 10 title edits, 100 view updates`);
		console.log(`Total size: ${(size / 1024).toFixed(2)} KB`);
		console.log(`Per post: ${(size / 100).toFixed(0)} bytes avg`);

		expect(posts.count()).toBe(100);
	});

	test('SCENARIO 2: User settings - small data, frequent updates', () => {
		console.log(
			'\n=== SCENARIO 2: User Settings (Small, Frequent Updates) ===\n',
		);

		const ydoc = new Y.Doc();
		const settings = createSimpleTable(ydoc, 'settings');

		// One user's settings
		settings.upsert({
			id: 'user-1',
			theme: 'dark',
			fontSize: 14,
			notifications: true,
			language: 'en',
			timezone: 'America/Los_Angeles',
		});

		// User tweaks settings 50 times over months of usage
		for (let i = 0; i < 50; i++) {
			settings.update({ id: 'user-1', fontSize: 12 + (i % 6) });
			settings.update({ id: 'user-1', theme: i % 2 === 0 ? 'dark' : 'light' });
		}

		const size = Y.encodeStateAsUpdate(ydoc).byteLength;
		console.log(`1 user, 100 setting changes`);
		console.log(`Total size: ${size} bytes`);

		// Is this actually a problem? Compare to JSON
		const jsonSize = JSON.stringify(settings.get('user-1')).length;
		console.log(`Final JSON size: ${jsonSize} bytes`);
		console.log(`YJS overhead: ${(size / jsonSize).toFixed(1)}x JSON`);

		expect(settings.get('user-1')?.theme).toBeDefined();
	});

	test('SCENARIO 3: Real-time collaboration - many users, many edits', () => {
		console.log(
			'\n=== SCENARIO 3: Collaborative Doc (Many Users, Many Edits) ===\n',
		);

		const ydoc = new Y.Doc();
		const rows = createSimpleTable(ydoc, 'rows');

		// 10 rows in a spreadsheet-like doc
		for (let i = 0; i < 10; i++) {
			rows.upsert({
				id: `row-${i}`,
				col_a: `A${i}`,
				col_b: `B${i}`,
				col_c: 0,
				col_d: '',
			});
		}

		// 5 users make 20 edits each = 100 total edits
		// But spread across different cells (realistic collaboration)
		for (let user = 0; user < 5; user++) {
			for (let edit = 0; edit < 20; edit++) {
				const rowIdx = (user + edit) % 10;
				const col = ['col_a', 'col_b', 'col_c', 'col_d'][edit % 4]!;
				rows.update({
					id: `row-${rowIdx}`,
					[col]: `User${user}-Edit${edit}`,
				});
			}
		}

		const size = Y.encodeStateAsUpdate(ydoc).byteLength;
		console.log(`10 rows, 5 users, 100 edits spread across cells`);
		console.log(`Total size: ${(size / 1024).toFixed(2)} KB`);
		console.log(`Per row: ${(size / 10).toFixed(0)} bytes avg`);

		expect(rows.count()).toBe(10);
	});

	test('SCENARIO 4: WORST CASE - counter updated 1000 times', () => {
		console.log('\n=== SCENARIO 4: Worst Case (Counter Updated 1000x) ===\n');

		const ydoc = new Y.Doc();
		const counters = createSimpleTable(ydoc, 'counters');

		counters.upsert({ id: 'page-views', count: 0 });

		// Simulate page view counter updated 1000 times
		for (let i = 1; i <= 1000; i++) {
			counters.update({ id: 'page-views', count: i });
		}

		const size = Y.encodeStateAsUpdate(ydoc).byteLength;
		console.log(`1 counter, 1000 updates`);
		console.log(`Total size: ${(size / 1024).toFixed(2)} KB`);
		console.log(`Per update: ${(size / 1000).toFixed(1)} bytes`);

		// This IS the worst case for Y.Map
		// But ask yourself: would you really store a high-frequency counter in YJS?
		console.log(
			`\n⚠️  NOTE: High-frequency counters shouldn't be in YJS anyway!`,
		);
		console.log(`   Use a separate counter service or aggregate on read.`);

		expect(counters.get('page-views')?.count).toBe(1000);
	});
});

// ============================================================================
// THE SIMPLICITY ARGUMENT
// ============================================================================

describe('The Simplicity Argument', () => {
	test('Y.Map implementation: ZERO custom code', () => {
		console.log('\n=== Implementation Comparison ===\n');

		console.log('Y.Map of Y.Maps:');
		console.log('────────────────');
		console.log('• Lines of code: ~30 (just wrappers)');
		console.log('• Custom CRDT logic: NONE');
		console.log('• Compaction needed: NO');
		console.log('• Clock synchronization: NO');
		console.log('• Battle-tested: YES (core YJS)');
		console.log('');

		console.log('YKeyValue-LWW:');
		console.log('──────────────');
		console.log('• Lines of code: ~200+');
		console.log('• Custom CRDT logic: isNewer(), processRecord()');
		console.log('• Compaction needed: YES (or unbounded growth)');
		console.log('• Clock synchronization: YES (monotonic clock)');
		console.log('• Battle-tested: NO (custom implementation)');

		expect(true).toBe(true);
	});

	test('What can go wrong with custom LWW?', () => {
		console.log('\n=== Potential LWW Bugs ===\n');

		console.log('1. COMPACTION RACE CONDITIONS');
		console.log('   What if compaction runs while sync is in progress?');
		console.log('   You could delete a record before its dependencies arrive.');
		console.log('');

		console.log('2. CLOCK SKEW EDGE CASES');
		console.log("   What if a user's clock is 1 year in the future?");
		console.log('   They dominate ALL writes until others catch up.');
		console.log('');

		console.log('3. TOMBSTONE RESURRECTION');
		console.log('   User A deletes at T=100');
		console.log('   User B (offline since T=50) edits at T=60');
		console.log('   User B syncs... does the delete win? Should it?');
		console.log('');

		console.log('4. OBSERVER ORDERING');
		console.log('   processRecord() called in what order during sync?');
		console.log('   Does transaction batching affect winner selection?');
		console.log('');

		console.log(
			'Y.Map: None of these are YOUR problem. Kevin Jahns solved them.',
		);

		expect(true).toBe(true);
	});
});

// ============================================================================
// CONFLICT RESOLUTION: IS IT ACTUALLY A PROBLEM?
// ============================================================================

describe('Conflict Resolution: Does It Matter?', () => {
	test('How often do SAME-CELL conflicts actually happen?', () => {
		console.log('\n=== Same-Cell Conflict Frequency ===\n');

		console.log('For a conflict to occur, TWO users must:');
		console.log('  1. Edit the SAME row');
		console.log('  2. Edit the SAME column');
		console.log('  3. While OFFLINE from each other');
		console.log('  4. Then SYNC');
		console.log('');

		console.log('In practice:');
		console.log('  • Different rows: No conflict (most common)');
		console.log('  • Same row, different columns: MERGE works! ✓');
		console.log(
			'  • Same row, same column, online: Last write wins naturally ✓',
		);
		console.log('  • Same row, same column, offline: RARE conflict case');
		console.log('');

		console.log('Cell-level merging handles 99% of real collaboration.');
		console.log('The "unpredictable winner" only matters for that 1%.');

		expect(true).toBe(true);
	});

	test('cell-level merging works perfectly with Y.Map', () => {
		console.log('\n=== Cell-Level Merge Demo ===\n');

		const docA = new Y.Doc();
		const docB = new Y.Doc();
		docA.clientID = 100;
		docB.clientID = 200;

		const tableA = createSimpleTable(docA, 'posts');
		const tableB = createSimpleTable(docB, 'posts');

		// Initial state
		tableA.upsert({
			id: 'post-1',
			title: 'Original Title',
			views: 0,
			author: 'alice',
		});
		Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

		// Alice edits title, Bob edits views (DIFFERENT columns)
		tableA.update({ id: 'post-1', title: 'Alice Changed Title' });
		tableB.update({ id: 'post-1', views: 100 });

		// Sync
		Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
		Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));

		const resultA = tableA.get('post-1');
		const resultB = tableB.get('post-1');

		console.log('Alice edited: title');
		console.log('Bob edited: views');
		console.log('');
		console.log('After sync:');
		console.log(`  title: "${resultA?.title}"`);
		console.log(`  views: ${resultA?.views}`);
		console.log('');
		console.log('✅ BOTH changes preserved! No conflict.');

		expect(resultA?.title).toBe('Alice Changed Title');
		expect(resultA?.views).toBe(100);
		expect(resultA).toEqual(resultB);
	});

	test('same-cell conflict: does the user even notice?', () => {
		console.log('\n=== Same-Cell Conflict UX ===\n');

		const docA = new Y.Doc();
		const docB = new Y.Doc();

		const tableA = createSimpleTable(docA, 'posts');
		const tableB = createSimpleTable(docB, 'posts');

		tableA.upsert({ id: 'post-1', title: 'Original' });
		Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

		// Both edit same cell while offline
		tableA.update({ id: 'post-1', title: 'Alice: Meeting moved to 3pm' });
		tableB.update({ id: 'post-1', title: 'Bob: Meeting moved to 4pm' });

		Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
		Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));

		const result = tableA.get('post-1')?.title;
		console.log(`Winner: "${result}"`);
		console.log('');
		console.log('User experience:');
		console.log('  • Both users see the SAME result (consistency ✓)');
		console.log('  • Loser\'s change is "lost" but...');
		console.log('  • They edited the SAME field - of course one wins!');
		console.log('  • Loser can see the result and re-edit if needed');
		console.log('');
		console.log('With LWW timestamps:');
		console.log('  • Bob wins (edited later)');
		console.log('  • But Alice might argue: "I submitted first!"');
		console.log('  • There\'s no universally "correct" answer');

		expect(tableA.get('post-1')).toEqual(tableB.get('post-1'));
	});
});

// ============================================================================
// FINAL VERDICT
// ============================================================================

describe('The Verdict', () => {
	test('summary: when to use which approach', () => {
		console.log('\n');
		console.log(
			'╔═══════════════════════════════════════════════════════════════════╗',
		);
		console.log(
			'║                        RECOMMENDATION                             ║',
		);
		console.log(
			'╠═══════════════════════════════════════════════════════════════════╣',
		);
		console.log(
			'║                                                                   ║',
		);
		console.log(
			'║  USE Y.Map of Y.Maps (NATIVE) WHEN:                               ║',
		);
		console.log(
			'║  ────────────────────────────────────                             ║',
		);
		console.log(
			'║  • You want ZERO custom CRDT code                                 ║',
		);
		console.log(
			'║  • Your data is write-once or low-update-frequency                ║',
		);
		console.log(
			'║  • Cell-level merge is sufficient (different cols merge)          ║',
		);
		console.log(
			"║  • You trust YJS's battle-tested conflict resolution              ║",
		);
		console.log(
			'║  • Storage size is not a critical constraint                      ║',
		);
		console.log(
			'║                                                                   ║',
		);
		console.log(
			'║  USE YKeyValue-LWW WHEN:                                          ║',
		);
		console.log(
			'║  ────────────────────────────                                     ║',
		);
		console.log(
			'║  • Users EXPECT "later edit wins" behavior                        ║',
		);
		console.log(
			'║  • Same-cell conflicts are common in your app                     ║',
		);
		console.log(
			'║  • You need predictable, debuggable conflict resolution           ║',
		);
		console.log(
			"║  • You're willing to maintain compaction logic                    ║",
		);
		console.log(
			'║  • Storage optimization is critical                               ║',
		);
		console.log(
			'║                                                                   ║',
		);
		console.log(
			'╠═══════════════════════════════════════════════════════════════════╣',
		);
		console.log(
			'║                                                                   ║',
		);
		console.log(
			"║  MY TAKE: Start with Y.Map. It's simpler, battle-tested, and      ║",
		);
		console.log(
			'║  handles 99% of collaboration. Add LWW timestamps LATER if users  ║',
		);
		console.log(
			'║  actually complain about conflict resolution.                     ║',
		);
		console.log(
			'║                                                                   ║',
		);
		console.log(
			'║  "Premature optimization is the root of all evil" - Knuth         ║',
		);
		console.log(
			'║                                                                   ║',
		);
		console.log(
			'╚═══════════════════════════════════════════════════════════════════╝',
		);
		console.log('');

		expect(true).toBe(true);
	});
});
