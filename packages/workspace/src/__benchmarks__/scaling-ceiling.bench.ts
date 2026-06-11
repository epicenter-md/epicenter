/**
 * Scaling Ceiling Benchmarks
 *
 * Answers: "Where does the actual performance wall hit, and what causes it?"
 *
 * Unlike storage-overhead.bench.ts (which extrapolates from 1K-row measurements),
 * this file RUNS real workloads at 1K → 100K rows and measures what napkin math can't:
 *
 * - Insert timing (captures the O(n²) compound from YKeyValueLww's per-write array scan)
 * - Y.encodeStateAsUpdate() timing (persistence bottleneck)
 * - Y.applyUpdate() timing (cold boot / snapshot load bottleneck)
 * - Heap memory footprint (the real constraint in browsers)
 * - getAll() and random get/update timing at scale
 * - Multi-table scenarios (3 tables sharing one Y.Doc)
 *
 * Key behaviors:
 * - Per-operation cost increases with row count (O(n) scan per write)
 * - Encoding/decoding time scales with document size
 * - Memory footprint is 2-10x the serialized byte count
 * - Multi-table workspaces share one Y.Doc. Row counts compound.
 */

import { describe, test } from 'bun:test';
import * as Y from 'yjs';
import { createTables } from '../__tests__/create-tables.js';
import { attachTable } from '../document/table.js';
import {
	formatBytes,
	generateId,
	measureTime,
	noteDefinition,
	postDefinition,
} from './helpers.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Snapshot current heap usage in MB.
 *
 * NOTE: Heap measurements are approximate. Bun doesn't reliably expose manual GC,
 * so readings include noise from prior allocations and deferred collection.
 * Treat heap numbers as directional ("50K rows uses ~3x more than 10K"), not exact.
 */
function heapMB(): number {
	return process.memoryUsage().heapUsed / 1024 / 1024;
}

type ScalingRow = {
	n: number;
	insertMs: number;
	insertPerOpMs: number;
	encodeSizeBytes: number;
	encodeMs: number;
	decodeMs: number;
	heapMb: number;
	getAllMs: number;
	randomGetMs: number;
	randomUpdateMs: number;
};

function printTable(rows: ScalingRow[]): void {
	console.log('');
	console.log(
		'| Rows     | Insert     | Per-op   | Encode Size | Encode   | Decode   | Heap     | getAll   | 1K gets  | 1K updates |',
	);
	console.log(
		'|----------|------------|----------|-------------|----------|----------|----------|----------|----------|------------|',
	);
	for (const r of rows) {
		console.log(
			`| ${String(r.n).padStart(8)} | ${ms(r.insertMs).padStart(10)} | ${ms(r.insertPerOpMs).padStart(8)} | ${formatBytes(r.encodeSizeBytes).padStart(11)} | ${ms(r.encodeMs).padStart(8)} | ${ms(r.decodeMs).padStart(8)} | ${mb(r.heapMb).padStart(8)} | ${ms(r.getAllMs).padStart(8)} | ${ms(r.randomGetMs).padStart(8)} | ${ms(r.randomUpdateMs).padStart(10)} |`,
		);
	}
	console.log('');
}

function ms(v: number): string {
	if (v < 1) return `${(v * 1000).toFixed(0)}µs`;
	if (v < 1000) return `${v.toFixed(1)}ms`;
	return `${(v / 1000).toFixed(2)}s`;
}

function mb(v: number): string {
	return `${v.toFixed(1)} MB`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Single Table: Small Rows (posts)
// ═══════════════════════════════════════════════════════════════════════════════

describe('scaling ceiling: small rows (posts)', () => {
	const ROW_COUNTS = [1_000, 10_000, 25_000, 50_000, 100_000];

	test('insert, encode, decode, read at increasing row counts', () => {
		console.log('\n=== SCALING CEILING: SMALL ROWS (~75 bytes/row) ===');
		console.log('Table: posts { id, title, views }');

		const results: ScalingRow[] = [];

		for (const N of ROW_COUNTS) {
			const ydoc = new Y.Doc();
			const tables = { posts: attachTable(ydoc, 'posts', postDefinition) };

			// ── Insert N rows ──
			const { durationMs: insertMs } = measureTime(() => {
				for (let i = 0; i < N; i++) {
					tables.posts.set({
						id: generateId(i),
						title: `Post ${i}`,
						views: i,
					});
				}
			});

			// ── Heap snapshot (approximate, see note on heapMB) ──
			const heap = heapMB();

			// ── Encode (persistence write) ──
			let encoded!: Uint8Array;
			const { durationMs: encodeMs } = measureTime(() => {
				encoded = Y.encodeStateAsUpdate(ydoc);
			});

			// ── Decode (cold boot) ──
			const { durationMs: decodeMs } = measureTime(() => {
				const fresh = new Y.Doc();
				Y.applyUpdate(fresh, encoded);
				fresh.destroy();
			});

			// ── getAll ──
			const { durationMs: getAllMs } = measureTime(() => {
				tables.posts.getAll();
			});

			// ── 1000 random gets ──
			const { durationMs: randomGetMs } = measureTime(() => {
				for (let i = 0; i < 1_000; i++) {
					const idx = Math.floor(Math.random() * N);
					tables.posts.get(generateId(idx));
				}
			});

			// ── 1000 random updates ──
			const { durationMs: randomUpdateMs } = measureTime(() => {
				for (let i = 0; i < 1_000; i++) {
					const idx = Math.floor(Math.random() * N);
					tables.posts.set({
						id: generateId(idx),
						title: `Updated ${idx}`,
						views: idx + 1,
					});
				}
			});

			results.push({
				n: N,
				insertMs,
				insertPerOpMs: insertMs / N,
				encodeSizeBytes: encoded.byteLength,
				encodeMs,
				decodeMs,
				heapMb: heap,
				getAllMs,
				randomGetMs,
				randomUpdateMs,
			});

			ydoc.destroy();
		}

		printTable(results);
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
// Single Table: Realistic Rows (notes with ~500 chars content)
// ═══════════════════════════════════════════════════════════════════════════════

describe('scaling ceiling: realistic rows (notes)', () => {
	const ROW_COUNTS = [1_000, 10_000, 25_000, 50_000];

	test('insert, encode, decode, read at increasing row counts', () => {
		console.log('\n=== SCALING CEILING: REALISTIC ROWS (~700 bytes/row) ===');
		console.log(
			'Table: notes { id, title, content (~500 chars), tags, createdAt, updatedAt }',
		);

		const sampleContent =
			'This is a realistic note with actual content. It might contain multiple paragraphs and various formatting. Users typically write notes that are a few hundred characters long. Some notes are longer, some are shorter, but this is a reasonable average. The quick brown fox jumps.';

		const results: ScalingRow[] = [];

		for (const N of ROW_COUNTS) {
			const ydoc = new Y.Doc();
			const tables = { notes: attachTable(ydoc, 'notes', noteDefinition) };

			const { durationMs: insertMs } = measureTime(() => {
				for (let i = 0; i < N; i++) {
					tables.notes.set({
						id: generateId(i),
						title: `Note ${i}`,
						content: sampleContent,
						tags: ['tag1', 'tag2'],
						createdAt: Date.now(),
						updatedAt: Date.now(),
					});
				}
			});

			const heap = heapMB();

			let encoded!: Uint8Array;
			const { durationMs: encodeMs } = measureTime(() => {
				encoded = Y.encodeStateAsUpdate(ydoc);
			});

			const { durationMs: decodeMs } = measureTime(() => {
				const fresh = new Y.Doc();
				Y.applyUpdate(fresh, encoded);
				fresh.destroy();
			});

			const { durationMs: getAllMs } = measureTime(() => {
				tables.notes.getAll();
			});

			const { durationMs: randomGetMs } = measureTime(() => {
				for (let i = 0; i < 1_000; i++) {
					const idx = Math.floor(Math.random() * N);
					tables.notes.get(generateId(idx));
				}
			});

			const { durationMs: randomUpdateMs } = measureTime(() => {
				for (let i = 0; i < 1_000; i++) {
					const idx = Math.floor(Math.random() * N);
					tables.notes.set({
						id: generateId(idx),
						title: `Updated ${idx}`,
						content: sampleContent,
						tags: ['tag1', 'tag2'],
						createdAt: Date.now(),
						updatedAt: Date.now(),
					});
				}
			});

			results.push({
				n: N,
				insertMs,
				insertPerOpMs: insertMs / N,
				encodeSizeBytes: encoded.byteLength,
				encodeMs,
				decodeMs,
				heapMb: heap,
				getAllMs,
				randomGetMs,
				randomUpdateMs,
			});

			ydoc.destroy();
		}

		printTable(results);
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
// Multi-Table: Write Strategy Matters More Than Table Count
// ═══════════════════════════════════════════════════════════════════════════════

describe('scaling ceiling: multi-table write strategies', () => {
	const TOTAL_ROW_COUNTS = [3_000, 30_000, 75_000];

	/**
	 * Multi-table performance depends entirely on HOW you write, not how many tables you have.
	 *
	 * The pathological case: interleaved set() calls across tables in a tight loop.
	 * Each set() calls deleteEntryByKey() which does yarray.toArray().findIndex(): an O(n)
	 * scan that allocates a new array copy. Alternating between 3 arrays thrashes V8's JIT
	 * and GC, producing 16-22x slowdown vs sequential writes.
	 *
	 * The fix: use bulkSet() for population, or sequential set() per table.
	 * bulkSet defers conflict resolution to the observer (one pass, O(n) total).
	 * Sequential set() lets V8 optimize the hot path for one array at a time.
	 */
	test('population strategies: bulkSet vs sequential set vs interleaved set', () => {
		console.log('\n=== MULTI-TABLE: WRITE STRATEGY COMPARISON ===');
		console.log(
			'3 tables sharing one Y.Doc. Same data, different insert patterns.\n',
		);

		console.log(
			'| Total rows | bulkSet    | seq set()  | interleaved set() | bulk speedup |',
		);
		console.log(
			'|------------|------------|------------|-------------------|--------------|',
		);

		for (const N of TOTAL_ROW_COUNTS) {
			const perTable = Math.floor(N / 3);

			// ── bulkSet (the correct way) ──
			const bulkDoc = new Y.Doc();
			const bulkTables = createTables(bulkDoc, {
				posts: postDefinition,
				bookmarks: postDefinition,
				events: postDefinition,
			});

			const postRows = Array.from({ length: perTable }, (_, i) => ({
				id: generateId(i),
				title: `Post ${i}`,
				views: i,
			}));
			const bookmarkRows = Array.from({ length: perTable }, (_, i) => ({
				id: generateId(i),
				title: `Bookmark ${i}`,
				views: i,
			}));
			const eventRows = Array.from({ length: perTable }, (_, i) => ({
				id: generateId(i),
				title: `Event ${i}`,
				views: i,
			}));

			const { durationMs: bulkMs } = measureTime(() => {
				bulkTables.posts.bulkSet(postRows);
				bulkTables.bookmarks.bulkSet(bookmarkRows);
				bulkTables.events.bulkSet(eventRows);
			});
			bulkDoc.destroy();

			// ── Sequential set() (correct for non-bulk) ──
			const seqDoc = new Y.Doc();
			const seqTables = createTables(seqDoc, {
				posts: postDefinition,
				bookmarks: postDefinition,
				events: postDefinition,
			});

			const { durationMs: seqMs } = measureTime(() => {
				for (let i = 0; i < perTable; i++) {
					seqTables.posts.set({
						id: generateId(i),
						title: `Post ${i}`,
						views: i,
					});
				}
				for (let i = 0; i < perTable; i++) {
					seqTables.bookmarks.set({
						id: generateId(i),
						title: `Bookmark ${i}`,
						views: i,
					});
				}
				for (let i = 0; i < perTable; i++) {
					seqTables.events.set({
						id: generateId(i),
						title: `Event ${i}`,
						views: i,
					});
				}
			});
			seqDoc.destroy();

			// ── Interleaved set() (pathological: never do this) ──
			const intDoc = new Y.Doc();
			const intTables = createTables(intDoc, {
				posts: postDefinition,
				bookmarks: postDefinition,
				events: postDefinition,
			});

			const { durationMs: intMs } = measureTime(() => {
				for (let i = 0; i < perTable; i++) {
					intTables.posts.set({
						id: generateId(i),
						title: `Post ${i}`,
						views: i,
					});
					intTables.bookmarks.set({
						id: generateId(i),
						title: `Bookmark ${i}`,
						views: i,
					});
					intTables.events.set({
						id: generateId(i),
						title: `Event ${i}`,
						views: i,
					});
				}
			});
			intDoc.destroy();

			const speedup = intMs / bulkMs;
			console.log(
				`| ${String(N).padStart(10)} | ${ms(bulkMs).padStart(10)} | ${ms(seqMs).padStart(10)} | ${ms(intMs).padStart(17)} | ${speedup.toFixed(0).padStart(9)}x   |`,
			);
		}

		console.log('');
		console.log('bulkSet = O(n) deferred conflict resolution via observer');
		console.log('seq set() = one table at a time, V8 JIT stays hot');
		console.log(
			'interleaved set() = alternating arrays, toArray() thrash: NEVER do this in bulk',
		);
	}, 120_000);

	test('post-population: random updates across 3 tables (realistic usage)', () => {
		console.log('\n=== POST-POPULATION: RANDOM UPDATES ACROSS 3 TABLES ===');
		console.log('After bulk-loading, individual set() updates are fine.\n');

		for (const N of TOTAL_ROW_COUNTS) {
			const perTable = Math.floor(N / 3);

			// Populate with bulkSet first
			const ydoc = new Y.Doc();
			const tables = createTables(ydoc, {
				posts: postDefinition,
				bookmarks: postDefinition,
				events: postDefinition,
			});

			tables.posts.bulkSet(
				Array.from({ length: perTable }, (_, i) => ({
					id: generateId(i),
					title: `Post ${i}`,
					views: i,
				})),
			);
			tables.bookmarks.bulkSet(
				Array.from({ length: perTable }, (_, i) => ({
					id: generateId(i),
					title: `Bookmark ${i}`,
					views: i,
				})),
			);
			tables.events.bulkSet(
				Array.from({ length: perTable }, (_, i) => ({
					id: generateId(i),
					title: `Event ${i}`,
					views: i,
				})),
			);

			// Now simulate realistic usage: random updates across tables
			const { durationMs } = measureTime(() => {
				for (let i = 0; i < 1_000; i++) {
					const idx = Math.floor(Math.random() * perTable);
					// Randomly pick a table (simulates user editing different things)
					const pick = i % 3;
					if (pick === 0) {
						tables.posts.set({
							id: generateId(idx),
							title: `Updated ${idx}`,
							views: idx,
						});
					} else if (pick === 1) {
						tables.bookmarks.set({
							id: generateId(idx),
							title: `Updated ${idx}`,
							views: idx,
						});
					} else {
						tables.events.set({
							id: generateId(idx),
							title: `Updated ${idx}`,
							views: idx,
						});
					}
				}
			});

			console.log(
				`  ${String(N).padStart(6)} total rows → 1K random updates across 3 tables: ${ms(durationMs)} (${ms(durationMs / 1_000)}/op)`,
			);

			ydoc.destroy();
		}

		console.log('');
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
// Per-Operation Degradation Curve
// ═══════════════════════════════════════════════════════════════════════════════

describe('scaling ceiling: per-operation degradation', () => {
	test('insert cost at every 10K milestone (reveals O(n) scan)', () => {
		console.log('\n=== PER-OPERATION DEGRADATION CURVE ===');
		console.log(
			'Measures insert time for a batch of 1,000 rows at each milestone.',
		);
		console.log(
			'If YKeyValueLww scans O(n) per write, cost should increase linearly.\n',
		);

		const ydoc = new Y.Doc();
		const tables = { posts: attachTable(ydoc, 'posts', postDefinition) };

		const milestones = [0, 10_000, 20_000, 30_000, 40_000, 50_000];
		let totalInserted = 0;

		console.log('| Existing rows | +1K insert | Per-op avg |');
		console.log('|---------------|------------|------------|');

		for (const milestone of milestones) {
			// Fill up to milestone
			while (totalInserted < milestone) {
				tables.posts.set({
					id: generateId(totalInserted),
					title: `Post ${totalInserted}`,
					views: totalInserted,
				});
				totalInserted++;
			}

			// Measure inserting the next 1,000
			const batchStart = totalInserted;
			const { durationMs } = measureTime(() => {
				for (let i = 0; i < 1_000; i++) {
					tables.posts.set({
						id: generateId(batchStart + i),
						title: `Post ${batchStart + i}`,
						views: batchStart + i,
					});
				}
			});
			totalInserted += 1_000;

			console.log(
				`| ${String(milestone).padStart(13)} | ${ms(durationMs).padStart(10)} | ${ms(durationMs / 1_000).padStart(10)} |`,
			);
		}

		ydoc.destroy();
		console.log('');
	});
});
