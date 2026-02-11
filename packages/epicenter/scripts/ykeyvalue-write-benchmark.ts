/**
 * Benchmark: Is YKeyValue's O(n) write fast enough for 100k rows?
 *
 * Run: bun packages/epicenter/scripts/ykeyvalue-write-benchmark.ts
 */
import * as Y from 'yjs';
import {
	YKeyValueLww,
	type YKeyValueLwwEntry,
} from '../src/shared/y-keyvalue/y-keyvalue-lww';

type Row = { id: string; name: string; value: number };

function benchmarkYKeyValue(rowCount: number, updateCount: number) {
	const doc = new Y.Doc();
	const yarray = doc.getArray<YKeyValueLwwEntry<Row>>('table');
	const kv = new YKeyValueLww(yarray);

	// Seed with rows
	console.log(`\nSeeding ${rowCount.toLocaleString()} rows...`);
	const seedStart = performance.now();
	doc.transact(() => {
		for (let i = 0; i < rowCount; i++) {
			kv.set(`row-${i}`, { id: `row-${i}`, name: `Name ${i}`, value: i });
		}
	});
	const seedTime = performance.now() - seedStart;
	console.log(`  Seed time: ${seedTime.toFixed(2)}ms`);

	// Measure single update times
	const updateTimes: number[] = [];
	for (let i = 0; i < updateCount; i++) {
		const randomKey = `row-${Math.floor(Math.random() * rowCount)}`;
		const start = performance.now();
		kv.set(randomKey, { id: randomKey, name: `Updated ${i}`, value: i * 100 });
		updateTimes.push(performance.now() - start);
	}

	const avg = updateTimes.reduce((a, b) => a + b, 0) / updateTimes.length;
	const max = Math.max(...updateTimes);
	const min = Math.min(...updateTimes);

	console.log(`  Single update (${updateCount} samples):`);
	console.log(`    Avg: ${avg.toFixed(3)}ms`);
	console.log(`    Min: ${min.toFixed(3)}ms`);
	console.log(`    Max: ${max.toFixed(3)}ms`);

	// Measure read time for comparison
	const readTimes: number[] = [];
	for (let i = 0; i < updateCount; i++) {
		const randomKey = `row-${Math.floor(Math.random() * rowCount)}`;
		const start = performance.now();
		kv.get(randomKey);
		readTimes.push(performance.now() - start);
	}
	const readAvg = readTimes.reduce((a, b) => a + b, 0) / readTimes.length;
	console.log(`  Single read avg: ${readAvg.toFixed(4)}ms`);

	return { seedTime, avgUpdate: avg, maxUpdate: max };
}

function benchmarkYMap(rowCount: number, updateCount: number) {
	const doc = new Y.Doc();
	const ymap = doc.getMap<Row>('table');

	// Seed with rows
	console.log(`\nSeeding ${rowCount.toLocaleString()} rows (Y.Map)...`);
	const seedStart = performance.now();
	doc.transact(() => {
		for (let i = 0; i < rowCount; i++) {
			ymap.set(`row-${i}`, { id: `row-${i}`, name: `Name ${i}`, value: i });
		}
	});
	const seedTime = performance.now() - seedStart;
	console.log(`  Seed time: ${seedTime.toFixed(2)}ms`);

	// Measure single update times
	const updateTimes: number[] = [];
	for (let i = 0; i < updateCount; i++) {
		const randomKey = `row-${Math.floor(Math.random() * rowCount)}`;
		const start = performance.now();
		ymap.set(randomKey, {
			id: randomKey,
			name: `Updated ${i}`,
			value: i * 100,
		});
		updateTimes.push(performance.now() - start);
	}

	const avg = updateTimes.reduce((a, b) => a + b, 0) / updateTimes.length;
	const max = Math.max(...updateTimes);

	console.log(`  Single update (${updateCount} samples):`);
	console.log(`    Avg: ${avg.toFixed(3)}ms`);
	console.log(`    Max: ${max.toFixed(3)}ms`);

	return { seedTime, avgUpdate: avg, maxUpdate: max };
}

console.log('═'.repeat(60));
console.log('YKeyValue O(n) Write Performance Benchmark');
console.log('═'.repeat(60));

const rowCounts = [1_000, 10_000, 100_000];
const updateSamples = 100;

console.log('\n── YKeyValue ──');
const ykvResults: Record<number, { avgUpdate: number }> = {};
for (const count of rowCounts) {
	ykvResults[count] = benchmarkYKeyValue(count, updateSamples);
}

console.log('\n── Y.Map (for comparison) ──');
const ymapResults: Record<number, { avgUpdate: number }> = {};
for (const count of rowCounts) {
	ymapResults[count] = benchmarkYMap(count, updateSamples);
}

console.log('\n' + '═'.repeat(60));
console.log('Summary: Single Update Latency');
console.log('═'.repeat(60));
console.log('\nRows       | YKeyValue  | Y.Map      | Ratio');
console.log('-----------|------------|------------|-------');
for (const count of rowCounts) {
	const ykv = ykvResults[count]!.avgUpdate;
	const ym = ymapResults[count]!.avgUpdate;
	const ratio = (ykv / ym).toFixed(1);
	console.log(
		`${count.toLocaleString().padEnd(10)} | ${ykv.toFixed(3).padEnd(10)}ms | ${ym.toFixed(3).padEnd(10)}ms | ${ratio}x`,
	);
}

console.log('\n' + '═'.repeat(60));
console.log('Verdict');
console.log('═'.repeat(60));
const verdict100k = ykvResults[100_000]!.avgUpdate;
if (verdict100k < 1) {
	console.log(`\n✓ At 100k rows, updates take ~${verdict100k.toFixed(2)}ms`);
	console.log('  This is sub-millisecond and totally fine for most UIs.');
} else if (verdict100k < 16) {
	console.log(`\n~ At 100k rows, updates take ~${verdict100k.toFixed(2)}ms`);
	console.log('  This is under one frame (16ms) - acceptable for most cases.');
} else {
	console.log(`\n⚠ At 100k rows, updates take ~${verdict100k.toFixed(2)}ms`);
	console.log('  This exceeds one frame - may cause jank in rapid updates.');
}
