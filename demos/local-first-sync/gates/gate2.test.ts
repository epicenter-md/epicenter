/**
 * Gate 2 snapshot and compaction tests.
 *
 * Proves that one immutable current-head logical snapshot can replace an
 * accepted mutation prefix without losing pending intent or resurrecting
 * physically deleted rows.
 *
 * Key behaviors:
 * - snapshot chunks stage idempotently and install atomically;
 * - frozen actor high-waters prune accepted, but not unaccepted, outbox rows;
 * - snapshots carry live rows only: deletion survives compaction as absence;
 * - replacement, corruption, crashes, and writes during bootstrap are safe.
 */

import { expect, test } from 'bun:test';
import { GateHarness } from './harness';
import { type Cells, ENVELOPE, type Operation, rowKey } from './protocol';
import { Prng } from './util';

const create = (rowId: string, title: string, pinned = false): Operation => ({
	kind: 'createRow',
	table: 'notes',
	rowId,
	cells: { title, pinned },
});
const update = (rowId: string, cells: Cells): Operation => ({
	kind: 'updateRow',
	table: 'notes',
	rowId,
	cells,
});
const del = (rowId: string): Operation => ({
	kind: 'deleteRow',
	table: 'notes',
	rowId,
});

function setup() {
	return { harness: new GateHarness() };
}

function seedRows(harness: GateHarness, count = 5): void {
	for (let index = 0; index < count; index += 1)
		harness.local(0, [create(`n${index}`, `Note ${index}`, index % 2 === 0)]);
	harness.push(0);
}

test('new stale replica installs multiple chunks while writes continue', () => {
	const { harness } = setup();
	try {
		seedRows(harness);
		const manifest = harness.publishSnapshot(2);
		expect(manifest.chunkChecksums).toHaveLength(3);
		expect(harness.refServer.dump().log).toHaveLength(0);

		const bootstrap = harness.snapshotRequired(2);
		expect(bootstrap).toEqual(manifest);
		expect(harness.beginSnapshot(2, manifest)).toEqual({ ok: true });

		// Fetch without staging simulates response loss. Staging twice proves
		// duplicate delivery is idempotent.
		const first = harness.snapshotChunk(manifest, 0);
		harness.snapshotChunk(manifest, 0);
		expect(harness.stageSnapshotChunk(2, first)).toEqual({ ok: true });
		expect(harness.stageSnapshotChunk(2, first)).toEqual({ ok: true });

		harness.local(1, [create('tail', 'accepted after snapshot')]);
		harness.push(1);
		for (let index = 1; index < manifest.chunkChecksums.length; index += 1)
			expect(
				harness.stageSnapshotChunk(2, harness.snapshotChunk(manifest, index)),
			).toEqual({ ok: true });
		expect(harness.installSnapshot(2)).toEqual({ ok: true });
		expect(harness.replicas[2].b.dump().pullCursor).toBe(
			manifest.snapshotSequence,
		);
		harness.pull(2);
		expect(
			harness.replicas[2].b.dump().rows[rowKey('notes', 'tail')],
		).toBeDefined();
	} finally {
		harness.close();
	}
});

test('snapshot high-water prunes accepted pending mutation and preserves unaccepted mutation', () => {
	const { harness } = setup();
	try {
		harness.local(0, [create('accepted', 'accepted but not echoed')]);
		const acceptedRequest = structuredClone(
			harness.replicas[0].a.pushRequest(),
		);
		harness.push(0);
		harness.local(0, [create('pending', 'never pushed')]);
		expect(harness.replicas[0].b.dump().outbox).toHaveLength(2);

		const manifest = harness.publishSnapshot(10);
		expect(manifest.actorHighWater['actor-1']).toBe(1);
		expect(harness.refServer.dump().actorHighWater['actor-1']).toBe(1);
		expect(harness.refServer.dump().log).toHaveLength(0);
		// A stale retry of the already-accepted createRow after compaction is
		// absorbed by sequence dedup, never by a create-conflict refusal.
		expect(harness.refServer.push(acceptedRequest)).toEqual(
			harness.sqlServer.push(acceptedRequest),
		);
		expect(harness.refServer.push(acceptedRequest)).toEqual({
			kind: 'push',
			ok: true,
		});
		expect(harness.refServer.dump().log).toHaveLength(0);

		harness.bootstrapSnapshot(0, harness.snapshotRequired(0));
		const dump = harness.replicas[0].b.dump();
		expect(dump.outbox.map(({ actorSequence }) => actorSequence)).toEqual([2]);
		expect(dump.rows[rowKey('notes', 'accepted')]).toBeDefined();
		expect(dump.rows[rowKey('notes', 'pending')]).toBeDefined();

		harness.push(0);
		harness.drain();
	} finally {
		harness.close();
	}
});

test('snapshot install rolls back on crash and survives reopen after commit', () => {
	const { harness } = setup();
	try {
		seedRows(harness, 3);
		const manifest = harness.publishSnapshot(1);
		harness.beginSnapshot(1, manifest);
		for (let index = 0; index < manifest.chunkChecksums.length; index += 1)
			harness.stageSnapshotChunk(1, harness.snapshotChunk(manifest, index));

		const before = harness.replicas[1].b.dump();
		harness.crashDuringSnapshotInstall(1);
		expect(harness.replicas[1].b.dump()).toEqual(before);
		expect(harness.installSnapshot(1)).toEqual({ ok: true });
		harness.reopen(1);
		expect(harness.replicas[1].b.dump().pullCursor).toBe(
			manifest.snapshotSequence,
		);
		expect(Object.keys(harness.replicas[1].b.dump().rows)).toHaveLength(3);
	} finally {
		harness.close();
	}
});

test('abandoned snapshot restarts against the only published replacement', () => {
	const { harness } = setup();
	try {
		seedRows(harness, 3);
		const first = harness.publishSnapshot(1);
		harness.beginSnapshot(2, first);
		harness.stageSnapshotChunk(2, harness.snapshotChunk(first, 0));

		harness.local(0, [create('new-head', 'new generation')]);
		harness.push(0);
		harness.crashDuringSnapshotPublication(2);
		expect(harness.refServer.dump().manifest).toEqual(first);
		expect(harness.refServer.dump().log).toHaveLength(1);
		const replacement = harness.publishSnapshot(2);
		expect(replacement.generation).toBe(first.generation + 1);
		const oldRequest = {
			kind: 'snapshotChunk' as const,
			...ENVELOPE,
			generation: first.generation,
			index: 1,
		};
		expect(harness.sqlServer.snapshotChunk(oldRequest)).toEqual({
			kind: 'snapshotChunk',
			ok: false,
			reason: 'snapshot-replaced',
		});
		expect(harness.refServer.snapshotChunk(oldRequest)).toEqual({
			kind: 'snapshotChunk',
			ok: false,
			reason: 'snapshot-replaced',
		});

		harness.bootstrapSnapshot(2, harness.snapshotRequired(2));
		expect(
			harness.replicas[2].b.dump().rows[rowKey('notes', 'new-head')],
		).toBeDefined();
		expect(harness.beginSnapshot(2, first)).toEqual({
			ok: false,
			reason: 'stale-snapshot',
		});
	} finally {
		harness.close();
	}
});

test('snapshot reclassifies quarantine and a later completing patch promotes it', () => {
	const { harness } = setup();
	try {
		harness.local(0, [
			{
				kind: 'createRow',
				table: 'notes',
				rowId: 'partial',
				cells: { title: 'Partial' },
			},
		]);
		harness.push(0);
		const manifest = harness.publishSnapshot(1);
		harness.bootstrapSnapshot(2, harness.snapshotRequired(2));
		expect(
			harness.replicas[2].b.dump().quarantine[rowKey('notes', 'partial')],
		).toBeDefined();

		harness.local(1, [update('partial', { pinned: true })]);
		harness.push(1);
		harness.pull(2);
		expect(
			harness.replicas[2].b.dump().rows[rowKey('notes', 'partial')],
		).toBeDefined();
		expect(harness.replicas[2].b.dump().pullCursor).toBeGreaterThan(
			manifest.snapshotSequence,
		);
	} finally {
		harness.close();
	}
});

test('repeated current-head compaction schedules converge', () => {
	for (let seed = 1; seed <= 8; seed += 1) {
		const { harness } = setup();
		try {
			const random = new Prng(seed);
			const created: string[] = [];
			let counter = 0;
			for (let round = 0; round < 8; round += 1) {
				for (let write = 0; write < 4; write += 1) {
					const replica = random.int(3);
					const roll = random.int(5);
					if (roll === 0 && created.length > 0)
						harness.local(replica, [del(created[random.int(created.length)])]);
					else if (roll === 1 && created.length > 0)
						harness.local(replica, [
							update(created[random.int(created.length)], {
								title: `seed-${seed}-${round}-${write}`,
							}),
						]);
					else {
						const rowId = `s${seed}-${counter}`;
						counter += 1;
						created.push(rowId);
						harness.local(replica, [
							create(rowId, `seed-${seed}-${round}-${write}`),
						]);
					}
					if (random.int(2) === 0) harness.push(replica);
				}
				harness.publishSnapshot(random.int(3) + 1);
				harness.drain();
			}
		} finally {
			harness.close();
		}
	}
});

test('corrupt manifest or chunk refuses installation without changing visible state', () => {
	const { harness } = setup();
	try {
		seedRows(harness, 2);
		const manifest = harness.publishSnapshot(1);
		const before = harness.replicas[2].b.dump();
		const corruptManifest = structuredClone(manifest);
		corruptManifest.snapshotSequence += 1;
		expect(harness.beginSnapshot(2, corruptManifest)).toEqual({
			ok: false,
			reason: 'invalid-manifest',
		});
		expect(harness.replicas[2].b.dump()).toEqual(before);

		harness.beginSnapshot(2, manifest);
		expect(harness.installSnapshot(2)).toEqual({
			ok: false,
			reason: 'incomplete-snapshot',
		});
		const corruptChunk = structuredClone(harness.snapshotChunk(manifest, 0));
		corruptChunk.rows.push({
			table: 'notes',
			rowId: 'injected',
			cells: { title: 'corrupt', pinned: false },
		});
		expect(harness.stageSnapshotChunk(2, corruptChunk)).toEqual({
			ok: false,
			reason: 'invalid-chunk',
		});
		expect(harness.replicas[2].b.dump()).toEqual(before);

		for (let index = 0; index < manifest.chunkChecksums.length; index += 1)
			harness.stageSnapshotChunk(2, harness.snapshotChunk(manifest, index));
		const first = harness.snapshotChunk(manifest, 0);
		for (const client of [harness.replicas[2].a, harness.replicas[2].b])
			client.db.run(
				"UPDATE snapshot_stage SET rows_json = 'not-json' WHERE chunk_index = 0",
			);
		expect(harness.replicas[2].a.installSnapshot()).toEqual({
			ok: false,
			reason: 'invalid-chunk',
		});
		expect(harness.replicas[2].b.installSnapshot()).toEqual({
			ok: false,
			reason: 'invalid-chunk',
		});
		expect(harness.replicas[2].b.dump()).toEqual(before);
		for (const client of [harness.replicas[2].a, harness.replicas[2].b])
			client.db.run(
				'UPDATE snapshot_stage SET rows_json = ? WHERE chunk_index = 0',
				[JSON.stringify(first.rows)],
			);
		expect(harness.installSnapshot(2)).toEqual({ ok: true });
	} finally {
		harness.close();
	}
});

test('row deleted before compaction is absent from the snapshot and cannot resurrect', () => {
	const { harness } = setup();
	try {
		harness.local(0, [create('gone', 'created')]);
		harness.push(0);
		harness.pull(2);
		// The stale replica edits the row it can still see, then goes offline.
		harness.local(2, [update('gone', { title: 'stale pending' })]);
		harness.local(0, [del('gone')]);
		harness.push(0);
		const manifest = harness.publishSnapshot(1);
		// The snapshot carries live rows only: the deleted row is simply absent.
		const chunkRows = harness.refServer
			.dump()
			.chunks.flatMap((chunk) => chunk.rows);
		expect(chunkRows.some((row) => row.rowId === 'gone')).toBeFalse();
		expect(harness.refServer.dump().log).toHaveLength(0);
		// The actor high-water survives the permanent log deletion.
		expect(manifest.actorHighWater['actor-1']).toBe(2);
		expect(harness.sqlServer.dump().actorHighWater['actor-1']).toBe(2);

		harness.bootstrapSnapshot(2, harness.snapshotRequired(2));
		const dump = harness.replicas[2].b.dump();
		expect(dump.rows[rowKey('notes', 'gone')]).toBeUndefined();
		expect(dump.quarantine[rowKey('notes', 'gone')]).toBeUndefined();
		// The never-accepted pending update survives bootstrap and replays as a
		// local no-op instead of resurrecting the row.
		expect(dump.outbox).toHaveLength(1);

		harness.push(2); // accepted deterministic no-op on the server fold
		harness.drain();
		expect(
			harness.refServer.dump().canonical[rowKey('notes', 'gone')],
		).toBeUndefined();
		for (const replica of harness.replicas) {
			expect(replica.b.dump().rows[rowKey('notes', 'gone')]).toBeUndefined();
			expect(replica.b.dump().outbox).toHaveLength(0);
		}
		expect(harness.refServer.dump().watermark).toBe(manifest.snapshotSequence);
	} finally {
		harness.close();
	}
});
