/**
 * Gate 1 physical representation report.
 *
 * Measures the table count, SQLite bytes, and formatted implementation size of
 * the canonical-shadow control and the selected typed-only client.
 */

import type { Database } from 'bun:sqlite';
import { test } from 'bun:test';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { GateHarness } from '../harness';
import type { Operation } from '../protocol';

const note = (rowId: string, title: string, pinned: boolean): Operation => ({
	kind: 'patchRow',
	table: 'notes',
	rowId,
	cells: { title, pinned },
});

function tableCount(db: Database): number {
	const row = db
		.query<{ count: number }, []>(
			"SELECT count(*) count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
		)
		.get();
	if (!row) throw new Error('failed to count tables');
	return row.count;
}

test('reports both client representations after the same workload', () => {
	const harness = new GateHarness();
	try {
		for (let index = 0; index < 50; index += 1)
			harness.local(0, [note(`n${index}`, `Note ${index}`, index % 2 === 0)]);
		harness.drain();
		for (const replica of harness.replicas) {
			replica.a.db.run('PRAGMA wal_checkpoint(TRUNCATE)');
			replica.b.db.run('PRAGMA wal_checkpoint(TRUNCATE)');
		}
		const gatesRoot = join(import.meta.dir, '..');
		console.log(
			`GATE1_METRICS ${JSON.stringify({
				candidateA: {
					tables: tableCount(harness.replicas[0].a.db),
					bytes: statSync(join(harness.directory, 'a-0.sqlite')).size,
					lines: readFileSync(
						join(gatesRoot, 'engine-client-a.ts'),
						'utf8',
					).split('\n').length,
				},
				candidateB: {
					tables: tableCount(harness.replicas[0].b.db),
					bytes: statSync(join(harness.directory, 'b-0.sqlite')).size,
					lines: readFileSync(
						join(gatesRoot, 'engine-client-b.ts'),
						'utf8',
					).split('\n').length,
				},
			})}`,
		);
	} finally {
		harness.close();
	}
});
