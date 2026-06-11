/**
 * Deserialization Benchmarks
 *
 * Answers: "How fast is app startup? How long does it take to load a Y.Doc from binary?"
 *
 * Measures Y.applyUpdate() time at various document sizes. This is the critical
 * path for cold start, tab restore, and initial sync. Also measures snapshot
 * encoding time (encodeStateAsUpdate) which affects save-to-disk performance.
 */

import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { attachTable } from '../document/table.js';
import {
	formatBytes,
	generateId,
	heavyNoteDefinition,
	makeHeavyRow,
	measureTime,
	noteDefinition,
	postDefinition,
} from './helpers.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Cold Start: Load from Binary
// ═══════════════════════════════════════════════════════════════════════════════

describe('cold start: load from binary', () => {
	for (const count of [1_000, 10_000, 50_000]) {
		test(`load ${count.toLocaleString()} small rows from binary`, () => {
			// Build source doc
			const sourceDoc = new Y.Doc();
			const tables = { posts: attachTable(sourceDoc, 'posts', postDefinition) };
			for (let i = 0; i < count; i++) {
				tables.posts.set({
					id: generateId(i),
					title: `Post ${i}`,
					views: i,
				});
			}
			const binary = Y.encodeStateAsUpdate(sourceDoc);

			// Measure deserialization
			const { durationMs } = measureTime(() => {
				const freshDoc = new Y.Doc();
				Y.applyUpdate(freshDoc, binary);
			});

			console.log(
				`Load ${count.toLocaleString()} small rows: ${durationMs.toFixed(2)}ms (${formatBytes(binary.byteLength)} binary)`,
			);
		}, 120_000);
	}

	test('load 1,000 notes with 500 chars each', () => {
		const sourceDoc = new Y.Doc();
		const tables = { notes: attachTable(sourceDoc, 'notes', noteDefinition) };
		const content = 'x'.repeat(400);
		for (let i = 0; i < 1_000; i++) {
			tables.notes.set({
				id: generateId(i),
				title: `Note ${i}`,
				content,
				tags: ['tag1'],
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		}
		const binary = Y.encodeStateAsUpdate(sourceDoc);

		const { durationMs } = measureTime(() => {
			const freshDoc = new Y.Doc();
			Y.applyUpdate(freshDoc, binary);
		});

		console.log(
			`Load 1,000 notes: ${durationMs.toFixed(2)}ms (${formatBytes(binary.byteLength)} binary)`,
		);
	});

	test('load 5 heavy docs (50K chars each)', () => {
		const sourceDoc = new Y.Doc();
		const tables = {
			notes: attachTable(sourceDoc, 'notes', heavyNoteDefinition),
		};
		for (let i = 0; i < 5; i++) {
			tables.notes.set(makeHeavyRow(`doc-${i}`, 50_000));
		}
		const binary = Y.encodeStateAsUpdate(sourceDoc);

		const { durationMs } = measureTime(() => {
			const freshDoc = new Y.Doc();
			Y.applyUpdate(freshDoc, binary);
		});

		console.log(
			`Load 5 × 50K-char docs: ${durationMs.toFixed(2)}ms (${formatBytes(binary.byteLength)} binary)`,
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
// Snapshot Encoding (Save to Disk)
// ═══════════════════════════════════════════════════════════════════════════════

describe('snapshot encoding time', () => {
	for (const count of [1_000, 10_000, 50_000]) {
		test(`encode ${count.toLocaleString()} small rows to binary`, () => {
			const ydoc = new Y.Doc();
			const tables = { posts: attachTable(ydoc, 'posts', postDefinition) };
			for (let i = 0; i < count; i++) {
				tables.posts.set({
					id: generateId(i),
					title: `Post ${i}`,
					views: i,
				});
			}

			const { result: binary, durationMs } = measureTime(() =>
				Y.encodeStateAsUpdate(ydoc),
			);

			console.log(
				`Encode ${count.toLocaleString()} rows: ${durationMs.toFixed(2)}ms → ${formatBytes(binary.byteLength)}`,
			);
		}, 120_000);
	}
});

// ═══════════════════════════════════════════════════════════════════════════════
// Incremental Updates: How Big Are They?
// ═══════════════════════════════════════════════════════════════════════════════

describe('incremental update size', () => {
	test('single row edit: delta vs full snapshot', () => {
		const ydoc = new Y.Doc();
		const tables = { posts: attachTable(ydoc, 'posts', postDefinition) };

		// Insert 1000 rows
		for (let i = 0; i < 1_000; i++) {
			tables.posts.set({
				id: generateId(i),
				title: `Post ${i}`,
				views: i,
			});
		}

		const fullSnapshot = Y.encodeStateAsUpdate(ydoc).byteLength;
		const stateVector = Y.encodeStateVector(ydoc);

		// Make one edit
		tables.posts.set({
			id: generateId(0),
			title: 'Updated Post 0',
			views: 999,
		});

		// Delta = only the changes since the state vector
		const delta = Y.encodeStateAsUpdate(ydoc, stateVector).byteLength;

		console.log('\n=== Incremental Update Size ===');
		console.log(`  Full snapshot (1000 rows):  ${formatBytes(fullSnapshot)}`);
		console.log(`  Delta (1 row edit):         ${formatBytes(delta)}`);
		console.log(
			`  Ratio:                      ${((delta / fullSnapshot) * 100).toFixed(3)}% of full`,
		);

		expect(delta).toBeLessThan(fullSnapshot / 10);
	});
});
