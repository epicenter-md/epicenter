/**
 * Performance benchmarks for the Static Workspace API.
 *
 * Tests createWorkspace, table operations, and KV operations at scale.
 * Scaled to complete in reasonable time while still providing useful metrics.
 */

import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import * as Y from 'yjs';
import { createKv } from './create-kv.js';
import { createTables } from './create-tables.js';
import { createWorkspace } from './create-workspace.js';
import { defineKv } from './define-kv.js';
import { defineTable } from './define-table.js';
import { defineWorkspace } from './define-workspace.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Test Fixtures
// ═══════════════════════════════════════════════════════════════════════════════

const postDefinition = defineTable(
	type({ id: 'string', title: 'string', views: 'number' }),
);

// Realistic note with actual content
const noteDefinition = defineTable(
	type({
		id: 'string',
		title: 'string',
		content: 'string',
		tags: 'string[]',
		createdAt: 'number',
		updatedAt: 'number',
	}),
);

const settingsDefinition = defineKv(
	type({ theme: "'light' | 'dark'", fontSize: 'number' }),
);

function generateId(index: number): string {
	return `id-${index.toString().padStart(6, '0')}`;
}

function measureTime<T>(fn: () => T): { result: T; durationMs: number } {
	const start = performance.now();
	const result = fn();
	const durationMs = performance.now() - start;
	return { result, durationMs };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Storage Analysis - What's Actually Being Stored
// ═══════════════════════════════════════════════════════════════════════════════

describe('storage analysis', () => {
	test('small row: actual payload vs Y.Doc overhead', () => {
		const ydoc = new Y.Doc();
		const tables = createTables(ydoc, { posts: postDefinition });

		// Example row
		const row = { id: 'id-000001', title: 'Post 1', views: 42 };
		const jsonPayload = JSON.stringify(row);
		console.log('\n=== SMALL ROW ANALYSIS ===');
		console.log(`Row data: ${jsonPayload}`);
		console.log(`JSON payload size: ${jsonPayload.length} bytes`);

		// What Y.js actually stores (from YKeyValueLww):
		// { key: 'id-000001', val: { id: 'id-000001', ... }, ts: 1706200000000 }
		const yEntry = { key: row.id, val: row, ts: Date.now() };
		console.log(`Y.js wrapper JSON: ${JSON.stringify(yEntry).length} bytes`);
		console.log(
			`Overhead: +${JSON.stringify(yEntry).length - jsonPayload.length} bytes (ID stored twice + timestamp)`,
		);

		// Insert 1000 rows
		for (let i = 0; i < 1_000; i++) {
			tables.posts.set({ id: generateId(i), title: `Post ${i}`, views: i });
		}

		const encoded = Y.encodeStateAsUpdate(ydoc);
		const pureJsonSize = jsonPayload.length * 1_000;
		console.log(`\nWith 1,000 rows:`);
		console.log(`  Y.Doc binary: ${(encoded.byteLength / 1024).toFixed(2)} KB`);
		console.log(`  Per row: ${(encoded.byteLength / 1_000).toFixed(0)} bytes`);
		console.log(
			`  Pure JSON would be: ~${(pureJsonSize / 1024).toFixed(0)} KB`,
		);
		console.log(
			`  CRDT overhead: ${((encoded.byteLength / pureJsonSize - 1) * 100).toFixed(0)}%`,
		);
	});

	test('realistic row: notes with 500 chars of content', () => {
		const ydoc = new Y.Doc();
		const tables = createTables(ydoc, { notes: noteDefinition });

		const sampleContent = `This is a realistic note with actual content. 
It might contain multiple paragraphs and various formatting.
Users typically write notes that are a few hundred characters long.
Some notes are longer, some are shorter, but this is a reasonable average.
Let's add a bit more to make it realistic. The quick brown fox jumps over the lazy dog.`;

		const row = {
			id: generateId(0),
			title: 'Meeting Notes - Q4 Planning',
			content: sampleContent,
			tags: ['work', 'meetings', 'planning'],
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};

		const jsonPayload = JSON.stringify(row);
		console.log('\n=== REALISTIC ROW ANALYSIS ===');
		console.log(`Content length: ${sampleContent.length} chars`);
		console.log(`Full row JSON: ${jsonPayload.length} bytes`);

		for (let i = 0; i < 1_000; i++) {
			tables.notes.set({
				id: generateId(i),
				title: `Note ${i}`,
				content: sampleContent,
				tags: ['tag1', 'tag2'],
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		}

		const encoded = Y.encodeStateAsUpdate(ydoc);
		console.log(`\nWith 1,000 notes (~500 chars each):`);
		console.log(
			`  Y.Doc binary: ${(encoded.byteLength / 1024).toFixed(0)} KB (${(encoded.byteLength / 1024 / 1024).toFixed(2)} MB)`,
		);
		console.log(`  Per row: ${(encoded.byteLength / 1_000).toFixed(0)} bytes`);
	});

	test('upper ceiling estimates', () => {
		console.log('\n=== PRACTICAL LIMITS ===');
		console.log(
			'Based on benchmarks (~75 bytes/small row, ~700 bytes/note):\n',
		);

		console.log('| Rows     | Small Rows  | Notes (~500 chars) |');
		console.log('|----------|-------------|---------------------|');
		console.log('| 1,000    | ~75 KB      | ~700 KB             |');
		console.log('| 10,000   | ~750 KB     | ~7 MB               |');
		console.log('| 50,000   | ~3.7 MB     | ~35 MB              |');
		console.log('| 100,000  | ~7.5 MB     | ~70 MB              |');

		console.log('\nRecommendations:');
		console.log('  ✓ 10K rows: Sweet spot for local-first (fast, <10MB)');
		console.log('  ⚠ 50K rows: Still works, slower inserts (~5s)');
		console.log('  ✗ 100K+ rows: Consider pagination/archiving');
		console.log('  Note: Deletes are O(n) - avoid repeated bulk delete cycles');
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
// createWorkspace Benchmarks
// ═══════════════════════════════════════════════════════════════════════════════

describe('createWorkspace benchmarks', () => {
	test('workspace creation is fast (< 10ms)', () => {
		const definition = defineWorkspace({
			id: 'bench-workspace',
			tables: { posts: postDefinition },
			kv: { settings: settingsDefinition },
		});

		const { durationMs } = measureTime(() => createWorkspace(definition));

		console.log(`createWorkspace: ${durationMs.toFixed(2)}ms`);
		expect(durationMs).toBeLessThan(10);
	});

	test('creating 100 workspaces sequentially', () => {
		const definition = defineWorkspace({
			id: 'bench-workspace',
			tables: { posts: postDefinition },
			kv: { settings: settingsDefinition },
		});

		const { durationMs } = measureTime(() => {
			for (let i = 0; i < 100; i++) {
				const client = createWorkspace({
					...definition,
					id: `bench-workspace-${i}`,
				});
				client.destroy();
			}
		});

		console.log(`100 workspace creations: ${durationMs.toFixed(2)}ms`);
		console.log(`Average per workspace: ${(durationMs / 100).toFixed(2)}ms`);
		expect(durationMs).toBeLessThan(500);
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
// Table Operation Benchmarks
// ═══════════════════════════════════════════════════════════════════════════════

describe('table benchmarks', () => {
	test('insert 1,000 rows', () => {
		const ydoc = new Y.Doc();
		const tables = createTables(ydoc, { posts: postDefinition });

		const { durationMs } = measureTime(() => {
			for (let i = 0; i < 1_000; i++) {
				tables.posts.set({ id: generateId(i), title: `Post ${i}`, views: i });
			}
		});

		console.log(`Insert 1,000 rows: ${durationMs.toFixed(2)}ms`);
		console.log(`Average per insert: ${(durationMs / 1_000).toFixed(4)}ms`);
		expect(tables.posts.count()).toBe(1_000);
	});

	test('insert 10,000 rows', () => {
		const ydoc = new Y.Doc();
		const tables = createTables(ydoc, { posts: postDefinition });

		const { durationMs } = measureTime(() => {
			for (let i = 0; i < 10_000; i++) {
				tables.posts.set({ id: generateId(i), title: `Post ${i}`, views: i });
			}
		});

		console.log(`Insert 10,000 rows: ${durationMs.toFixed(2)}ms`);
		console.log(`Average per insert: ${(durationMs / 10_000).toFixed(4)}ms`);
		expect(tables.posts.count()).toBe(10_000);
	});

	test('get 10,000 rows by ID', () => {
		const ydoc = new Y.Doc();
		const tables = createTables(ydoc, { posts: postDefinition });

		for (let i = 0; i < 10_000; i++) {
			tables.posts.set({ id: generateId(i), title: `Post ${i}`, views: i });
		}

		const { durationMs } = measureTime(() => {
			for (let i = 0; i < 10_000; i++) {
				tables.posts.get(generateId(i));
			}
		});

		console.log(`Get 10,000 rows: ${durationMs.toFixed(2)}ms`);
		console.log(`Average per get: ${(durationMs / 10_000).toFixed(4)}ms`);
	});

	test('getAll / getAllValid / filter with 10,000 rows', () => {
		const ydoc = new Y.Doc();
		const tables = createTables(ydoc, { posts: postDefinition });

		for (let i = 0; i < 10_000; i++) {
			tables.posts.set({ id: generateId(i), title: `Post ${i}`, views: i });
		}

		const { durationMs: getAllMs } = measureTime(() => tables.posts.getAll());
		const { durationMs: getAllValidMs } = measureTime(() =>
			tables.posts.getAllValid(),
		);
		const { durationMs: filterMs } = measureTime(() =>
			tables.posts.filter((row) => row.views > 5000),
		);

		console.log(`getAll: ${getAllMs.toFixed(2)}ms`);
		console.log(`getAllValid: ${getAllValidMs.toFixed(2)}ms`);
		console.log(`filter: ${filterMs.toFixed(2)}ms`);
	});

	test('delete 1,000 rows', () => {
		const ydoc = new Y.Doc();
		const tables = createTables(ydoc, { posts: postDefinition });

		for (let i = 0; i < 1_000; i++) {
			tables.posts.set({ id: generateId(i), title: `Post ${i}`, views: i });
		}

		const { durationMs } = measureTime(() => {
			for (let i = 0; i < 1_000; i++) {
				tables.posts.delete(generateId(i));
			}
		});

		console.log(`Delete 1,000 rows: ${durationMs.toFixed(2)}ms`);
		console.log(`Average per delete: ${(durationMs / 1_000).toFixed(4)}ms`);
		expect(tables.posts.count()).toBe(0);
	});

	test('batch insert vs individual insert (1,000 rows)', () => {
		const ydoc1 = new Y.Doc();
		const tables1 = createTables(ydoc1, { posts: postDefinition });

		const { durationMs: individualMs } = measureTime(() => {
			for (let i = 0; i < 1_000; i++) {
				tables1.posts.set({ id: generateId(i), title: `Post ${i}`, views: i });
			}
		});

		const ydoc2 = new Y.Doc();
		const tables2 = createTables(ydoc2, { posts: postDefinition });

		const { durationMs: batchMs } = measureTime(() => {
			tables2.posts.batch((tx) => {
				for (let i = 0; i < 1_000; i++) {
					tx.set({ id: generateId(i), title: `Post ${i}`, views: i });
				}
			});
		});

		console.log(`Individual inserts: ${individualMs.toFixed(2)}ms`);
		console.log(`Batch insert: ${batchMs.toFixed(2)}ms`);
		console.log(`Speedup: ${(individualMs / batchMs).toFixed(2)}x`);
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
// KV Operation Benchmarks
// ═══════════════════════════════════════════════════════════════════════════════

describe('KV benchmarks', () => {
	test('repeated set on same key (10,000 times)', () => {
		const ydoc = new Y.Doc();
		const kv = createKv(ydoc, {
			counter: defineKv(type({ value: 'number' })),
		});

		const { durationMs } = measureTime(() => {
			for (let i = 0; i < 10_000; i++) {
				kv.set('counter', { value: i });
			}
		});

		console.log(`Set same KV key 10,000 times: ${durationMs.toFixed(2)}ms`);
		console.log(`Average per set: ${(durationMs / 10_000).toFixed(4)}ms`);

		const result = kv.get('counter');
		expect(result.status).toBe('valid');
		if (result.status === 'valid') {
			expect(result.value.value).toBe(9_999);
		}
	});

	test('set + get alternating (10,000 cycles)', () => {
		const ydoc = new Y.Doc();
		const kv = createKv(ydoc, {
			counter: defineKv(type({ value: 'number' })),
		});

		const { durationMs } = measureTime(() => {
			for (let i = 0; i < 10_000; i++) {
				kv.set('counter', { value: i });
				kv.get('counter');
			}
		});

		console.log(`Set + Get 10,000 cycles: ${durationMs.toFixed(2)}ms`);
		console.log(`Average per cycle: ${(durationMs / 10_000).toFixed(4)}ms`);
	});

	test('set + delete cycle (1,000 times)', () => {
		const ydoc = new Y.Doc();
		const kv = createKv(ydoc, {
			counter: defineKv(type({ value: 'number' })),
		});

		const { durationMs } = measureTime(() => {
			for (let i = 0; i < 1_000; i++) {
				kv.set('counter', { value: i });
				kv.delete('counter');
			}
		});

		console.log(`Set + Delete 1,000 cycles: ${durationMs.toFixed(2)}ms`);
		console.log(`Average per cycle: ${(durationMs / 1_000).toFixed(4)}ms`);
		expect(kv.get('counter').status).toBe('not_found');
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
// Stress Tests: Repeated Add/Remove Cycles
// ═══════════════════════════════════════════════════════════════════════════════

describe('stress tests: repeated add/remove cycles', () => {
	test('1,000 items: add and remove 5 cycles', () => {
		const ydoc = new Y.Doc();
		const tables = createTables(ydoc, { posts: postDefinition });

		const cycleTimes: number[] = [];

		const { durationMs: totalDuration } = measureTime(() => {
			for (let cycle = 0; cycle < 5; cycle++) {
				const cycleStart = performance.now();

				for (let i = 0; i < 1_000; i++) {
					tables.posts.set({ id: generateId(i), title: `Post ${i}`, views: i });
				}

				for (let i = 0; i < 1_000; i++) {
					tables.posts.delete(generateId(i));
				}

				cycleTimes.push(performance.now() - cycleStart);
			}
		});

		console.log(
			`5 cycles of add/remove 1,000 items: ${totalDuration.toFixed(2)}ms`,
		);
		console.log(`Average cycle time: ${(totalDuration / 5).toFixed(2)}ms`);
		console.log(
			`First cycle: ${cycleTimes[0]?.toFixed(2)}ms, Last: ${cycleTimes[4]?.toFixed(2)}ms`,
		);
		expect(tables.posts.count()).toBe(0);
	});

	test('1,000 items: Y.Doc size growth over 5 cycles', () => {
		const ydoc = new Y.Doc();
		const tables = createTables(ydoc, { posts: postDefinition });

		const docSizes: number[] = [];

		for (let cycle = 0; cycle < 5; cycle++) {
			for (let i = 0; i < 1_000; i++) {
				tables.posts.set({ id: generateId(i), title: `Post ${i}`, views: i });
			}

			for (let i = 0; i < 1_000; i++) {
				tables.posts.delete(generateId(i));
			}

			docSizes.push(Y.encodeStateAsUpdate(ydoc).byteLength);
		}

		console.log('Y.Doc size after each cycle (bytes):');
		for (let i = 0; i < docSizes.length; i++) {
			console.log(`  Cycle ${i + 1}: ${docSizes[i]?.toLocaleString()}`);
		}
		expect(tables.posts.count()).toBe(0);
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
// Memory & Storage Benchmarks
// ═══════════════════════════════════════════════════════════════════════════════

describe('memory and storage benchmarks', () => {
	test('Y.Doc encoded size with 1,000 / 10,000 rows', () => {
		const ydoc1 = new Y.Doc();
		const tables1 = createTables(ydoc1, { posts: postDefinition });

		for (let i = 0; i < 1_000; i++) {
			tables1.posts.set({ id: generateId(i), title: `Post ${i}`, views: i });
		}
		const size1k = Y.encodeStateAsUpdate(ydoc1).byteLength;

		const ydoc2 = new Y.Doc();
		const tables2 = createTables(ydoc2, { posts: postDefinition });

		for (let i = 0; i < 10_000; i++) {
			tables2.posts.set({ id: generateId(i), title: `Post ${i}`, views: i });
		}
		const size10k = Y.encodeStateAsUpdate(ydoc2).byteLength;

		console.log(`Y.Doc size with 1,000 rows: ${(size1k / 1024).toFixed(2)} KB`);
		console.log(
			`Y.Doc size with 10,000 rows: ${(size10k / 1024).toFixed(2)} KB`,
		);
		console.log(`Bytes per row (1k): ${(size1k / 1_000).toFixed(2)}`);
		console.log(`Bytes per row (10k): ${(size10k / 10_000).toFixed(2)}`);
	});

	test('Y.Doc size growth after updates (same rows updated 5 times)', () => {
		const ydoc = new Y.Doc();
		const tables = createTables(ydoc, { posts: postDefinition });

		for (let i = 0; i < 1_000; i++) {
			tables.posts.set({ id: generateId(i), title: `Post ${i}`, views: 0 });
		}
		const initialSize = Y.encodeStateAsUpdate(ydoc).byteLength;

		for (let update = 1; update <= 5; update++) {
			for (let i = 0; i < 1_000; i++) {
				tables.posts.set({
					id: generateId(i),
					title: `Post ${i} v${update}`,
					views: update,
				});
			}
		}
		const finalSize = Y.encodeStateAsUpdate(ydoc).byteLength;

		console.log(
			`Initial size (1,000 rows): ${(initialSize / 1024).toFixed(2)} KB`,
		);
		console.log(
			`Final size (after 5 updates each): ${(finalSize / 1024).toFixed(2)} KB`,
		);
		console.log(`Growth factor: ${(finalSize / initialSize).toFixed(2)}x`);
	});
});
