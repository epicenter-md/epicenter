/**
 * Tombstone Analysis Benchmarks
 *
 * Answers: "Do deletions leave residue? How much space do tombstones consume?"
 *
 * Measures binary size after delete-then-add cycles at various content sizes
 * (10K, 50K, 100K chars per row) to quantify tombstone overhead.
 */

import { describe, test } from 'bun:test';
import * as Y from 'yjs';
import { attachTable } from '../document/table.js';
import { formatBytes, heavyNoteDefinition, makeHeavyRow } from './helpers.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Tombstone Residue After Delete + Replace
// ═══════════════════════════════════════════════════════════════════════════════

describe('tombstone residue after delete + replace', () => {
	for (const contentChars of [10_000, 50_000, 100_000]) {
		test(`${formatBytes(contentChars)}/row: delete 2 of 5, add 2 new`, () => {
			const ydoc = new Y.Doc();
			const tables = { notes: attachTable(ydoc, 'notes', heavyNoteDefinition) };

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

			const label = formatBytes(contentChars).toUpperCase();
			console.log(`\n=== TOMBSTONE ANALYSIS: ${label}/ROW ===`);
			console.log(`  Step 1: 5 rows:               ${formatBytes(sizeWith5)}`);
			console.log(
				`  Step 2: delete 2 (3 remain):  ${formatBytes(sizeAfterDelete)}`,
			);
			console.log(
				`    Size freed:                  ${formatBytes(sizeWith5 - sizeAfterDelete)}`,
			);
			console.log(
				`  Step 3: add 2 new (5 total):  ${formatBytes(sizeAfterReplace)}`,
			);
			const delta = sizeAfterReplace - sizeWith5;
			const pct = ((sizeAfterReplace / sizeWith5 - 1) * 100).toFixed(2);
			console.log(
				`    vs original 5 rows:          ${delta > 0 ? '+' : ''}${formatBytes(delta)} (${pct}%)`,
			);
			const verdict =
				sizeAfterReplace <= sizeWith5 * 1.01
					? 'MINIMAL ✓'
					: sizeAfterReplace <= sizeWith5 * 1.05
						? 'SMALL ✓'
						: 'NOTICEABLE ⚠';
			console.log(`  Verdict: Tombstones are ${verdict}`);
		});
	}
});
