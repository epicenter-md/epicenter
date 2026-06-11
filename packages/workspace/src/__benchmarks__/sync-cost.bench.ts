/**
 * Sync Cost Benchmarks
 *
 * Answers: "What does collaborative sync cost in size and time?"
 *
 * Measures delta sizes and merge times for two diverged Y.Docs. The core
 * of collaborative editing. Tests both small divergence (few edits while
 * offline) and large divergence (extended offline editing sessions).
 */

import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { attachTable } from '../document/table.js';
import {
	formatBytes,
	generateId,
	measureTime,
	postDefinition,
} from './helpers.js';

/** Sync two docs bidirectionally */
function syncBoth(docA: Y.Doc, docB: Y.Doc) {
	Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
	Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));
}

// ═══════════════════════════════════════════════════════════════════════════════
// Delta Size: How Much Data Needs to Transfer?
// ═══════════════════════════════════════════════════════════════════════════════

describe('sync delta size', () => {
	test('small divergence: 10 edits while offline', () => {
		const docA = new Y.Doc();
		const docB = new Y.Doc();

		const tablesA = { posts: attachTable(docA, 'posts', postDefinition) };

		// Shared baseline: 100 rows
		for (let i = 0; i < 100; i++) {
			tablesA.posts.set({
				id: generateId(i),
				title: `Post ${i}`,
				views: 0,
			});
		}
		syncBoth(docA, docB);

		const stateBeforeDivergence = Y.encodeStateVector(docA);

		// Client A makes 10 edits while offline
		for (let i = 0; i < 10; i++) {
			tablesA.posts.set({
				id: generateId(i),
				title: `Post ${i} (edited by A)`,
				views: i * 10,
			});
		}

		const deltaA = Y.encodeStateAsUpdate(docA, stateBeforeDivergence);
		const fullSnapshot = Y.encodeStateAsUpdate(docA);

		console.log('\n=== Small Divergence: 10 edits on 100-row doc ===');
		console.log(`  Full snapshot:  ${formatBytes(fullSnapshot.byteLength)}`);
		console.log(`  Sync delta:     ${formatBytes(deltaA.byteLength)}`);
		console.log(
			`  Savings:        ${((1 - deltaA.byteLength / fullSnapshot.byteLength) * 100).toFixed(1)}% smaller than full sync`,
		);

		expect(deltaA.byteLength).toBeLessThan(fullSnapshot.byteLength / 2);
	});

	test('large divergence: both clients edit 50 rows offline', () => {
		const docA = new Y.Doc();
		const docB = new Y.Doc();

		const tablesA = { posts: attachTable(docA, 'posts', postDefinition) };
		const tablesB = { posts: attachTable(docB, 'posts', postDefinition) };

		// Shared baseline: 100 rows
		for (let i = 0; i < 100; i++) {
			tablesA.posts.set({
				id: generateId(i),
				title: `Post ${i}`,
				views: 0,
			});
		}
		syncBoth(docA, docB);

		const stateA = Y.encodeStateVector(docA);
		const stateB = Y.encodeStateVector(docB);

		// Both clients diverge: A edits rows 0-49, B edits rows 50-99
		for (let i = 0; i < 50; i++) {
			tablesA.posts.set({
				id: generateId(i),
				title: `Post ${i} (A)`,
				views: 100,
			});
		}
		for (let i = 50; i < 100; i++) {
			tablesB.posts.set({
				id: generateId(i),
				title: `Post ${i} (B)`,
				views: 200,
			});
		}

		const deltaA = Y.encodeStateAsUpdate(docA, stateB);
		const deltaB = Y.encodeStateAsUpdate(docB, stateA);

		console.log('\n=== Large Divergence: Both clients edit 50 rows ===');
		console.log(`  Delta A→B: ${formatBytes(deltaA.byteLength)}`);
		console.log(`  Delta B→A: ${formatBytes(deltaB.byteLength)}`);
		console.log(
			`  Total sync traffic: ${formatBytes(deltaA.byteLength + deltaB.byteLength)}`,
		);
	});

	test('conflicting edits: both clients edit same rows', () => {
		const docA = new Y.Doc();
		const docB = new Y.Doc();

		const tablesA = { posts: attachTable(docA, 'posts', postDefinition) };
		const tablesB = { posts: attachTable(docB, 'posts', postDefinition) };

		// Shared baseline
		for (let i = 0; i < 100; i++) {
			tablesA.posts.set({
				id: generateId(i),
				title: `Post ${i}`,
				views: 0,
			});
		}
		syncBoth(docA, docB);

		// Both edit the SAME 20 rows
		for (let i = 0; i < 20; i++) {
			tablesA.posts.set({
				id: generateId(i),
				title: `Post ${i} version A`,
				views: 1,
			});
			tablesB.posts.set({
				id: generateId(i),
				title: `Post ${i} version B`,
				views: 2,
			});
		}

		// Measure merge
		const { durationMs: mergeMs } = measureTime(() => {
			syncBoth(docA, docB);
		});

		// After merge, both docs should have same content
		const sizeA = Y.encodeStateAsUpdate(docA).byteLength;
		const sizeB = Y.encodeStateAsUpdate(docB).byteLength;

		console.log('\n=== Conflicting Edits: Both edit same 20 rows ===');
		console.log(`  Merge time:     ${mergeMs.toFixed(2)}ms`);
		console.log(`  Doc A size:     ${formatBytes(sizeA)}`);
		console.log(`  Doc B size:     ${formatBytes(sizeB)}`);
		console.log(`  Docs identical: ${sizeA === sizeB ? 'YES ✓' : 'NO ⚠'}`);

		expect(sizeA).toBe(sizeB);
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
// Merge Time at Scale
// ═══════════════════════════════════════════════════════════════════════════════

describe('merge time at scale', () => {
	for (const editCount of [10, 100, 500]) {
		test(`merge ${editCount} diverged edits into 1K-row doc`, () => {
			const docA = new Y.Doc();
			const docB = new Y.Doc();

			const tablesA = { posts: attachTable(docA, 'posts', postDefinition) };

			// Baseline
			for (let i = 0; i < 1_000; i++) {
				tablesA.posts.set({
					id: generateId(i),
					title: `Post ${i}`,
					views: 0,
				});
			}
			syncBoth(docA, docB);

			// Client A diverges
			for (let i = 0; i < editCount; i++) {
				tablesA.posts.set({
					id: generateId(i % 1_000),
					title: `Edited ${i}`,
					views: i,
				});
			}

			const delta = Y.encodeStateAsUpdate(docA, Y.encodeStateVector(docB));
			const { durationMs } = measureTime(() => {
				Y.applyUpdate(docB, delta);
			});

			console.log(
				`Merge ${editCount} edits: ${durationMs.toFixed(2)}ms (${formatBytes(delta.byteLength)} delta)`,
			);
		});
	}
});
