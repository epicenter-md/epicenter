/**
 * YKV (Y.Array LWW) vs Native Y.Map Comparison
 *
 * Answers: "Which storage approach is better, and is the custom LWW worth the complexity?"
 *
 * Compares the Workspace API's YKeyValue-LWW (opaque ContentAny blobs in Y.Array)
 * against native Y.Map (nested Y.Maps with cell-level granularity) across size,
 * tombstones, repeated updates, and realistic usage patterns.
 */

import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { attachTable } from '../document/table.js';
import {
	formatBytes,
	generateHeavyContent,
	heavyNoteDefinition,
} from './helpers.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Helper: Native Y.Map Table (dead simple)
// ═══════════════════════════════════════════════════════════════════════════════

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
			const ensuredRowMap = rowMap;
			ydoc.transact(() => {
				for (const [key, val] of Object.entries(row)) {
					ensuredRowMap.set(key, val);
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

// ═══════════════════════════════════════════════════════════════════════════════
// Size & Tombstone Comparison
// ═══════════════════════════════════════════════════════════════════════════════

describe('YKV vs Y.Map: size and tombstones', () => {
	test('50K chars/row: insert 5, delete 2, add 2 new', () => {
		const contentChars = 50_000;

		function makeRowData(id: string) {
			return {
				id,
				title: `Document: ${id} - A Very Important Title`,
				content: generateHeavyContent(contentChars),
				summary: generateHeavyContent(Math.floor(contentChars / 10)),
				tags: ['research', 'important', 'draft', 'long-form'],
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};
		}

		// ── Approach 1: YKeyValueLww (Workspace API) ──
		const ykvDoc = new Y.Doc();
		const tables = { notes: attachTable(ykvDoc, 'notes', heavyNoteDefinition) };

		for (let i = 0; i < 5; i++) tables.notes.set(makeRowData(`doc-${i}`));
		const ykvSize5 = Y.encodeStateAsUpdate(ykvDoc).byteLength;

		tables.notes.delete('doc-1');
		tables.notes.delete('doc-3');
		const ykvAfterDelete = Y.encodeStateAsUpdate(ykvDoc).byteLength;

		tables.notes.set(makeRowData('doc-5'));
		tables.notes.set(makeRowData('doc-6'));
		const ykvAfterReplace = Y.encodeStateAsUpdate(ykvDoc).byteLength;

		// ── Approach 2: Native Y.Map (map of nested Y.Maps) ──
		const ymapDoc = new Y.Doc();
		const root = ymapDoc.getMap('notes');

		for (let i = 0; i < 5; i++) {
			const data = makeRowData(`doc-${i}`);
			const row = new Y.Map();
			for (const [k, v] of Object.entries(data)) {
				if (Array.isArray(v)) {
					const arr = new Y.Array();
					arr.push(v);
					row.set(k, arr);
				} else {
					row.set(k, v);
				}
			}
			root.set(data.id, row);
		}
		const ymapSize5 = Y.encodeStateAsUpdate(ymapDoc).byteLength;

		root.delete('doc-1');
		root.delete('doc-3');
		const ymapAfterDelete = Y.encodeStateAsUpdate(ymapDoc).byteLength;

		for (const id of ['doc-5', 'doc-6']) {
			const data = makeRowData(id);
			const row = new Y.Map();
			for (const [k, v] of Object.entries(data)) {
				if (Array.isArray(v)) {
					const arr = new Y.Array();
					arr.push(v);
					row.set(k, arr);
				} else {
					row.set(k, v);
				}
			}
			root.set(data.id, row);
		}
		const ymapAfterReplace = Y.encodeStateAsUpdate(ymapDoc).byteLength;

		console.log('\n=== YKV (Y.Array LWW) vs NATIVE Y.Map: 50K chars/row ===');
		console.log(`                          YKV          Y.Map        Diff`);
		console.log(
			`  5 rows:                 ${formatBytes(ykvSize5).padEnd(12)} ${formatBytes(ymapSize5).padEnd(12)} ${ymapSize5 > ykvSize5 ? '+' : ''}${formatBytes(ymapSize5 - ykvSize5)}`,
		);
		console.log(
			`  After delete 2:         ${formatBytes(ykvAfterDelete).padEnd(12)} ${formatBytes(ymapAfterDelete).padEnd(12)} ${ymapAfterDelete > ykvAfterDelete ? '+' : ''}${formatBytes(ymapAfterDelete - ykvAfterDelete)}`,
		);
		console.log(
			`  After add 2 new:        ${formatBytes(ykvAfterReplace).padEnd(12)} ${formatBytes(ymapAfterReplace).padEnd(12)} ${ymapAfterReplace > ykvAfterReplace ? '+' : ''}${formatBytes(ymapAfterReplace - ykvAfterReplace)}`,
		);
		console.log(`  ──────────────────────────────────────────────────────`);
		console.log(`  Tombstone (delete+add vs original):`);
		console.log(
			`    YKV:   ${formatBytes(ykvAfterReplace - ykvSize5)} (${((ykvAfterReplace / ykvSize5 - 1) * 100).toFixed(3)}%)`,
		);
		console.log(
			`    Y.Map: ${formatBytes(ymapAfterReplace - ymapSize5)} (${((ymapAfterReplace / ymapSize5 - 1) * 100).toFixed(3)}%)`,
		);
	});

	test('repeated updates: where YKV and Y.Map diverge', () => {
		/**
		 * The key structural difference:
		 *
		 * YKV (Y.Array of plain objects):
		 *   - Each row is a single Item with ContentAny (opaque blob)
		 *   - "Update" = delete old Item + push new Item
		 *   - Deleted Item becomes 1 tombstone (ContentDeleted or GC struct)
		 *   - GC can merge adjacent tombstones
		 *
		 * Native Y.Map (nested Y.Maps):
		 *   - Each row is a Y.Map with N Items (one per field)
		 *   - "Update via replace" = delete parent Item (cascading N child deletions)
		 *   - Creates N+1 tombstones per replace
		 *   - "Update via field set" = only the changed field's Item is replaced
		 *   - Creates 1 tombstone per field update
		 *
		 * This test measures what happens after many updates to the same rows.
		 */

		const contentChars = 10_000;

		function makeRowData(id: string, version: number) {
			return {
				id,
				title: `Document ${id} v${version}`,
				content: generateHeavyContent(contentChars),
				summary: `Summary v${version}`,
				tags: ['tag1', 'tag2'],
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};
		}

		const updateRounds = [1, 5, 10, 25, 50];

		console.log(
			'\n=== REPEATED UPDATES: YKV vs Y.Map (replace) vs Y.Map (field update) ===',
		);
		console.log(`  5 rows × 10K chars content, measured after N update rounds`);
		console.log(
			`  ───────────────────────────────────────────────────────────`,
		);
		console.log(`  Updates │ YKV (Array)  │ Y.Map Replace │ Y.Map Field  │`);
		console.log(`  ────────┼──────────────┼───────────────┼──────────────┤`);

		for (const rounds of updateRounds) {
			// ── YKV approach ──
			const ykvDoc = new Y.Doc();
			const tables = {
				notes: attachTable(ykvDoc, 'notes', heavyNoteDefinition),
			};
			for (let i = 0; i < 5; i++) tables.notes.set(makeRowData(`doc-${i}`, 0));
			for (let r = 1; r <= rounds; r++) {
				for (let i = 0; i < 5; i++)
					tables.notes.set(makeRowData(`doc-${i}`, r));
			}
			const ykvSize = Y.encodeStateAsUpdate(ykvDoc).byteLength;

			// ── Y.Map: replace entire nested Y.Map each update ──
			const ymapReplaceDoc = new Y.Doc();
			const replaceRoot = ymapReplaceDoc.getMap('notes');
			for (let i = 0; i < 5; i++) {
				const data = makeRowData(`doc-${i}`, 0);
				const row = new Y.Map();
				for (const [k, v] of Object.entries(data)) row.set(k, v);
				replaceRoot.set(data.id, row);
			}
			for (let r = 1; r <= rounds; r++) {
				for (let i = 0; i < 5; i++) {
					const data = makeRowData(`doc-${i}`, r);
					const row = new Y.Map();
					for (const [k, v] of Object.entries(data)) row.set(k, v);
					replaceRoot.set(data.id, row);
				}
			}
			const ymapReplaceSize = Y.encodeStateAsUpdate(ymapReplaceDoc).byteLength;

			// ── Y.Map: reuse existing nested Y.Map, update fields in-place ──
			const ymapFieldDoc = new Y.Doc();
			const fieldRoot = ymapFieldDoc.getMap('notes');
			for (let i = 0; i < 5; i++) {
				const data = makeRowData(`doc-${i}`, 0);
				const row = new Y.Map();
				for (const [k, v] of Object.entries(data)) row.set(k, v);
				fieldRoot.set(data.id, row);
			}
			for (let r = 1; r <= rounds; r++) {
				for (let i = 0; i < 5; i++) {
					const data = makeRowData(`doc-${i}`, r);
					const row = fieldRoot.get(`doc-${i}`) as Y.Map<unknown>;
					for (const [k, v] of Object.entries(data)) row.set(k, v);
				}
			}
			const ymapFieldSize = Y.encodeStateAsUpdate(ymapFieldDoc).byteLength;

			console.log(
				`  ${String(rounds).padStart(7)} │ ${formatBytes(ykvSize).padEnd(12)} │ ${formatBytes(ymapReplaceSize).padEnd(13)} │ ${formatBytes(ymapFieldSize).padEnd(12)} │`,
			);
		}

		console.log(
			`  ───────────────────────────────────────────────────────────`,
		);
		console.log(
			`  YKV = Workspace API (Y.Array + LWW, opaque ContentAny blobs)`,
		);
		console.log(`  Y.Map Replace = new Y.Map() per update (orphans old Y.Map)`);
		console.log(`  Y.Map Field = reuse Y.Map, set() individual fields`);
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
// Realistic Usage Patterns (Native Y.Map)
// ═══════════════════════════════════════════════════════════════════════════════

describe('realistic storage patterns (native Y.Map)', () => {
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
				const colIndex = edit % 4;
				let col: 'col_a' | 'col_b' | 'col_c' | 'col_d';
				switch (colIndex) {
					case 0:
						col = 'col_a';
						break;
					case 1:
						col = 'col_b';
						break;
					case 2:
						col = 'col_c';
						break;
					default:
						col = 'col_d';
				}
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

// ═══════════════════════════════════════════════════════════════════════════════
// Conflict Resolution: Cell-Level Merge with Y.Map
// ═══════════════════════════════════════════════════════════════════════════════

describe('conflict resolution with native Y.Map', () => {
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
