/**
 * Production-shape canonical record-map scale gate.
 *
 * Run:
 *   bun test packages/workspace/src/__benchmarks__/canonical-record-map.bench.ts --timeout 300000
 *
 * The fixture writes one million schema-opaque JSON rows into the private
 * canonical SQLite map, then reads every row through bounded release-local
 * lens pages. It proves bounded JavaScript heap, point reads, and a TEMP VIEW
 * aggregate without introducing a materialized projection or migration path.
 */

import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { field } from '@epicenter/field';
import { createBunSqliteAdapter } from '@epicenter/row-sync/bun';
import { Type } from 'typebox';
import { createCanonicalRecords } from '../sqlite/canonical-records.js';
import { defineTable } from '../sqlite/lens-definition.js';

const ROWS = 1_000_000;
const PAGE_SIZE = 1_000;

test('one million canonical JSON rows scan with bounded heap', () => {
	const directory = mkdtempSync(join(tmpdir(), 'epicenter-canonical-map-'));
	const path = join(directory, 'records.sqlite3');
	const database = new Database(path, { create: true });
	try {
		database.exec(`
			PRAGMA journal_mode = WAL;
			PRAGMA synchronous = NORMAL;
		`);
		const records = createCanonicalRecords(createBunSqliteAdapter(database), {
			notes: defineTable({
				fields: {
					title: field.string(),
					archived: field.boolean(),
				},
			}),
		});
		const insert = database.query(
			`INSERT INTO "__epicenter_records"("table_key", "row_id", "payload")
			 VALUES ('notes', ?, ?)`,
		);
		const writeStartedAt = performance.now();
		database.transaction(() => {
			for (let index = 0; index < ROWS; index += 1) {
				insert.run(
					noteId(index),
					JSON.stringify({
						title: `Note ${index}`,
						archived: index % 7 === 0,
						futureKey: index % 13,
					}),
				);
			}
		})();
		const writeMs = performance.now() - writeStartedAt;
		forceGc();
		const baselineHeapBytes = process.memoryUsage().heapUsed;
		let peakHeapBytes = baselineHeapBytes;

		const scanStartedAt = performance.now();
		let cursor: string | undefined;
		let scanned = 0;
		do {
			const page = records.tables.notes.scan({
				cursor,
				limit: PAGE_SIZE,
			});
			expect(page.nonconforming).toHaveLength(0);
			scanned += page.rows.length;
			cursor = page.nextCursor;
			peakHeapBytes = Math.max(peakHeapBytes, process.memoryUsage().heapUsed);
		} while (cursor !== undefined);
		const scanMs = performance.now() - scanStartedAt;

		const last = records.tables.notes.get(noteId(ROWS - 1));
		expect(last.error).toBeNull();
		expect(last.data?.title).toBe(`Note ${ROWS - 1}`);
		const countRow = records.sql(
			'SELECT count(*) AS count FROM notes',
			[],
			Type.Object({ count: Type.Integer() }),
		)[0];
		expect(countRow).toBeDefined();
		const count = countRow?.count;
		database.exec('PRAGMA wal_checkpoint(TRUNCATE)');

		const heapDeltaBytes = peakHeapBytes - baselineHeapBytes;
		console.log(
			JSON.stringify(
				{
					rows: ROWS,
					writeMs: Math.round(writeMs),
					scanMs: Math.round(scanMs),
					scanRowsPerSecond: Math.round((ROWS / scanMs) * 1_000),
					baselineHeapBytes,
					peakHeapBytes,
					heapDeltaBytes,
					fileBytes: statSync(path).size,
				},
				null,
				2,
			),
		);

		expect(scanned).toBe(ROWS);
		expect(count).toBe(ROWS);
		expect(heapDeltaBytes).toBeLessThan(128 * 1024 * 1024);
	} finally {
		database.close(false);
		rmSync(directory, { recursive: true, force: true });
	}
}, 300_000);

function noteId(index: number): string {
	return `note-${String(index).padStart(7, '0')}`;
}

function forceGc(): void {
	if (typeof Bun.gc === 'function') Bun.gc(true);
}
