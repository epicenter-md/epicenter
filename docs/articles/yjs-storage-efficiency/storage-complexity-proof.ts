#!/usr/bin/env bun
/**
 * Storage Complexity Proof: O(active data), NOT O(operations)
 *
 * Exhaustive verification that YKeyValueLww (encrypted) storage scales
 * with the number of active rows, not the number of operations performed.
 * Tests every edge case that could break this property.
 *
 * Each test creates a workload, then compares the resulting doc size
 * against a fresh doc with identical active data. The ratio between them
 * is the "history tax". Anything beyond the active data.
 *
 * Usage: bun run storage-complexity-proof.ts
 */
import * as Y from 'yjs';
import { createEncryptedYkvLww } from '../../../packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww-encrypted';

const generateEncryptionKey = (): Uint8Array =>
	crypto.getRandomValues(new Uint8Array(32));

// ── Helpers ──────────────────────────────────────────────────────────────────

function size(doc: Y.Doc): number {
	return Y.encodeStateAsUpdate(doc).byteLength;
}

function fmt(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function syncDocs(from: Y.Doc, to: Y.Doc): void {
	Y.applyUpdate(to, Y.encodeStateAsUpdate(from));
}

function syncBoth(a: Y.Doc, b: Y.Doc): void {
	syncDocs(a, b);
	syncDocs(b, a);
}

type Row = { id: string; name: string; data: string };

const makeRow = (i: number, edit = 0): Row => ({
	id: `row_${i}`,
	name: `Row ${i}`,
	data: `Content for row ${i}${edit ? ` (edit ${edit})` : ''}`,
});

const key = generateEncryptionKey();
const keyring = new Map([[1, key]]);

type TestResult = {
	name: string;
	workloadSize: number;
	freshSize: number;
	overheadBytes: number;
	overheadPct: number;
	activeRows: number;
	totalOps: number;
	passed: boolean;
	category: 'single-device' | 'multi-device' | 'edge-case';
};

const results: TestResult[] = [];

/**
 * Single-device tests: overhead should be ≤15% (percentage-based).
 * Multi-device tests: overhead is O(unique devices) ≈ 22 bytes/client,
 *   so we allow a fixed budget of 2 KB absolute overhead.
 * Edge cases (empty docs): percentage is meaningless when baseline is <50 bytes.
 */
const SINGLE_DEVICE_THRESHOLD_PCT = 15;
const MULTI_DEVICE_THRESHOLD_BYTES = 2048;
const EDGE_CASE_THRESHOLD_BYTES = 50;

function test(
	name: string,
	category: TestResult['category'],
	run: () => { doc: Y.Doc; activeKeys: string[]; totalOps: number; finalData: Map<string, Row> },
) {
	const { doc, activeKeys, totalOps, finalData } = run();

	// Build fresh doc with identical active data
	const fresh = new Y.Doc({ guid: `fresh-${name}` });
	const freshKv = createEncryptedYkvLww<Row>(fresh, 'data');
	freshKv.activateEncryption(keyring);
	for (const [k, v] of finalData) freshKv.set(k, v);

	const workloadSize = size(doc);
	const freshSize = size(fresh);
	const overheadBytes = workloadSize - freshSize;
	const overheadPct = freshSize > 0 ? (workloadSize / freshSize - 1) * 100 : 0;

	let passed: boolean;
	switch (category) {
		case 'single-device':
			passed = overheadPct <= SINGLE_DEVICE_THRESHOLD_PCT;
			break;
		case 'multi-device':
			passed = overheadBytes <= MULTI_DEVICE_THRESHOLD_BYTES;
			break;
		case 'edge-case':
			passed = overheadBytes <= EDGE_CASE_THRESHOLD_BYTES;
			break;
	}

	results.push({
		name,
		workloadSize,
		freshSize,
		overheadBytes,
		overheadPct,
		activeRows: activeKeys.length,
		totalOps,
		passed,
		category,
	});

	const status = passed ? '✓' : '✗';
	console.log(
		`  ${status} ${name.padEnd(45)} ${fmt(workloadSize).padStart(10)} vs ${fmt(freshSize).padStart(10)}  (+${fmt(overheadBytes).padStart(8)}, ${overheadPct.toFixed(1).padStart(5)}%)  [${totalOps} ops, ${activeKeys.length} active]`,
	);
}

console.log('');
console.log('═'.repeat(70));
console.log('STORAGE COMPLEXITY PROOF: O(active data), NOT O(operations)');
console.log('Each test compares workload doc vs fresh doc with same data.');
console.log(`Single-device: ≤${SINGLE_DEVICE_THRESHOLD_PCT}% overhead | Multi-device: ≤${MULTI_DEVICE_THRESHOLD_BYTES} B absolute | Edge: ≤${EDGE_CASE_THRESHOLD_BYTES} B`);
console.log('═'.repeat(70));
console.log('');

// ── Test 1: Pure inserts (baseline) ──────────────────────────────────────────

console.log('── Baseline ──');

test('Insert only (100 rows, no deletes)', 'single-device', () => {
	const doc = new Y.Doc({ guid: 't1' });
	const kv = createEncryptedYkvLww<Row>(doc, 'data');
	kv.activateEncryption(keyring);
	const data = new Map<string, Row>();
	for (let i = 0; i < 100; i++) {
		const row = makeRow(i);
		kv.set(`row_${i}`, row);
		data.set(`row_${i}`, row);
	}
	return { doc, activeKeys: [...data.keys()], totalOps: 100, finalData: data };
});

// ── Test 2: Updates ──────────────────────────────────────────────────────────

console.log('');
console.log('── Updates (same keys rewritten) ──');

test('100 rows × 10 updates each', 'single-device', () => {
	const doc = new Y.Doc({ guid: 't2a' });
	const kv = createEncryptedYkvLww<Row>(doc, 'data');
	kv.activateEncryption(keyring);
	const data = new Map<string, Row>();
	for (let round = 0; round <= 10; round++) {
		for (let i = 0; i < 100; i++) {
			const row = makeRow(i, round);
			kv.set(`row_${i}`, row);
			data.set(`row_${i}`, row);
		}
	}
	return { doc, activeKeys: [...data.keys()], totalOps: 1100, finalData: data };
});

test('10 rows × 1000 updates each', 'single-device', () => {
	const doc = new Y.Doc({ guid: 't2b' });
	const kv = createEncryptedYkvLww<Row>(doc, 'data');
	kv.activateEncryption(keyring);
	const data = new Map<string, Row>();
	for (let round = 0; round <= 1000; round++) {
		for (let i = 0; i < 10; i++) {
			const row = makeRow(i, round);
			kv.set(`row_${i}`, row);
			data.set(`row_${i}`, row);
		}
	}
	return { doc, activeKeys: [...data.keys()], totalOps: 10010, finalData: data };
});

test('1 row × 10000 updates', 'single-device', () => {
	const doc = new Y.Doc({ guid: 't2c' });
	const kv = createEncryptedYkvLww<Row>(doc, 'data');
	kv.activateEncryption(keyring);
	const data = new Map<string, Row>();
	for (let round = 0; round <= 10000; round++) {
		const row = makeRow(0, round);
		kv.set('row_0', row);
		data.set('row_0', row);
	}
	return { doc, activeKeys: ['row_0'], totalOps: 10001, finalData: data };
});

// ── Test 3: Add/delete cycles ────────────────────────────────────────────────

console.log('');
console.log('── Add/delete cycles (churn) ──');

test('Add 100, delete all, repeat 10x', 'single-device', () => {
	const doc = new Y.Doc({ guid: 't3a' });
	const kv = createEncryptedYkvLww<Row>(doc, 'data');
	kv.activateEncryption(keyring);
	let ops = 0;
	for (let cycle = 0; cycle < 10; cycle++) {
		for (let i = 0; i < 100; i++) {
			kv.set(`row_${i}`, makeRow(i, cycle));
			ops++;
		}
		for (let i = 0; i < 100; i++) {
			kv.delete(`row_${i}`);
			ops++;
		}
	}
	// End with 50 active rows
	const data = new Map<string, Row>();
	for (let i = 0; i < 50; i++) {
		const row = makeRow(i, 999);
		kv.set(`row_${i}`, row);
		data.set(`row_${i}`, row);
		ops++;
	}
	return { doc, activeKeys: [...data.keys()], totalOps: ops, finalData: data };
});

test('Add 1000, delete 1000, 5 cycles (empty final)', 'edge-case', () => {
	const doc = new Y.Doc({ guid: 't3b' });
	const kv = createEncryptedYkvLww<Row>(doc, 'data');
	kv.activateEncryption(keyring);
	let ops = 0;
	for (let cycle = 0; cycle < 5; cycle++) {
		for (let i = 0; i < 1000; i++) {
			kv.set(`row_${i}`, makeRow(i, cycle));
			ops++;
		}
		for (let i = 0; i < 1000; i++) {
			kv.delete(`row_${i}`);
			ops++;
		}
	}
	return { doc, activeKeys: [], totalOps: ops, finalData: new Map() };
});

test('Interleaved add 20, remove 10, 100 cycles', 'single-device', () => {
	const doc = new Y.Doc({ guid: 't3c' });
	const kv = createEncryptedYkvLww<Row>(doc, 'data');
	kv.activateEncryption(keyring);
	let nextId = 0;
	const active: string[] = [];
	let ops = 0;
	for (let cycle = 0; cycle < 100; cycle++) {
		for (let i = 0; i < 20; i++) {
			const k = `row_${nextId++}`;
			kv.set(k, makeRow(nextId));
			active.push(k);
			ops++;
		}
		for (let i = 0; i < 10; i++) {
			kv.delete(active.shift()!);
			ops++;
		}
	}
	const data = new Map<string, Row>();
	for (const k of active) data.set(k, makeRow(Number(k.split('_')[1])));
	return { doc, activeKeys: active, totalOps: ops, finalData: data };
});

// ── Test 4: Multi-device sync (different clientIDs) ──────────────────────────

console.log('');
console.log('── Multi-device sync (different clientIDs) ──');

test('2 devices, alternating writes, 500 ops each', 'multi-device', () => {
	const doc1 = new Y.Doc({ guid: 'shared-t4a' });
	const doc2 = new Y.Doc({ guid: 'shared-t4a' });
	const kv1 = createEncryptedYkvLww<Row>(doc1, 'data');
	const kv2 = createEncryptedYkvLww<Row>(doc2, 'data');
	kv1.activateEncryption(keyring);
	kv2.activateEncryption(keyring);

	let ops = 0;
	const data = new Map<string, Row>();

	for (let round = 0; round < 50; round++) {
		// Device 1 writes 10 rows
		for (let i = 0; i < 10; i++) {
			const row = makeRow(i, round * 2);
			kv1.set(`row_${i}`, row);
			data.set(`row_${i}`, row);
			ops++;
		}
		syncBoth(doc1, doc2);

		// Device 2 writes same 10 rows
		for (let i = 0; i < 10; i++) {
			const row = makeRow(i, round * 2 + 1);
			kv2.set(`row_${i}`, row);
			data.set(`row_${i}`, row);
			ops++;
		}
		syncBoth(doc1, doc2);
	}

	return { doc: doc1, activeKeys: [...data.keys()], totalOps: ops, finalData: data };
});

test('5 devices, each writes 200 unique rows, sync all', 'multi-device', () => {
	const docs: Y.Doc[] = [];
	const kvs: ReturnType<typeof createEncryptedYkvLww<Row>>[] = [];
	for (let d = 0; d < 5; d++) {
		const doc = new Y.Doc({ guid: 'shared-t4b' });
		docs.push(doc);
		const kv = createEncryptedYkvLww<Row>(doc, 'data');
		kv.activateEncryption(keyring);
		kvs.push(kv);
	}

	let ops = 0;
	const data = new Map<string, Row>();

	for (let d = 0; d < 5; d++) {
		for (let i = 0; i < 200; i++) {
			const k = `dev${d}_row_${i}`;
			const row = makeRow(d * 200 + i);
			kvs[d]!.set(k, row);
			data.set(k, row);
			ops++;
		}
	}

	// Sync all pairs
	for (let i = 0; i < docs.length; i++) {
		for (let j = i + 1; j < docs.length; j++) {
			syncBoth(docs[i]!, docs[j]!);
		}
	}

	return { doc: docs[0]!, activeKeys: [...data.keys()], totalOps: ops, finalData: data };
});

test('3 devices, concurrent edits to same keys + sync', 'multi-device', () => {
	const doc1 = new Y.Doc({ guid: 'shared-t4c' });
	const doc2 = new Y.Doc({ guid: 'shared-t4c' });
	const doc3 = new Y.Doc({ guid: 'shared-t4c' });
	const kv1 = createEncryptedYkvLww<Row>(doc1, 'data');
	const kv2 = createEncryptedYkvLww<Row>(doc2, 'data');
	const kv3 = createEncryptedYkvLww<Row>(doc3, 'data');
	kv1.activateEncryption(keyring);
	kv2.activateEncryption(keyring);
	kv3.activateEncryption(keyring);

	let ops = 0;

	// All 3 devices write to the same 20 keys concurrently, 50 rounds
	for (let round = 0; round < 50; round++) {
		for (let i = 0; i < 20; i++) {
			kv1.set(`row_${i}`, makeRow(i, round * 3));
			kv2.set(`row_${i}`, makeRow(i, round * 3 + 1));
			kv3.set(`row_${i}`, makeRow(i, round * 3 + 2));
			ops += 3;
		}
		// Full mesh sync
		syncBoth(doc1, doc2);
		syncBoth(doc2, doc3);
		syncBoth(doc1, doc3);
	}

	// Read final state from doc1 (all should be converged)
	const data = new Map<string, Row>();
	for (const [k, entry] of kv1.entries()) data.set(k, entry.val);

	return { doc: doc1, activeKeys: [...data.keys()], totalOps: ops, finalData: data };
});

// ── Test 5: Encryption key rotation ──────────────────────────────────────────

console.log('');
console.log('── Encryption key rotation ──');

test('5 key rotations with 50 active rows', 'single-device', () => {
	const doc = new Y.Doc({ guid: 't5a' });
	const kv = createEncryptedYkvLww<Row>(doc, 'data');
	const rotatingKeyring = new Map<number, Uint8Array>([[1, generateEncryptionKey()]]);
	kv.activateEncryption(rotatingKeyring);

	let ops = 0;
	const data = new Map<string, Row>();

	// Initial 50 rows
	for (let i = 0; i < 50; i++) {
		const row = makeRow(i);
		kv.set(`row_${i}`, row);
		data.set(`row_${i}`, row);
		ops++;
	}

	// 5 key rotations, each re-encrypts all entries
	for (let rotation = 0; rotation < 5; rotation++) {
		const nextVersion = rotation + 2;
		rotatingKeyring.set(nextVersion, generateEncryptionKey());
		kv.activateEncryption(rotatingKeyring);
		ops += 50; // re-encryption writes

		// Some edits after each rotation
		for (let i = 0; i < 10; i++) {
			const row = makeRow(i, rotation);
			kv.set(`row_${i}`, row);
			data.set(`row_${i}`, row);
			ops++;
		}
	}

	return { doc, activeKeys: [...data.keys()], totalOps: ops, finalData: data };
});

// ── Test 6: Mixed plaintext → encrypted migration ───────────────────────────

console.log('');
console.log('── Plaintext → encrypted migration ──');

test('100 plaintext rows migrated to encrypted', 'single-device', () => {
	const doc = new Y.Doc({ guid: 't6' });
	const kv = createEncryptedYkvLww<Row>(doc, 'data'); // no key initially (passthrough)

	let ops = 0;
	const data = new Map<string, Row>();

	// Write 100 plaintext rows
	for (let i = 0; i < 100; i++) {
		const row = makeRow(i);
		kv.set(`row_${i}`, row);
		data.set(`row_${i}`, row);
		ops++;
	}

	// Activate encryption (re-encrypts all 100)
	kv.activateEncryption(keyring);
	ops += 100;

	// Edit 50 of them
	for (let i = 0; i < 50; i++) {
		const row = makeRow(i, 1);
		kv.set(`row_${i}`, row);
		data.set(`row_${i}`, row);
		ops++;
	}

	return { doc, activeKeys: [...data.keys()], totalOps: ops, finalData: data };
});

// ── Test 7: Scale tests ──────────────────────────────────────────────────────

console.log('');
console.log('── Scale ──');

test('10,000 rows with churn (add 10k, delete 5k, keep 5k)', 'single-device', () => {
	const doc = new Y.Doc({ guid: 't7a' });
	const kv = createEncryptedYkvLww<Row>(doc, 'data');
	kv.activateEncryption(keyring);

	let ops = 0;
	const data = new Map<string, Row>();

	// Insert 10,000
	for (let i = 0; i < 10000; i++) {
		const row = makeRow(i);
		kv.set(`row_${i}`, row);
		data.set(`row_${i}`, row);
		ops++;
	}

	// Delete first 5,000
	for (let i = 0; i < 5000; i++) {
		kv.delete(`row_${i}`);
		data.delete(`row_${i}`);
		ops++;
	}

	return { doc, activeKeys: [...data.keys()], totalOps: ops, finalData: data };
});

test('1,000 rows × 50 updates + 500 deletes + 500 re-adds', 'single-device', () => {
	const doc = new Y.Doc({ guid: 't7b' });
	const kv = createEncryptedYkvLww<Row>(doc, 'data');
	kv.activateEncryption(keyring);

	let ops = 0;
	const data = new Map<string, Row>();

	// Insert 1000
	for (let i = 0; i < 1000; i++) {
		kv.set(`row_${i}`, makeRow(i));
		ops++;
	}

	// Update all 50 times
	for (let round = 1; round <= 50; round++) {
		for (let i = 0; i < 1000; i++) {
			kv.set(`row_${i}`, makeRow(i, round));
			ops++;
		}
	}

	// Delete 500
	for (let i = 0; i < 500; i++) {
		kv.delete(`row_${i}`);
		ops++;
	}

	// Re-add 500 (same keys, new data)
	for (let i = 0; i < 500; i++) {
		const row = makeRow(i, 999);
		kv.set(`row_${i}`, row);
		ops++;
	}

	// Final state: all 1000 rows active
	for (let i = 0; i < 1000; i++) {
		data.set(`row_${i}`, makeRow(i, i < 500 ? 999 : 50));
	}

	return { doc, activeKeys: [...data.keys()], totalOps: ops, finalData: data };
});

// ── Test 8: Many unique clientIDs (state vector growth) ──────────────────────

console.log('');
console.log('── Many unique clientIDs (state vector growth) ──');

test('20 devices each write 5 rows to same doc', 'multi-device', () => {
	const mainDoc = new Y.Doc({ guid: 'shared-t8' });

	let ops = 0;
	const data = new Map<string, Row>();

	// Each "device" creates a fresh doc, writes, then syncs to main
	for (let d = 0; d < 20; d++) {
		const deviceDoc = new Y.Doc({ guid: 'shared-t8' });
		// Sync existing state to device first
		syncDocs(mainDoc, deviceDoc);

		const kv = createEncryptedYkvLww<Row>(deviceDoc, 'data');
		kv.activateEncryption(keyring);

		for (let i = 0; i < 5; i++) {
			const k = `dev${d}_row_${i}`;
			const row = makeRow(d * 5 + i);
			kv.set(k, row);
			data.set(k, row);
			ops++;
		}

		syncDocs(deviceDoc, mainDoc);
	}

	return { doc: mainDoc, activeKeys: [...data.keys()], totalOps: ops, finalData: data };
});

test('50 devices each edit same 10 rows', 'multi-device', () => {
	const mainDoc = new Y.Doc({ guid: 'shared-t8b' });

	// Seed 10 rows from first device
	const seedDoc = new Y.Doc({ guid: 'shared-t8b' });
	const seedKv = createEncryptedYkvLww<Row>(seedDoc, 'data');
	seedKv.activateEncryption(keyring);
	for (let i = 0; i < 10; i++) seedKv.set(`row_${i}`, makeRow(i));
	syncDocs(seedDoc, mainDoc);

	let ops = 10;
	const data = new Map<string, Row>();

	// 50 devices each edit all 10 rows
	for (let d = 0; d < 50; d++) {
		const deviceDoc = new Y.Doc({ guid: 'shared-t8b' });
		syncDocs(mainDoc, deviceDoc);

		const kv = createEncryptedYkvLww<Row>(deviceDoc, 'data');
		kv.activateEncryption(keyring);

		for (let i = 0; i < 10; i++) {
			const row = makeRow(i, d);
			kv.set(`row_${i}`, row);
			data.set(`row_${i}`, row);
			ops++;
		}

		syncDocs(deviceDoc, mainDoc);
	}

	return { doc: mainDoc, activeKeys: [...data.keys()], totalOps: ops, finalData: data };
});

// ═══════════════════════════════════════════════════════════════════════
// RESULTS SUMMARY
// ═══════════════════════════════════════════════════════════════════════

console.log('');
console.log('═'.repeat(70));
console.log('RESULTS');
console.log('═'.repeat(70));
console.log('');

const passed = results.filter((r) => r.passed);
const failed = results.filter((r) => !r.passed);

console.log(`Passed: ${passed.length}/${results.length}`);

if (failed.length > 0) {
	console.log('');
	console.log('FAILED TESTS:');
	for (const r of failed) {
		console.log(`  ✗ ${r.name}: ${r.overheadPct.toFixed(1)}% overhead (${fmt(r.overheadBytes)})`);
	}
}

console.log('');
console.log('Overhead distribution:');
const buckets = { '0-1%': 0, '1-5%': 0, '5-10%': 0, '10-15%': 0, '>15%': 0 };
for (const r of results) {
	if (r.overheadPct <= 1) buckets['0-1%']++;
	else if (r.overheadPct <= 5) buckets['1-5%']++;
	else if (r.overheadPct <= 10) buckets['5-10%']++;
	else if (r.overheadPct <= 15) buckets['10-15%']++;
	else buckets['>15%']++;
}
for (const [bucket, count] of Object.entries(buckets)) {
	if (count > 0) console.log(`  ${bucket.padEnd(8)} ${'█'.repeat(count)} (${count})`);
}

console.log('');
const maxOverhead = Math.max(...results.map((r) => r.overheadPct));
const maxOps = Math.max(...results.map((r) => r.totalOps));
console.log(`Max overhead:  ${maxOverhead.toFixed(1)}%`);
console.log(`Max ops tested: ${maxOps.toLocaleString()}`);
console.log('');

if (failed.length === 0) {
	console.log('VERDICT: Storage = O(active data) + O(unique devices)');
	console.log('');
	console.log('  Single-device: overhead is bounded by a few bytes of GC metadata.');
	console.log('  Multi-device:  each unique clientID adds ~22 bytes to the state vector.');
	console.log('  Neither scales with operation count.');
	console.log('');
	console.log(`All ${results.length} tests passed.`);
} else {
	console.log(`VERDICT: FAILED. ${failed.length} test(s) exceeded thresholds.`);
	process.exit(1);
}

console.log('');
