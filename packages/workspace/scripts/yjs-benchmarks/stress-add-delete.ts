/**
 * Stress test for the Workspace API.
 *
 * Simulates an event/command log table: adds N events, deletes them all,
 * repeats for several cycles, then measures the final Y.Doc binary size
 * and writes it to disk as a .yjs file.
 *
 * Run: bun packages/workspace/scripts/yjs-benchmarks/stress-add-delete.ts
 */

import { unlinkSync } from 'node:fs';
import * as Y from 'yjs';
import { createWorkspace, defineTable } from '../../src/index.js';
import { field } from '@epicenter/field';
import { formatBytes, measureTime } from './helpers.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Config — tweak these
// ═══════════════════════════════════════════════════════════════════════════════

const EVENTS_PER_CYCLE = 10_000;
const CYCLES = 5;
const OUTPUT_PATH = './stress-test-output.yjs';

// ═══════════════════════════════════════════════════════════════════════════════
// Schema — simulates a command/event log
// ═══════════════════════════════════════════════════════════════════════════════

const eventDefinition = defineTable({
	id: field.string(),
	type: field.select(['command', 'event']),
	name: field.string(),
	payload: field.string(),
	timestamp: field.number(),
});

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════════

function generateId(index: number): string {
	return `evt-${index.toString().padStart(6, '0')}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
	const workspace = createWorkspace({
		id: 'stress-add-delete',
		tables: { events: eventDefinition },
		kv: {},
	});
	const { ydoc, tables } = workspace;

	console.log(`\n=== Static API Stress Test ===`);
	console.log(`Events per cycle: ${EVENTS_PER_CYCLE.toLocaleString()}`);
	console.log(`Cycles: ${CYCLES}`);
	console.log();

	// ── Baseline: empty doc ──────────────────────────────────────────────
	const emptySize = Y.encodeStateAsUpdate(ydoc).byteLength;
	console.log(`Empty Y.Doc size: ${formatBytes(emptySize)}`);
	console.log();

	// ── Run cycles ───────────────────────────────────────────────────────
	const samplePayload = JSON.stringify({
		userId: 'usr-001',
		action: 'click',
		target: 'button.submit',
		metadata: { page: '/dashboard', sessionId: 'sess-abc123' },
	});

	for (let cycle = 0; cycle < CYCLES; cycle++) {
		// Add events
		const { ms: addMs } = measureTime(() => {
			for (let i = 0; i < EVENTS_PER_CYCLE; i++) {
				tables.events.set({
					id: generateId(i),
					type: i % 2 === 0 ? 'command' : 'event',
					name: `action_${i}`,
					payload: samplePayload,
					timestamp: Date.now(),
				});
			}
		});

		const afterAddSize = Y.encodeStateAsUpdate(ydoc).byteLength;
		const rowCount = tables.events.count();

		// Delete all events
		const { ms: deleteMs } = measureTime(() => {
			for (let i = 0; i < EVENTS_PER_CYCLE; i++) {
				tables.events.delete(generateId(i));
			}
		});

		const afterDeleteSize = Y.encodeStateAsUpdate(ydoc).byteLength;
		const rowCountAfterDelete = tables.events.count();

		console.log(`── Cycle ${cycle + 1}/${CYCLES} ──`);
		console.log(
			`  Add ${EVENTS_PER_CYCLE.toLocaleString()} events: ${addMs.toFixed(1)}ms`,
		);
		console.log(
			`  After add:    ${formatBytes(afterAddSize)} (${rowCount} rows)`,
		);
		console.log(`  Delete all:   ${deleteMs.toFixed(1)}ms`);
		console.log(
			`  After delete: ${formatBytes(afterDeleteSize)} (${rowCountAfterDelete} rows)`,
		);
		console.log();
	}

	// ── Final stats ──────────────────────────────────────────────────────
	const finalUpdate = Y.encodeStateAsUpdate(ydoc);
	const finalStateVector = Y.encodeStateVector(ydoc);

	console.log(`=== Final Results ===`);
	console.log(`Rows remaining: ${tables.events.count()}`);
	console.log(`State update size: ${formatBytes(finalUpdate.byteLength)}`);
	console.log(`State vector size: ${formatBytes(finalStateVector.byteLength)}`);
	console.log(
		`Total operations: ${(EVENTS_PER_CYCLE * CYCLES * 2).toLocaleString()} (${EVENTS_PER_CYCLE * CYCLES} adds + ${EVENTS_PER_CYCLE * CYCLES} deletes)`,
	);
	console.log();

	// ── Write .yjs file ──────────────────────────────────────────────────
	await Bun.write(OUTPUT_PATH, finalUpdate);
	const file = Bun.file(OUTPUT_PATH);
	console.log(`Written to: ${OUTPUT_PATH}`);
	console.log(`File size on disk: ${formatBytes(file.size)}`);

	// ── Bonus: what does a fresh doc from this snapshot look like? ──────
	const workspace2 = createWorkspace({
		id: 'stress-add-delete-reload',
		tables: { events: eventDefinition },
		kv: {},
	});
	Y.applyUpdate(workspace2.ydoc, finalUpdate);
	const { ydoc: ydoc2, tables: tables2 } = workspace2;
	console.log(`\n=== Snapshot Verification ===`);
	console.log(`Rows after loading snapshot: ${tables2.events.count()}`);

	// Re-encode and compare
	const reEncoded = Y.encodeStateAsUpdate(ydoc2);
	console.log(`Re-encoded size: ${formatBytes(reEncoded.byteLength)}`);
	console.log(
		`Size reduction from re-encode: ${((1 - reEncoded.byteLength / finalUpdate.byteLength) * 100).toFixed(1)}%`,
	);

	ydoc.destroy();
	ydoc2.destroy();

	// Cleanup output file
	unlinkSync(OUTPUT_PATH);
	console.log(`\nCleaned up ${OUTPUT_PATH}`);
}

main();
