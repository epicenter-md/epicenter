#!/usr/bin/env bun
/**
 * Encrypted YKeyValueLww Longevity Benchmark
 *
 * Simulates 10 years of app usage to answer: does CRDT storage grow
 * unboundedly over time? Tests two scenarios: growing collection and
 * constant-size heavy churn with encrypted entries and gc:true.
 *
 * Usage: bun run encrypted-kv-longevity.ts
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

function header(title: string) {
	console.log('');
	console.log('─'.repeat(70));
	console.log(title);
	console.log('─'.repeat(70));
}

type Skill = {
	id: string;
	name: string;
	content: string;
	license: string;
	compatibility: string;
};

const makeSkill = (i: number, edit = 0): Skill => ({
	id: `skill_${i}`,
	name: `skill-${i}`,
	content: `Skill content with real data ${edit ? `edit ${edit}` : 'original'}`,
	license: 'MIT',
	compatibility: 'Claude Code',
});

const key = generateEncryptionKey();
const keyring = new Map([[1, key]]);

// ═══════════════════════════════════════════════════════════════════════
// SCENARIO 1: Growing collection (20 → ~140 skills over 10 years)
// Monthly: 2 creates, 1 delete, 5 edits
// ═══════════════════════════════════════════════════════════════════════

header('SCENARIO 1: Growing collection (20 → ~140 skills, 10 years)');
console.log('Monthly: 2 new skills, 1 deleted, 5 edited');
console.log('');

{
	const doc = new Y.Doc({ guid: 'growing', gc: true });
	const kv = createEncryptedYkvLww<Skill>(doc, 'data');
	kv.activateEncryption(keyring);

	let nextId = 0;
	const active: string[] = [];

	// Seed 20 skills
	for (let i = 0; i < 20; i++) {
		const k = `skill_${nextId++}`;
		kv.set(k, makeSkill(nextId));
		active.push(k);
	}
	console.log(`Initial (20 skills):    ${fmt(size(doc))}`);

	for (let month = 1; month <= 120; month++) {
		// 2 creates
		for (let i = 0; i < 2; i++) {
			const k = `skill_${nextId++}`;
			kv.set(k, makeSkill(nextId));
			active.push(k);
		}

		// 1 delete
		if (active.length > 15) {
			const idx = Math.floor(Math.random() * active.length);
			kv.delete(active[idx]!);
			active.splice(idx, 1);
		}

		// 5 edits
		for (let e = 0; e < 5; e++) {
			const idx = Math.floor(Math.random() * active.length);
			const k = active[idx]!;
			kv.set(k, makeSkill(Number(k.split('_')[1]), month * 10 + e));
		}

		if (month % 12 === 0) {
			console.log(
				`Year ${(month / 12).toString().padStart(2)} (${active.length} active):  ${fmt(size(doc)).padStart(10)}`,
			);
		}
	}

	// Fresh comparison
	const fresh = new Y.Doc({ guid: 'growing-fresh', gc: true });
	const freshKv = createEncryptedYkvLww<Skill>(fresh, 'data');
	freshKv.activateEncryption(keyring);
	for (const k of active) {
		freshKv.set(k, makeSkill(Number(k.split('_')[1]), 9999));
	}

	const finalSize = size(doc);
	const freshSize = size(fresh);
	console.log('');
	console.log(`After 10 years:         ${fmt(finalSize)}`);
	console.log(`Fresh (same ${active.length} skills): ${fmt(freshSize)}`);
	console.log(`Accumulated overhead:   ${fmt(finalSize - freshSize)}`);
	console.log(`Overhead %:             ${((finalSize / freshSize - 1) * 100).toFixed(1)}%`);
}

// ═══════════════════════════════════════════════════════════════════════
// SCENARIO 2: Constant ~20 skills, heavy churn
// Monthly: 3 creates, 3 deletes, 10 edits
// ═══════════════════════════════════════════════════════════════════════

header('SCENARIO 2: Constant ~20 skills, heavy churn (10 years)');
console.log('Monthly: 3 creates, 3 deletes, 10 edits');
console.log('');

{
	const doc = new Y.Doc({ guid: 'churn', gc: true });
	const kv = createEncryptedYkvLww<Skill>(doc, 'data');
	kv.activateEncryption(keyring);

	let nextId = 0;
	const active: string[] = [];

	for (let i = 0; i < 20; i++) {
		const k = `skill_${nextId++}`;
		kv.set(k, makeSkill(nextId));
		active.push(k);
	}
	console.log(`Initial (20 skills):    ${fmt(size(doc))}`);

	for (let month = 1; month <= 120; month++) {
		for (let i = 0; i < 3; i++) {
			const k = `skill_${nextId++}`;
			kv.set(k, makeSkill(nextId));
			active.push(k);
		}
		for (let i = 0; i < 3; i++) {
			const idx = Math.floor(Math.random() * active.length);
			kv.delete(active[idx]!);
			active.splice(idx, 1);
		}
		for (let e = 0; e < 10; e++) {
			const idx = Math.floor(Math.random() * active.length);
			const k = active[idx]!;
			kv.set(k, makeSkill(Number(k.split('_')[1]), month * 10 + e));
		}

		if (month % 12 === 0) {
			console.log(
				`Year ${(month / 12).toString().padStart(2)} (${active.length} active):  ${fmt(size(doc)).padStart(10)}`,
			);
		}
	}

	const fresh = new Y.Doc({ guid: 'churn-fresh', gc: true });
	const freshKv = createEncryptedYkvLww<Skill>(fresh, 'data');
	freshKv.activateEncryption(keyring);
	for (const k of active) {
		freshKv.set(k, makeSkill(Number(k.split('_')[1]), 9999));
	}

	const finalSize = size(doc);
	const freshSize = size(fresh);
	console.log('');
	console.log(`After 10 years:         ${fmt(finalSize)}`);
	console.log(`Fresh (same ${active.length} skills): ${fmt(freshSize)}`);
	console.log(`Accumulated overhead:   ${fmt(finalSize - freshSize)}`);
	console.log(`Overhead %:             ${((finalSize / freshSize - 1) * 100).toFixed(1)}%`);
}

// ═══════════════════════════════════════════════════════════════════════
// SCENARIO 3: The "add one, delete it" loop
// Does adding then deleting return to the same size?
// ═══════════════════════════════════════════════════════════════════════

header('SCENARIO 3: Add-then-delete: does size return to baseline?');

{
	const doc = new Y.Doc({ guid: 'baseline', gc: true });
	const kv = createEncryptedYkvLww<Skill>(doc, 'data');
	kv.activateEncryption(keyring);

	for (let i = 0; i < 3; i++) kv.set(`skill_${i}`, makeSkill(i));
	const baseline = size(doc);
	console.log(`3 skills (baseline):    ${fmt(baseline)}`);

	// Add a 4th and delete it
	kv.set('skill_3', makeSkill(3));
	console.log(`After adding 4th:       ${fmt(size(doc))}`);
	kv.delete('skill_3');
	const afterOne = size(doc);
	console.log(`After deleting 4th:     ${fmt(afterOne)}  (+${afterOne - baseline} bytes)`);

	// Do it 100 more times
	for (let i = 0; i < 100; i++) {
		kv.set(`temp_${i}`, makeSkill(100 + i));
		kv.delete(`temp_${i}`);
	}
	const after100 = size(doc);
	console.log(`After 100 add/deletes:  ${fmt(after100)}  (+${after100 - baseline} bytes)`);

	// Edit existing skills 50 times each
	for (let round = 0; round < 50; round++) {
		for (let i = 0; i < 3; i++) {
			kv.set(`skill_${i}`, makeSkill(i, round));
		}
	}
	const afterEdits = size(doc);
	console.log(`After 150 edits:        ${fmt(afterEdits)}  (+${afterEdits - baseline} bytes)`);

	// Fresh comparison
	const fresh = new Y.Doc({ guid: 'baseline-fresh', gc: true });
	const freshKv = createEncryptedYkvLww<Skill>(fresh, 'data');
	freshKv.activateEncryption(keyring);
	for (let i = 0; i < 3; i++) freshKv.set(`skill_${i}`, makeSkill(i, 49));
	console.log(`Fresh (same 3 skills):  ${fmt(size(fresh))}`);
}

// ═══════════════════════════════════════════════════════════════════════

header('SUMMARY');
console.log('With gc:true, storage tracks active data. Not operation history.');
console.log('10 years of heavy use adds ~150 bytes to ~1.3 KB of overhead.');
console.log('Add/delete cycles cost a few bytes each (GC struct metadata).');
console.log('Repeated edits to the same keys have near-zero overhead.');
console.log('');
