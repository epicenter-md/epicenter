#!/usr/bin/env bun
/**
 * Encrypted YKeyValueLww Storage Benchmark
 *
 * Measures CRDT + encryption overhead for the encrypted key-value store.
 * Tests tombstone behavior (gc:true vs gc:false), encryption tax per entry,
 * and whether size grows unboundedly under churn.
 *
 * Usage: bun run encrypted-kv-benchmark.ts
 */
import * as Y from 'yjs';
import { createEncryptedYkvLww } from '../../../packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww-encrypted';
import { YKeyValueLww } from '../../../packages/workspace/src/document/y-keyvalue/y-keyvalue-lww';
import type { YKeyValueLwwEntry } from '../../../packages/workspace/src/document/y-keyvalue/y-keyvalue-lww';

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

function header(title: string) {
	console.log('');
	console.log('─'.repeat(70));
	console.log(title);
	console.log('─'.repeat(70));
}

type Row = { id: string; name: string; description: string; updatedAt: number };

const makeRow = (i: number): Row => ({
	id: `item_${i}`,
	name: `item-${i}`,
	description: `Description for item ${i} with some padding to simulate real data`,
	updatedAt: Date.now(),
});

// ═══════════════════════════════════════════════════════════════════════
// TEST 1: Encryption tax per entry (plaintext vs encrypted)
// ═══════════════════════════════════════════════════════════════════════

header('TEST 1: Encryption overhead per entry (100 rows)');

const key = generateEncryptionKey();
const keyring = new Map([[1, key]]);

const plainDoc = new Y.Doc({ guid: 'plain' });
const plainArr = plainDoc.getArray<YKeyValueLwwEntry<Row>>('data');
const plainKv = new YKeyValueLww<Row>(plainArr);

const encDoc = new Y.Doc({ guid: 'encrypted' });
const encKv = createEncryptedYkvLww<Row>(encDoc, 'data');
encKv.activateEncryption(keyring);

for (let i = 0; i < 100; i++) {
	const row = makeRow(i);
	plainKv.set(`item_${i}`, row);
	encKv.set(`item_${i}`, row);
}

const plainSize = size(plainDoc);
const encSize = size(encDoc);
console.log(`Plaintext (100 rows):   ${fmt(plainSize)}`);
console.log(`Encrypted (100 rows):   ${fmt(encSize)}`);
console.log(`Encryption overhead:    ${((encSize / plainSize - 1) * 100).toFixed(1)}%`);
console.log(`Per-entry overhead:     ~${Math.round((encSize - plainSize) / 100)} bytes/entry`);

// ═══════════════════════════════════════════════════════════════════════
// TEST 2: Tombstones are free (gc:true): add/delete cycles
// ═══════════════════════════════════════════════════════════════════════

header('TEST 2: Tombstones with gc:true: add 1000, delete all, repeat 5x');

const gcDoc = new Y.Doc({ guid: 'gc-true', gc: true });
const gcKv = createEncryptedYkvLww<Row>(gcDoc, 'data');
gcKv.activateEncryption(keyring);

for (let cycle = 0; cycle < 5; cycle++) {
	for (let i = 0; i < 1_000; i++) {
		gcKv.set(`item_${i}`, makeRow(i));
	}
	for (let i = 0; i < 1_000; i++) {
		gcKv.delete(`item_${i}`);
	}
	console.log(
		`  Cycle ${cycle + 1}: ${fmt(size(gcDoc)).padStart(10)}  (${gcKv.size} active)`,
	);
}

// ═══════════════════════════════════════════════════════════════════════
// TEST 3: Tombstones NOT free (gc:false): add/delete cycles
// ═══════════════════════════════════════════════════════════════════════

header('TEST 3: Tombstones with gc:false: add 1000, delete all, repeat 5x');

const noGcDoc = new Y.Doc({ guid: 'gc-false', gc: false });
const noGcKv = createEncryptedYkvLww<Row>(noGcDoc, 'data');
noGcKv.activateEncryption(keyring);

for (let cycle = 0; cycle < 5; cycle++) {
	for (let i = 0; i < 1_000; i++) {
		noGcKv.set(`item_${i}`, makeRow(i));
	}
	for (let i = 0; i < 1_000; i++) {
		noGcKv.delete(`item_${i}`);
	}
	console.log(
		`  Cycle ${cycle + 1}: ${fmt(size(noGcDoc)).padStart(10)}  (${noGcKv.size} active)`,
	);
}

// ═══════════════════════════════════════════════════════════════════════
// TEST 4: Update-heavy workload (same keys, many updates)
// ═══════════════════════════════════════════════════════════════════════

header('TEST 4: 50 keys × 100 updates each (gc:true, encrypted)');

const updateDoc = new Y.Doc({ guid: 'updates', gc: true });
const updateKv = createEncryptedYkvLww<Row>(updateDoc, 'data');
updateKv.activateEncryption(keyring);

// Initial insert
for (let i = 0; i < 50; i++) {
	updateKv.set(`item_${i}`, makeRow(i));
}
console.log(`After initial 50 rows:  ${fmt(size(updateDoc))}`);

// 100 rounds of updating all 50 keys
for (let round = 0; round < 100; round++) {
	for (let i = 0; i < 50; i++) {
		updateKv.set(`item_${i}`, {
			...makeRow(i),
			description: `Edit ${round} for item ${i}`,
		});
	}
}
console.log(`After 5,000 updates:    ${fmt(size(updateDoc))}`);

// Fresh doc with same final data
const freshUpdateDoc = new Y.Doc({ guid: 'updates-fresh', gc: true });
const freshUpdateKv = createEncryptedYkvLww<Row>(freshUpdateDoc, 'data');
freshUpdateKv.activateEncryption(keyring);
for (let i = 0; i < 50; i++) {
	freshUpdateKv.set(`item_${i}`, {
		...makeRow(i),
		description: `Edit 99 for item ${i}`,
	});
}
console.log(`Fresh (same data):      ${fmt(size(freshUpdateDoc))}`);
console.log(
	`Overhead:               ${((size(updateDoc) / size(freshUpdateDoc) - 1) * 100).toFixed(1)}%`,
);

// ═══════════════════════════════════════════════════════════════════════
// TEST 5: Interleaved add/remove churn (realistic workload)
// ═══════════════════════════════════════════════════════════════════════

header('TEST 5: Interleaved add 20 / remove 10, 50 cycles (gc:true, encrypted)');

const churnDoc = new Y.Doc({ guid: 'churn', gc: true });
const churnKv = createEncryptedYkvLww<Row>(churnDoc, 'data');
churnKv.activateEncryption(keyring);

let nextId = 0;
let activeKeys: string[] = [];

for (let cycle = 0; cycle < 50; cycle++) {
	// Add 20
	for (let i = 0; i < 20; i++) {
		const k = `item_${nextId++}`;
		churnKv.set(k, makeRow(nextId));
		activeKeys.push(k);
	}
	// Remove 10 from the front
	for (let i = 0; i < 10; i++) {
		churnKv.delete(activeKeys.shift()!);
	}

	if (cycle % 10 === 9) {
		console.log(
			`  Cycle ${cycle + 1}: ${fmt(size(churnDoc)).padStart(10)}  (${activeKeys.length} active)`,
		);
	}
}

// Fresh doc with same final data
const freshChurnDoc = new Y.Doc({ guid: 'churn-fresh', gc: true });
const freshChurnKv = createEncryptedYkvLww<Row>(freshChurnDoc, 'data');
freshChurnKv.activateEncryption(keyring);
for (const k of activeKeys) {
	freshChurnKv.set(k, makeRow(Number(k.split('_')[1])));
}
console.log(`  Fresh (same data): ${fmt(size(freshChurnDoc)).padStart(10)}  (${activeKeys.length} active)`);
console.log(
	`  Overhead: ${((size(churnDoc) / size(freshChurnDoc) - 1) * 100).toFixed(1)}%`,
);

// ═══════════════════════════════════════════════════════════════════════
// TEST 6: Scale test: 10,000 encrypted rows
// ═══════════════════════════════════════════════════════════════════════

header('TEST 6: Scale: 10,000 encrypted rows');

const scaleDoc = new Y.Doc({ guid: 'scale', gc: true });
const scaleKv = createEncryptedYkvLww<Row>(scaleDoc, 'data');
scaleKv.activateEncryption(keyring);

const scalePlainDoc = new Y.Doc({ guid: 'scale-plain', gc: true });
const scalePlainArr = scalePlainDoc.getArray<YKeyValueLwwEntry<Row>>('data');
const scalePlainKv = new YKeyValueLww<Row>(scalePlainArr);

for (let i = 0; i < 10_000; i++) {
	const row = makeRow(i);
	scaleKv.set(`item_${i}`, row);
	scalePlainKv.set(`item_${i}`, row);
}

console.log(`Plaintext (10k rows):   ${fmt(size(scalePlainDoc))}`);
console.log(`Encrypted (10k rows):   ${fmt(size(scaleDoc))}`);
console.log(
	`Encryption overhead:    ${((size(scaleDoc) / size(scalePlainDoc) - 1) * 100).toFixed(1)}%`,
);

// ═══════════════════════════════════════════════════════════════════════

header('SUMMARY');
console.log('gc:true : Tombstones merge. Add/delete cycles stay bounded.');
console.log('gc:false: Tombstones accumulate. Size grows with operation count.');
console.log('Encryption adds ~40-60 bytes/entry (nonce + tag + header).');
console.log('Update overhead with gc:true is minimal (GC structs merge).');
console.log('');
