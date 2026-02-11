import { mkdir } from 'node:fs/promises';
import * as Y from 'yjs';

type BenchmarkResult = {
	name: string;
	gcEnabled: boolean;
	sizeBytes: number;
	operations: number;
};

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function createDoc(gc: boolean): Y.Doc {
	return new Y.Doc({ gc });
}

/**
 * Benchmark 1: Y.Text Heavy Editing
 * Simulates Google Docs-like typing and deleting
 */
function benchmarkTextEditing(
	gc: boolean,
	operations: number,
): BenchmarkResult {
	const doc = createDoc(gc);
	const text = doc.getText('content');

	for (let i = 0; i < operations; i++) {
		const action = Math.random();

		if (action < 0.6) {
			// 60% - Insert character at random position
			const pos = Math.floor(Math.random() * (text.length + 1));
			const char = String.fromCharCode(97 + Math.floor(Math.random() * 26));
			text.insert(pos, char);
		} else if (action < 0.9 && text.length > 0) {
			// 30% - Delete character at random position
			const pos = Math.floor(Math.random() * text.length);
			text.delete(pos, 1);
		} else if (text.length > 0) {
			// 10% - Delete a range
			const pos = Math.floor(Math.random() * text.length);
			const len = Math.min(
				Math.floor(Math.random() * 10) + 1,
				text.length - pos,
			);
			text.delete(pos, len);
		}
	}

	const encoded = Y.encodeStateAsUpdate(doc);
	return {
		name: 'Y.Text Heavy Editing',
		gcEnabled: gc,
		sizeBytes: encoded.byteLength,
		operations,
	};
}

/**
 * Benchmark 2a: BAD PATTERN - Replace entire Y.Maps
 *
 * Structure:
 *   root (Y.Map)
 *     └── "record-0" -> Y.Map { id, name, data }
 *     └── "record-1" -> Y.Map { id, name, data }
 *     └── ...
 *
 * Each "update" creates a NEW Y.Map and sets it at the key,
 * orphaning the old Y.Map (which becomes a tombstone).
 */
function benchmarkBadPattern(gc: boolean, operations: number): BenchmarkResult {
	const doc = createDoc(gc);
	const root = doc.getMap('workspace');

	const recordIds = Array.from({ length: 100 }, (_, i) => `record-${i}`);

	for (let i = 0; i < operations; i++) {
		const recordId = recordIds[Math.floor(Math.random() * recordIds.length)]!;

		// BAD: Create a brand new Y.Map every time we "update" a record
		const newRecord = new Y.Map();
		newRecord.set('id', recordId);
		newRecord.set('name', `Name ${i}`);
		newRecord.set('data', `data-${Math.random().toString(36).slice(2)}`);
		newRecord.set('updatedAt', i);

		// This orphans the previous Y.Map at this key!
		root.set(recordId, newRecord);
	}

	const encoded = Y.encodeStateAsUpdate(doc);
	return {
		name: 'BAD: Replace Y.Maps',
		gcEnabled: gc,
		sizeBytes: encoded.byteLength,
		operations,
	};
}

/**
 * Benchmark 2b: GOOD PATTERN - Reuse Y.Maps, update fields
 *
 * Structure:
 *   root (Y.Map)
 *     └── "record-0" -> Y.Map { id, name, data }  <- same Y.Map instance, fields updated
 *     └── "record-1" -> Y.Map { id, name, data }
 *     └── ...
 *
 * Each "update" reuses the existing Y.Map and only updates fields.
 * No orphaned Y.Maps = minimal tombstones.
 */
function benchmarkGoodPattern(
	gc: boolean,
	operations: number,
): BenchmarkResult {
	const doc = createDoc(gc);
	const root = doc.getMap('workspace');

	const recordIds = Array.from({ length: 100 }, (_, i) => `record-${i}`);

	for (let i = 0; i < operations; i++) {
		const recordId = recordIds[Math.floor(Math.random() * recordIds.length)]!;

		// GOOD: Get existing Y.Map or create once, then update fields
		let record = root.get(recordId) as Y.Map<unknown> | undefined;
		if (!record) {
			record = new Y.Map();
			record.set('id', recordId);
			root.set(recordId, record);
		}

		// Update fields in-place - no new Y.Map created
		record.set('name', `Name ${i}`);
		record.set('data', `data-${Math.random().toString(36).slice(2)}`);
		record.set('updatedAt', i);
	}

	const encoded = Y.encodeStateAsUpdate(doc);
	return {
		name: 'GOOD: Reuse Y.Maps',
		gcEnabled: gc,
		sizeBytes: encoded.byteLength,
		operations,
	};
}

/**
 * Benchmark 3: FLAT PATTERN - Single Y.Map with composite keys
 *
 * Structure:
 *   root (Y.Map)
 *     └── "record-0:name" -> "Name 123"
 *     └── "record-0:data" -> "xyz..."
 *     └── "record-1:name" -> "Name 456"
 *     └── ...
 *
 * No nesting at all. Each field is a top-level key.
 */
function benchmarkFlatPattern(
	gc: boolean,
	operations: number,
): BenchmarkResult {
	const doc = createDoc(gc);
	const root = doc.getMap('workspace');

	const recordIds = Array.from({ length: 100 }, (_, i) => `record-${i}`);

	for (let i = 0; i < operations; i++) {
		const recordId = recordIds[Math.floor(Math.random() * recordIds.length)]!;

		// FLAT: Use composite keys instead of nested Y.Maps
		root.set(`${recordId}:name`, `Name ${i}`);
		root.set(`${recordId}:data`, `data-${Math.random().toString(36).slice(2)}`);
		root.set(`${recordId}:updatedAt`, i);
	}

	const encoded = Y.encodeStateAsUpdate(doc);
	return {
		name: 'FLAT: Composite Keys',
		gcEnabled: gc,
		sizeBytes: encoded.byteLength,
		operations,
	};
}

/**
 * Benchmark 4: Append-Only
 * Baseline comparison with no deletions
 */
function benchmarkAppendOnly(gc: boolean, operations: number): BenchmarkResult {
	const doc = createDoc(gc);
	const text = doc.getText('log');

	for (let i = 0; i < operations; i++) {
		text.insert(
			text.length,
			`Entry ${i}: ${Math.random().toString(36).slice(2)}\n`,
		);
	}

	const encoded = Y.encodeStateAsUpdate(doc);
	return {
		name: 'Append-Only (Baseline)',
		gcEnabled: gc,
		sizeBytes: encoded.byteLength,
		operations,
	};
}

async function runBenchmarks() {
	console.log('='.repeat(70));
	console.log('Yjs Garbage Collection Benchmark');
	console.log('='.repeat(70));
	console.log();

	const results: BenchmarkResult[] = [];

	// Benchmark 1: Text Editing
	console.log('Running: Y.Text Heavy Editing (100k operations)...');
	const textOps = 100_000;
	results.push(benchmarkTextEditing(false, textOps));
	results.push(benchmarkTextEditing(true, textOps));

	// Benchmark 2: Bad Pattern (Replace Y.Maps)
	console.log('Running: BAD Pattern - Replace Y.Maps (50k operations)...');
	const mapOps = 50_000;
	results.push(benchmarkBadPattern(false, mapOps));
	results.push(benchmarkBadPattern(true, mapOps));

	// Benchmark 3: Good Pattern (Reuse Y.Maps)
	console.log('Running: GOOD Pattern - Reuse Y.Maps (50k operations)...');
	results.push(benchmarkGoodPattern(false, mapOps));
	results.push(benchmarkGoodPattern(true, mapOps));

	// Benchmark 4: Flat Pattern (Composite Keys)
	console.log('Running: FLAT Pattern - Composite Keys (50k operations)...');
	results.push(benchmarkFlatPattern(false, mapOps));
	results.push(benchmarkFlatPattern(true, mapOps));

	// Benchmark 5: Append-Only
	console.log('Running: Append-Only Baseline (10k operations)...');
	const appendOps = 10_000;
	results.push(benchmarkAppendOnly(false, appendOps));
	results.push(benchmarkAppendOnly(true, appendOps));

	console.log();
	console.log('='.repeat(70));
	console.log('Results');
	console.log('='.repeat(70));
	console.log();

	// Group results by benchmark name
	const grouped = new Map<string, BenchmarkResult[]>();
	for (const result of results) {
		const existing = grouped.get(result.name) || [];
		existing.push(result);
		grouped.set(result.name, existing);
	}

	for (const [name, benchResults] of grouped) {
		const gcOff = benchResults.find((r) => !r.gcEnabled)!;
		const gcOn = benchResults.find((r) => r.gcEnabled)!;
		const reduction =
			((gcOff.sizeBytes - gcOn.sizeBytes) / gcOff.sizeBytes) * 100;
		const ratio = gcOff.sizeBytes / gcOn.sizeBytes;

		console.log(`${name}`);
		console.log(`  Operations: ${gcOff.operations.toLocaleString()}`);
		console.log(`  GC OFF: ${formatBytes(gcOff.sizeBytes)}`);
		console.log(`  GC ON:  ${formatBytes(gcOn.sizeBytes)}`);
		console.log(
			`  Reduction: ${reduction.toFixed(1)}% (${ratio.toFixed(2)}x smaller)`,
		);
		console.log();
	}

	// Save encoded documents for inspection
	const outputDir = new URL('./benchmark-output/', import.meta.url).pathname;
	await mkdir(outputDir, { recursive: true });

	for (const result of results) {
		const doc = createDoc(result.gcEnabled);

		// Re-run the benchmark to get the actual doc (bit wasteful but keeps code simple)
		if (result.name.includes('Text')) {
			const text = doc.getText('content');
			for (let i = 0; i < 1000; i++) {
				// Small sample
				text.insert(Math.floor(Math.random() * (text.length + 1)), 'x');
				if (text.length > 0 && Math.random() > 0.5) {
					text.delete(Math.floor(Math.random() * text.length), 1);
				}
			}
		}

		const encoded = Y.encodeStateAsUpdate(doc);
		const filename = `${result.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-gc-${result.gcEnabled ? 'on' : 'off'}.bin`;
		await Bun.write(`${outputDir}${filename}`, encoded);
	}

	console.log(`Sample documents saved to: ${outputDir}`);
}

runBenchmarks().catch(console.error);
