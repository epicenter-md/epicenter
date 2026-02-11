/**
 * Benchmark: Y.Map vs YKeyValue for KV-style storage
 *
 * Tests typical KV patterns:
 * 1. Few keys, frequent updates (e.g., settings that change often)
 * 2. Few keys, infrequent updates (e.g., user preferences)
 * 3. Many keys, moderate updates (e.g., feature flags, cache)
 *
 * Run: bun packages/epicenter/scripts/ymap-vs-ykeyvalue-benchmark.ts
 */

import * as Y from 'yjs';
import {
	YKeyValueLww,
	type YKeyValueLwwEntry,
} from '../src/shared/y-keyvalue/y-keyvalue-lww';

type BenchmarkResult = {
	name: string;
	ymapBytes: number;
	ykvBytes: number;
	ymapTimeMs: number;
	ykvTimeMs: number;
	ratio: string;
};

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function benchmarkScenario(
	name: string,
	numKeys: number,
	updatesPerKey: number,
): BenchmarkResult {
	// Y.Map benchmark
	const ymapDoc = new Y.Doc();
	const ymap = ymapDoc.getMap<{ value: string; count: number }>('kv');

	const ymapStart = performance.now();
	for (let update = 0; update < updatesPerKey; update++) {
		for (let key = 0; key < numKeys; key++) {
			ymap.set(`key-${key}`, {
				value: `value-${update}`,
				count: update,
			});
		}
	}
	const ymapTime = performance.now() - ymapStart;
	const ymapBytes = Y.encodeStateAsUpdate(ymapDoc).byteLength;

	// YKeyValueLww benchmark
	const ykvDoc = new Y.Doc();
	const yarray =
		ykvDoc.getArray<YKeyValueLwwEntry<{ value: string; count: number }>>('kv');
	const ykv = new YKeyValueLww(yarray);

	const ykvStart = performance.now();
	for (let update = 0; update < updatesPerKey; update++) {
		for (let key = 0; key < numKeys; key++) {
			ykv.set(`key-${key}`, {
				value: `value-${update}`,
				count: update,
			});
		}
	}
	const ykvTime = performance.now() - ykvStart;
	const ykvBytes = Y.encodeStateAsUpdate(ykvDoc).byteLength;

	const ratio =
		ymapBytes > ykvBytes
			? `Y.Map is ${(ymapBytes / ykvBytes).toFixed(1)}x larger`
			: `YKeyValue is ${(ykvBytes / ymapBytes).toFixed(1)}x larger`;

	return {
		name,
		ymapBytes,
		ykvBytes,
		ymapTimeMs: ymapTime,
		ykvTimeMs: ykvTime,
		ratio,
	};
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('Y.Map vs YKeyValue Benchmark for KV Storage');
console.log(
	'═══════════════════════════════════════════════════════════════\n',
);

const scenarios = [
	// Typical KV: few keys, rare updates
	{ name: '5 keys, 1 update each (initial set)', numKeys: 5, updatesPerKey: 1 },
	{
		name: '10 keys, 1 update each (initial set)',
		numKeys: 10,
		updatesPerKey: 1,
	},

	// Settings that change occasionally
	{
		name: '5 keys, 10 updates each (occasional changes)',
		numKeys: 5,
		updatesPerKey: 10,
	},
	{
		name: '10 keys, 10 updates each (occasional changes)',
		numKeys: 10,
		updatesPerKey: 10,
	},

	// Frequently changing values (e.g., cursor position, live data)
	{
		name: '5 keys, 100 updates each (frequent changes)',
		numKeys: 5,
		updatesPerKey: 100,
	},
	{
		name: '5 keys, 1000 updates each (very frequent)',
		numKeys: 5,
		updatesPerKey: 1000,
	},

	// Many keys (e.g., feature flags, cache entries)
	{
		name: '50 keys, 10 updates each (many keys)',
		numKeys: 50,
		updatesPerKey: 10,
	},
	{
		name: '100 keys, 10 updates each (lots of keys)',
		numKeys: 100,
		updatesPerKey: 10,
	},

	// Stress test
	{
		name: '10 keys, 10000 updates each (stress test)',
		numKeys: 10,
		updatesPerKey: 10000,
	},
];

const results: BenchmarkResult[] = [];

for (const scenario of scenarios) {
	const result = benchmarkScenario(
		scenario.name,
		scenario.numKeys,
		scenario.updatesPerKey,
	);
	results.push(result);

	console.log(`📊 ${result.name}`);
	console.log(
		`   Y.Map:     ${formatBytes(result.ymapBytes).padStart(12)} | ${result.ymapTimeMs.toFixed(2).padStart(8)} ms`,
	);
	console.log(
		`   YKeyValue: ${formatBytes(result.ykvBytes).padStart(12)} | ${result.ykvTimeMs.toFixed(2).padStart(8)} ms`,
	);
	console.log(`   → ${result.ratio}`);
	console.log();
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('Summary');
console.log(
	'═══════════════════════════════════════════════════════════════\n',
);

console.log(
	'| Scenario | Y.Map Size | YKV Size | Y.Map Time | YKV Time | Winner |',
);
console.log(
	'|----------|------------|----------|------------|----------|--------|',
);

for (const r of results) {
	const sizeWinner = r.ymapBytes <= r.ykvBytes ? 'Y.Map' : 'YKV';
	const timeWinner = r.ymapTimeMs <= r.ykvTimeMs ? 'Y.Map' : 'YKV';
	const winner = sizeWinner === timeWinner ? sizeWinner : 'Mixed';

	console.log(
		`| ${r.name.slice(0, 40).padEnd(40)} | ${formatBytes(r.ymapBytes).padStart(10)} | ${formatBytes(r.ykvBytes).padStart(8)} | ${r.ymapTimeMs.toFixed(2).padStart(10)} ms | ${r.ykvTimeMs.toFixed(2).padStart(8)} ms | ${winner.padStart(6)} |`,
	);
}

console.log('\n');
console.log('Key Insights:');
console.log('- For few updates: Y.Map and YKeyValue are similar in size');
console.log(
	'- For many updates to same keys: YKeyValue stays bounded, Y.Map grows',
);
console.log(
	'- YKeyValue has slightly more overhead per operation (cleanup scan)',
);
console.log(
	'- For typical KV (few keys, occasional updates): either works fine',
);
console.log(
	'- For high-frequency updates: YKeyValue prevents unbounded growth',
);
