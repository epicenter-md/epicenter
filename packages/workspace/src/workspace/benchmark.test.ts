/**
 * Workspace Benchmark Tests
 *
 * Benchmarks createWorkspace, table operations, KV operations, and storage growth under load.
 * These tests provide practical performance baselines and tombstone-size observations for local-first usage.
 *
 * Key behaviors:
 * - Bulk operations complete within expected runtime envelopes.
 * - Encoded Y.Doc sizes and tombstone behavior are measurable across realistic workloads.
 */

import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import * as Y from 'yjs';
import type { YKeyValueLwwEntry } from '../shared/y-keyvalue/y-keyvalue-lww.js';
import { createEncryptedYkvLww } from '../shared/y-keyvalue/y-keyvalue-lww-encrypted.js';
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
	type({ id: 'string', title: 'string', views: 'number', _v: '1' }),
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
		_v: '1',
	}),
);

const settingsDefinition = defineKv(
	type({ theme: "'light' | 'dark'", fontSize: 'number' }),
	{ theme: 'light', fontSize: 14 },
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
			tables.posts.set({
				id: generateId(i),
				title: `Post ${i}`,
				views: i,
				_v: 1,
			});
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
				_v: 1,
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
				client.dispose();
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
				tables.posts.set({
					id: generateId(i),
					title: `Post ${i}`,
					views: i,
					_v: 1,
				});
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
				tables.posts.set({
					id: generateId(i),
					title: `Post ${i}`,
					views: i,
					_v: 1,
				});
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
			tables.posts.set({
				id: generateId(i),
				title: `Post ${i}`,
				views: i,
				_v: 1,
			});
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
			tables.posts.set({
				id: generateId(i),
				title: `Post ${i}`,
				views: i,
				_v: 1,
			});
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
			tables.posts.set({
				id: generateId(i),
				title: `Post ${i}`,
				views: i,
				_v: 1,
			});
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
				tables1.posts.set({
					id: generateId(i),
					title: `Post ${i}`,
					views: i,
					_v: 1,
				});
			}
		});

		const ydoc2 = new Y.Doc();
		const tables2 = createTables(ydoc2, { posts: postDefinition });

		const { durationMs: batchMs } = measureTime(() => {
			ydoc2.transact(() => {
				for (let i = 0; i < 1_000; i++) {
					tables2.posts.set({
						id: generateId(i),
						title: `Post ${i}`,
						views: i,
						_v: 1,
					});
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
		const yarray = ydoc.getArray<YKeyValueLwwEntry<unknown>>('kv');
		const ykv = createEncryptedYkvLww(yarray);
		const kv = createKv(ykv, {
			counter: defineKv(type({ value: 'number' }), { value: 0 }),
		});

		const { durationMs } = measureTime(() => {
			for (let i = 0; i < 10_000; i++) {
				kv.set('counter', { value: i });
			}
		});

		console.log(`Set same KV key 10,000 times: ${durationMs.toFixed(2)}ms`);
		console.log(`Average per set: ${(durationMs / 10_000).toFixed(4)}ms`);

		const result = kv.get('counter');
		expect(result).toEqual({ value: 9_999 });
	});

	test('set + get alternating (10,000 cycles)', () => {
		const ydoc = new Y.Doc();
		const yarray = ydoc.getArray<YKeyValueLwwEntry<unknown>>('kv');
		const ykv = createEncryptedYkvLww(yarray);
		const kv = createKv(ykv, {
			counter: defineKv(type({ value: 'number' }), { value: 0 }),
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
		const yarray = ydoc.getArray<YKeyValueLwwEntry<unknown>>('kv');
		const ykv = createEncryptedYkvLww(yarray);
		const kv = createKv(ykv, {
			counter: defineKv(type({ value: 'number' }), { value: 0 }),
		});

		const { durationMs } = measureTime(() => {
			for (let i = 0; i < 1_000; i++) {
				kv.set('counter', { value: i });
				kv.delete('counter');
			}
		});

		console.log(`Set + Delete 1,000 cycles: ${durationMs.toFixed(2)}ms`);
		console.log(`Average per cycle: ${(durationMs / 1_000).toFixed(4)}ms`);
		expect(kv.get('counter')).toEqual({ value: 0 });
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
					tables.posts.set({
						id: generateId(i),
						title: `Post ${i}`,
						views: i,
						_v: 1,
					});
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
				tables.posts.set({
					id: generateId(i),
					title: `Post ${i}`,
					views: i,
					_v: 1,
				});
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
// Event Log Stress Test
// ═══════════════════════════════════════════════════════════════════════════════

describe('event log stress test', () => {
	const eventDefinition = defineTable(
		type({
			id: 'string',
			type: "'command' | 'event'",
			name: 'string',
			payload: 'string',
			timestamp: 'number',
			_v: '1',
		}),
	);

	const samplePayload = JSON.stringify({
		userId: 'usr-001',
		action: 'click',
		target: 'button.submit',
		metadata: { page: '/dashboard', sessionId: 'sess-abc123' },
	});

	test('1,000 events: add, delete, measure binary size over 5 cycles', () => {
		const ydoc = new Y.Doc();
		const tables = createTables(ydoc, { events: eventDefinition });

		const sizes: number[] = [];

		for (let cycle = 0; cycle < 5; cycle++) {
			for (let i = 0; i < 1_000; i++) {
				tables.events.set({
					id: generateId(i),
					type: i % 2 === 0 ? 'command' : 'event',
					name: `action_${i}`,
					payload: samplePayload,
					timestamp: Date.now(),
					_v: 1,
				});
			}

			for (let i = 0; i < 1_000; i++) {
				tables.events.delete(generateId(i));
			}

			sizes.push(Y.encodeStateAsUpdate(ydoc).byteLength);
		}

		console.log('\n=== Event Log: Binary Size After Add/Delete Cycles ===');
		for (let i = 0; i < sizes.length; i++) {
			console.log(
				`  Cycle ${i + 1}: ${sizes[i]} bytes (${tables.events.count()} rows)`,
			);
		}

		// After full add/delete cycles, doc should be tiny (just LWW metadata)
		const finalSize = sizes.at(-1) ?? 0;
		expect(finalSize).toBeLessThan(100);
		expect(tables.events.count()).toBe(0);
	});

	test('binary size: 1,000 events retained vs after deletion', () => {
		const ydoc = new Y.Doc();
		const tables = createTables(ydoc, { events: eventDefinition });

		for (let i = 0; i < 1_000; i++) {
			tables.events.set({
				id: generateId(i),
				type: 'event',
				name: `action_${i}`,
				payload: samplePayload,
				timestamp: Date.now(),
				_v: 1,
			});
		}

		const retainedSize = Y.encodeStateAsUpdate(ydoc).byteLength;

		for (let i = 0; i < 1_000; i++) {
			tables.events.delete(generateId(i));
		}

		const afterDeleteSize = Y.encodeStateAsUpdate(ydoc).byteLength;

		console.log('\n=== Event Log: Retained vs Deleted ===');
		console.log(
			`  1,000 events retained: ${(retainedSize / 1024).toFixed(2)} KB`,
		);
		console.log(`  After deleting all:    ${afterDeleteSize} bytes`);
		console.log(
			`  Reduction:             ${((1 - afterDeleteSize / retainedSize) * 100).toFixed(1)}%`,
		);

		expect(afterDeleteSize).toBeLessThan(100);
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
			tables1.posts.set({
				id: generateId(i),
				title: `Post ${i}`,
				views: i,
				_v: 1,
			});
		}
		const size1k = Y.encodeStateAsUpdate(ydoc1).byteLength;

		const ydoc2 = new Y.Doc();
		const tables2 = createTables(ydoc2, { posts: postDefinition });

		for (let i = 0; i < 10_000; i++) {
			tables2.posts.set({
				id: generateId(i),
				title: `Post ${i}`,
				views: i,
				_v: 1,
			});
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
			tables.posts.set({
				id: generateId(i),
				title: `Post ${i}`,
				views: 0,
				_v: 1,
			});
		}
		const initialSize = Y.encodeStateAsUpdate(ydoc).byteLength;

		for (let update = 1; update <= 5; update++) {
			for (let i = 0; i < 1_000; i++) {
				tables.posts.set({
					id: generateId(i),
					title: `Post ${i} v${update}`,
					views: update,
					_v: 1,
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

// ═══════════════════════════════════════════════════════════════════════════════
// Heavy Text Rows: Size & Tombstone Analysis
// ═══════════════════════════════════════════════════════════════════════════════

describe('heavy text rows: size and tombstone analysis', () => {
	// Simulate rows with heavy text content (like full documents/articles)
	const heavyNoteDefinition = defineTable(
		type({
			id: 'string',
			title: 'string',
			content: 'string',
			summary: 'string',
			tags: 'string[]',
			createdAt: 'number',
			updatedAt: 'number',
			_v: '1',
		}),
	);

	function generateHeavyContent(charCount: number): string {
		const paragraph =
			'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum. ';
		return paragraph
			.repeat(Math.ceil(charCount / paragraph.length))
			.slice(0, charCount);
	}

	function makeHeavyRow(id: string, contentChars: number) {
		return {
			id,
			title: `Document: ${id} - A Very Important Title That Is Reasonably Long`,
			content: generateHeavyContent(contentChars),
			summary: generateHeavyContent(Math.floor(contentChars / 10)),
			tags: ['research', 'important', 'draft', 'long-form'],
			createdAt: Date.now(),
			updatedAt: Date.now(),
			_v: 1 as const,
		};
	}

	function formatBytes(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
	}

	test('5 rows with 10K chars each: baseline size', () => {
		const ydoc = new Y.Doc();
		const tables = createTables(ydoc, { notes: heavyNoteDefinition });

		const rows = Array.from({ length: 5 }, (_, i) =>
			makeHeavyRow(`doc-${i}`, 10_000),
		);
		for (const row of rows) tables.notes.set(row);

		const encoded = Y.encodeStateAsUpdate(ydoc);
		const jsonSize = rows.reduce((s, r) => s + JSON.stringify(r).length, 0);

		console.log('\n=== 5 ROWS × 10K CHARS EACH ===');
		console.log(`  Pure JSON size:    ${formatBytes(jsonSize)}`);
		console.log(`  Y.Doc binary size: ${formatBytes(encoded.byteLength)}`);
		console.log(
			`  CRDT overhead:     ${((encoded.byteLength / jsonSize - 1) * 100).toFixed(1)}%`,
		);
		console.log(`  Per row:           ${formatBytes(encoded.byteLength / 5)}`);
	});

	test('5 rows with 50K chars each: baseline size', () => {
		const ydoc = new Y.Doc();
		const tables = createTables(ydoc, { notes: heavyNoteDefinition });

		const rows = Array.from({ length: 5 }, (_, i) =>
			makeHeavyRow(`doc-${i}`, 50_000),
		);
		for (const row of rows) tables.notes.set(row);

		const encoded = Y.encodeStateAsUpdate(ydoc);
		const jsonSize = rows.reduce((s, r) => s + JSON.stringify(r).length, 0);

		console.log('\n=== 5 ROWS × 50K CHARS EACH ===');
		console.log(`  Pure JSON size:    ${formatBytes(jsonSize)}`);
		console.log(`  Y.Doc binary size: ${formatBytes(encoded.byteLength)}`);
		console.log(
			`  CRDT overhead:     ${((encoded.byteLength / jsonSize - 1) * 100).toFixed(1)}%`,
		);
		console.log(`  Per row:           ${formatBytes(encoded.byteLength / 5)}`);
	});

	test('5 rows with 100K chars each: baseline size', () => {
		const ydoc = new Y.Doc();
		const tables = createTables(ydoc, { notes: heavyNoteDefinition });

		const rows = Array.from({ length: 5 }, (_, i) =>
			makeHeavyRow(`doc-${i}`, 100_000),
		);
		for (const row of rows) tables.notes.set(row);

		const encoded = Y.encodeStateAsUpdate(ydoc);
		const jsonSize = rows.reduce((s, r) => s + JSON.stringify(r).length, 0);

		console.log('\n=== 5 ROWS × 100K CHARS EACH ===');
		console.log(`  Pure JSON size:    ${formatBytes(jsonSize)}`);
		console.log(`  Y.Doc binary size: ${formatBytes(encoded.byteLength)}`);
		console.log(
			`  CRDT overhead:     ${((encoded.byteLength / jsonSize - 1) * 100).toFixed(1)}%`,
		);
		console.log(`  Per row:           ${formatBytes(encoded.byteLength / 5)}`);
	});

	test('tombstone analysis: delete 2 of 5 heavy rows, then add 2 new', () => {
		const ydoc = new Y.Doc();
		const tables = createTables(ydoc, { notes: heavyNoteDefinition });

		const contentChars = 50_000;

		// Step 1: Insert 5 heavy rows
		for (let i = 0; i < 5; i++) {
			tables.notes.set(makeHeavyRow(`doc-${i}`, contentChars));
		}
		const sizeWith5 = Y.encodeStateAsUpdate(ydoc).byteLength;

		// Step 2: Delete 2 rows (doc-1 and doc-3)
		tables.notes.delete('doc-1');
		tables.notes.delete('doc-3');
		const sizeAfterDelete = Y.encodeStateAsUpdate(ydoc).byteLength;

		// Step 3: Add 2 new rows
		tables.notes.set(makeHeavyRow('doc-5', contentChars));
		tables.notes.set(makeHeavyRow('doc-6', contentChars));
		const sizeAfterReplace = Y.encodeStateAsUpdate(ydoc).byteLength;

		const jsonPerRow = JSON.stringify(makeHeavyRow('x', contentChars)).length;

		console.log('\n=== TOMBSTONE ANALYSIS: 50K CHARS/ROW ===');
		console.log(`  JSON per row:                  ${formatBytes(jsonPerRow)}`);
		console.log(`  ─────────────────────────────────────────`);
		console.log(`  Step 1 — 5 rows:               ${formatBytes(sizeWith5)}`);
		console.log(
			`  Step 2 — delete 2 (3 remain):  ${formatBytes(sizeAfterDelete)}`,
		);
		console.log(
			`    Size freed:                  ${formatBytes(sizeWith5 - sizeAfterDelete)}`,
		);
		console.log(
			`    Tombstone residue:           ${formatBytes(sizeAfterDelete - Math.floor((sizeWith5 * 3) / 5))}`,
		);
		console.log(
			`  Step 3 — add 2 new (5 total):  ${formatBytes(sizeAfterReplace)}`,
		);
		console.log(
			`    vs original 5 rows:          ${sizeAfterReplace > sizeWith5 ? '+' : ''}${formatBytes(sizeAfterReplace - sizeWith5)} (${((sizeAfterReplace / sizeWith5 - 1) * 100).toFixed(2)}%)`,
		);
		console.log(`  ─────────────────────────────────────────`);
		console.log(
			`  Verdict: Tombstones are ${sizeAfterReplace <= sizeWith5 * 1.01 ? 'MINIMAL ✓' : sizeAfterReplace <= sizeWith5 * 1.05 ? 'SMALL ✓' : 'NOTICEABLE ⚠'}`,
		);
	});

	test('tombstone analysis: delete 2 of 5 heavy rows, then add 2 new (10K chars)', () => {
		const ydoc = new Y.Doc();
		const tables = createTables(ydoc, { notes: heavyNoteDefinition });

		const contentChars = 10_000;

		for (let i = 0; i < 5; i++) {
			tables.notes.set(makeHeavyRow(`doc-${i}`, contentChars));
		}
		const sizeWith5 = Y.encodeStateAsUpdate(ydoc).byteLength;

		tables.notes.delete('doc-1');
		tables.notes.delete('doc-3');
		const sizeAfterDelete = Y.encodeStateAsUpdate(ydoc).byteLength;

		tables.notes.set(makeHeavyRow('doc-5', contentChars));
		tables.notes.set(makeHeavyRow('doc-6', contentChars));
		const sizeAfterReplace = Y.encodeStateAsUpdate(ydoc).byteLength;

		console.log('\n=== TOMBSTONE ANALYSIS: 10K CHARS/ROW ===');
		console.log(`  Step 1 — 5 rows:               ${formatBytes(sizeWith5)}`);
		console.log(
			`  Step 2 — delete 2 (3 remain):  ${formatBytes(sizeAfterDelete)}`,
		);
		console.log(
			`    Size freed:                  ${formatBytes(sizeWith5 - sizeAfterDelete)}`,
		);
		console.log(
			`  Step 3 — add 2 new (5 total):  ${formatBytes(sizeAfterReplace)}`,
		);
		console.log(
			`    vs original 5 rows:          ${sizeAfterReplace > sizeWith5 ? '+' : ''}${formatBytes(sizeAfterReplace - sizeWith5)} (${((sizeAfterReplace / sizeWith5 - 1) * 100).toFixed(2)}%)`,
		);
		console.log(
			`  Verdict: Tombstones are ${sizeAfterReplace <= sizeWith5 * 1.01 ? 'MINIMAL ✓' : sizeAfterReplace <= sizeWith5 * 1.05 ? 'SMALL ✓' : 'NOTICEABLE ⚠'}`,
		);
	});

	test('tombstone analysis: delete 2 of 5 heavy rows, then add 2 new (100K chars)', () => {
		const ydoc = new Y.Doc();
		const tables = createTables(ydoc, { notes: heavyNoteDefinition });

		const contentChars = 100_000;

		for (let i = 0; i < 5; i++) {
			tables.notes.set(makeHeavyRow(`doc-${i}`, contentChars));
		}
		const sizeWith5 = Y.encodeStateAsUpdate(ydoc).byteLength;

		tables.notes.delete('doc-1');
		tables.notes.delete('doc-3');
		const sizeAfterDelete = Y.encodeStateAsUpdate(ydoc).byteLength;

		tables.notes.set(makeHeavyRow('doc-5', contentChars));
		tables.notes.set(makeHeavyRow('doc-6', contentChars));
		const sizeAfterReplace = Y.encodeStateAsUpdate(ydoc).byteLength;

		console.log('\n=== TOMBSTONE ANALYSIS: 100K CHARS/ROW ===');
		console.log(`  Step 1 — 5 rows:               ${formatBytes(sizeWith5)}`);
		console.log(
			`  Step 2 — delete 2 (3 remain):  ${formatBytes(sizeAfterDelete)}`,
		);
		console.log(
			`    Size freed:                  ${formatBytes(sizeWith5 - sizeAfterDelete)}`,
		);
		console.log(
			`  Step 3 — add 2 new (5 total):  ${formatBytes(sizeAfterReplace)}`,
		);
		console.log(
			`    vs original 5 rows:          ${sizeAfterReplace > sizeWith5 ? '+' : ''}${formatBytes(sizeAfterReplace - sizeWith5)} (${((sizeAfterReplace / sizeWith5 - 1) * 100).toFixed(2)}%)`,
		);
		console.log(
			`  Verdict: Tombstones are ${sizeAfterReplace <= sizeWith5 * 1.01 ? 'MINIMAL ✓' : sizeAfterReplace <= sizeWith5 * 1.05 ? 'SMALL ✓' : 'NOTICEABLE ⚠'}`,
		);
	});

	test('YKV (Y.Array LWW) vs native Y.Map: size + tombstone comparison', () => {
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
				_v: 1 as const,
			};
		}

		// ── Approach 1: YKeyValueLww (Workspace API) ──
		const ykvDoc = new Y.Doc();
		const tables = createTables(ykvDoc, { notes: heavyNoteDefinition });

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

		console.log('\n=== YKV (Y.Array LWW) vs NATIVE Y.Map — 50K chars/row ===');
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
		 * DeepWiki research reveals the key structural difference:
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
				_v: 1 as const,
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
			const tables = createTables(ykvDoc, { notes: heavyNoteDefinition });
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

	test('production scenario: autosave — user edits 1 doc, saves every 2s for 10min', () => {
		/**
		 * Realistic scenario: User has 5 notes open.
		 * They're actively editing 1 note. Autosave fires every ~2 seconds.
		 * Over a 10-minute session, that's ~300 saves to the same row.
		 * The other 4 rows sit idle.
		 */
		const contentChars = 20_000; // ~20KB note, realistic for a long doc
		const autosaves = 300; // 10 min ÷ 2s

		function makeRow(id: string, content: string) {
			return {
				id,
				title: `My Document ${id}`,
				content,
				summary: 'A summary',
				tags: ['work', 'notes'],
				createdAt: Date.now(),
				updatedAt: Date.now(),
				_v: 1 as const,
			};
		}

		// Simulate progressive typing — content grows slightly each save
		const baseContent = generateHeavyContent(contentChars);
		function contentAtSave(n: number): string {
			const extra = ` [edit ${n}]`;
			return baseContent.slice(0, contentChars - extra.length) + extra;
		}

		// ── YKV ──
		const ykvDoc = new Y.Doc();
		const tables = createTables(ykvDoc, { notes: heavyNoteDefinition });
		for (let i = 0; i < 5; i++) {
			tables.notes.set(makeRow(`doc-${i}`, baseContent));
		}
		const ykvBaseline = Y.encodeStateAsUpdate(ykvDoc).byteLength;
		for (let s = 1; s <= autosaves; s++) {
			tables.notes.set(makeRow('doc-0', contentAtSave(s)));
		}
		const ykvFinal = Y.encodeStateAsUpdate(ykvDoc).byteLength;

		// ── Y.Map Replace ──
		const replaceDoc = new Y.Doc();
		const replaceRoot = replaceDoc.getMap('notes');
		for (let i = 0; i < 5; i++) {
			const row = new Y.Map();
			for (const [k, v] of Object.entries(makeRow(`doc-${i}`, baseContent)))
				row.set(k, v);
			replaceRoot.set(`doc-${i}`, row);
		}
		const replaceBaseline = Y.encodeStateAsUpdate(replaceDoc).byteLength;
		for (let s = 1; s <= autosaves; s++) {
			const row = new Y.Map();
			for (const [k, v] of Object.entries(makeRow('doc-0', contentAtSave(s))))
				row.set(k, v);
			replaceRoot.set('doc-0', row);
		}
		const replaceFinal = Y.encodeStateAsUpdate(replaceDoc).byteLength;

		// ── Y.Map Field Update ──
		const fieldDoc = new Y.Doc();
		const fieldRoot = fieldDoc.getMap('notes');
		for (let i = 0; i < 5; i++) {
			const row = new Y.Map();
			for (const [k, v] of Object.entries(makeRow(`doc-${i}`, baseContent)))
				row.set(k, v);
			fieldRoot.set(`doc-${i}`, row);
		}
		const fieldBaseline = Y.encodeStateAsUpdate(fieldDoc).byteLength;
		for (let s = 1; s <= autosaves; s++) {
			const row = fieldRoot.get('doc-0') as Y.Map<unknown>;
			const data = makeRow('doc-0', contentAtSave(s));
			for (const [k, v] of Object.entries(data)) row.set(k, v);
		}
		const fieldFinal = Y.encodeStateAsUpdate(fieldDoc).byteLength;

		console.log(
			'\n=== PRODUCTION: AUTOSAVE — 300 saves to 1 doc over 10 min ===',
		);
		console.log(`  5 notes × 20K chars, 1 being actively edited`);
		console.log(`  ────────────────────────────────────────────────────────`);
		console.log(`                  Baseline     After 300     Growth`);
		console.log(
			`  YKV:            ${formatBytes(ykvBaseline).padEnd(12)} ${formatBytes(ykvFinal).padEnd(13)} +${formatBytes(ykvFinal - ykvBaseline)}`,
		);
		console.log(
			`  Y.Map Replace:  ${formatBytes(replaceBaseline).padEnd(12)} ${formatBytes(replaceFinal).padEnd(13)} +${formatBytes(replaceFinal - replaceBaseline)}`,
		);
		console.log(
			`  Y.Map Field:    ${formatBytes(fieldBaseline).padEnd(12)} ${formatBytes(fieldFinal).padEnd(13)} +${formatBytes(fieldFinal - fieldBaseline)}`,
		);
		console.log(`  ────────────────────────────────────────────────────────`);
		console.log(
			`  YKV saves ${formatBytes(fieldFinal - fieldBaseline - (ykvFinal - ykvBaseline))} vs Y.Map Field update`,
		);
		console.log(
			`  YKV saves ${formatBytes(replaceFinal - replaceBaseline - (ykvFinal - ykvBaseline))} vs Y.Map Replace`,
		);
	});

	test('production scenario: all-day editing — 3 documents, 8hr session', () => {
		/**
		 * Power user: 3 documents getting edited throughout the day.
		 * ~2000 total saves across 3 documents over 8 hours.
		 */
		const contentChars = 30_000;
		const totalSaves = 2000;
		const baseContent = generateHeavyContent(contentChars);

		function makeRow(id: string, v: number) {
			const extra = ` [revision ${v}]`;
			return {
				id,
				title: `Document ${id}`,
				content: baseContent.slice(0, contentChars - extra.length) + extra,
				summary: `Rev ${v} summary`,
				tags: ['active'],
				createdAt: Date.now(),
				updatedAt: Date.now(),
				_v: 1 as const,
			};
		}

		// ── YKV ──
		const ykvDoc = new Y.Doc();
		const tables = createTables(ykvDoc, { notes: heavyNoteDefinition });
		for (let i = 0; i < 5; i++) tables.notes.set(makeRow(`doc-${i}`, 0));
		for (let s = 1; s <= totalSaves; s++) {
			const docIdx = s % 3; // rotate across 3 active documents
			tables.notes.set(makeRow(`doc-${docIdx}`, s));
		}
		const ykvSize = Y.encodeStateAsUpdate(ykvDoc).byteLength;

		// ── Y.Map Field Update ──
		const fieldDoc = new Y.Doc();
		const fieldRoot = fieldDoc.getMap('notes');
		for (let i = 0; i < 5; i++) {
			const row = new Y.Map();
			for (const [k, v] of Object.entries(makeRow(`doc-${i}`, 0)))
				row.set(k, v);
			fieldRoot.set(`doc-${i}`, row);
		}
		for (let s = 1; s <= totalSaves; s++) {
			const docIdx = s % 3;
			const row = fieldRoot.get(`doc-${docIdx}`) as Y.Map<unknown>;
			for (const [k, v] of Object.entries(makeRow(`doc-${docIdx}`, s)))
				row.set(k, v);
		}
		const fieldSize = Y.encodeStateAsUpdate(fieldDoc).byteLength;

		console.log(
			'\n=== PRODUCTION: ALL-DAY SESSION — 2000 saves across 3 documents ===',
		);
		console.log(`  5 notes × 30K chars, 3 actively edited over 8 hours`);
		console.log(`  ────────────────────────────────────────────────────────`);
		console.log(`  YKV:           ${formatBytes(ykvSize)}`);
		console.log(`  Y.Map Field:   ${formatBytes(fieldSize)}`);
		console.log(`  ────────────────────────────────────────────────────────`);
		console.log(
			`  Difference:    ${formatBytes(fieldSize - ykvSize)} more with Y.Map Field (${((fieldSize / ykvSize - 1) * 100).toFixed(1)}% bloat)`,
		);
	});

	test('raw text size scaling: how content size dominates', () => {
		console.log('\n=== TEXT SIZE SCALING (single row) ===');
		console.log('| Content Size | JSON     | Y.Doc    | Overhead |');
		console.log('|-------------|----------|----------|----------|');

		for (const chars of [1_000, 5_000, 10_000, 50_000, 100_000, 500_000]) {
			const ydoc = new Y.Doc();
			const tables = createTables(ydoc, { notes: heavyNoteDefinition });

			const row = makeHeavyRow('doc-0', chars);
			tables.notes.set(row);

			const encoded = Y.encodeStateAsUpdate(ydoc).byteLength;
			const jsonSize = JSON.stringify(row).length;
			const overhead = ((encoded / jsonSize - 1) * 100).toFixed(1);

			console.log(
				`| ${formatBytes(chars).padEnd(11)} | ${formatBytes(jsonSize).padEnd(8)} | ${formatBytes(encoded).padEnd(8)} | ${overhead.padStart(5)}%   |`,
			);
		}
	});
});
