/**
 * Gate 1 pending-visibility and physical-client-shape tests.
 *
 * Compares a pure model with two independent SQLite client representations and
 * a SQLite server after every local, push, pull, retry, crash, and reopen event.
 *
 * Key behaviors:
 * - pending intent remains visible until an exact ordered echo or snapshot;
 * - deletion is physical and delayed edits fold to accepted no-ops;
 * - a duplicate createRow is refused before acceptance and is a fatal replica
 *   corruption signal after acceptance;
 * - Candidate B converges without a canonical client shadow.
 */

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { SqliteClientA } from './engine-client-a';
import { SqliteClientB } from './engine-client-b';
import { type Event, GateHarness, minimize } from './harness';
import {
	ENVELOPE,
	type Operation,
	type PullResponse,
	rowKey,
} from './protocol';
import { RefClient } from './reference';
import { Prng, stableJson } from './util';

const create = (rowId: string, title: string, pinned = false): Operation => ({
	kind: 'createRow',
	table: 'notes',
	rowId,
	cells: { title, pinned },
});
const updateTitle = (rowId: string, title: string): Operation => ({
	kind: 'updateRow',
	table: 'notes',
	rowId,
	cells: { title },
});
const del = (rowId: string): Operation => ({
	kind: 'deleteRow',
	table: 'notes',
	rowId,
});

function withHarness(run: (harness: GateHarness) => void): void {
	const harness = new GateHarness();
	try {
		run(harness);
	} finally {
		harness.close();
	}
}

describe('Gate 1 directed traces', () => {
	test('internal comparison keys cannot collide for arbitrary identifiers', () => {
		expect(rowKey('a', '\u0000b')).not.toBe(rowKey('a\u0000', 'b'));
	});

	test('pending intent survives lost ack, ack-before-echo, and both same-cell orders', () =>
		withHarness((h) => {
			h.local(1, [create('n1', 'base')]);
			h.push(1);
			h.pull(0);
			h.local(0, [updateTitle('n1', 'pending')]);
			h.local(1, [updateTitle('n1', 'remote-before')]);
			h.push(1);
			h.pull(0, 1);
			expect(h.replicas[0].b.dump().rows[rowKey('notes', 'n1')].title).toBe(
				'pending',
			);
			h.push(0); // successful response is deliberately ignored: only echo prunes.
			expect(h.replicas[0].b.dump().outbox).toHaveLength(1);
			h.pull(0, 1);
			h.duplicatePull(0);
			expect(h.replicas[0].b.dump().outbox).toHaveLength(0);
			expect(h.replicas[0].b.dump().rows[rowKey('notes', 'n1')].title).toBe(
				'pending',
			);
			h.local(1, [updateTitle('n1', 'remote-after')]);
			h.push(1);
			h.pull(0);
			expect(h.replicas[0].b.dump().rows[rowKey('notes', 'n1')].title).toBe(
				'remote-after',
			);
		}));

	test('partial creates quarantine, promote, accept updates, and delete physically', () =>
		withHarness((h) => {
			h.local(1, [
				{
					kind: 'createRow',
					table: 'notes',
					rowId: 'partial',
					cells: { title: 'needs pinned' },
				},
			]);
			h.push(1);
			h.pull(0);
			expect(
				h.replicas[0].b.dump().quarantine[rowKey('notes', 'partial')],
			).toBeDefined();
			h.local(1, [
				{
					kind: 'updateRow',
					table: 'notes',
					rowId: 'partial',
					cells: { pinned: true },
				},
			]);
			h.push(1);
			h.pull(0);
			expect(
				h.replicas[0].b.dump().rows[rowKey('notes', 'partial')],
			).toBeDefined();
			h.local(0, [updateTitle('partial', 'pending overlay')]);
			h.reopen(0);
			h.push(0);
			h.local(2, [del('partial')]);
			h.push(2);
			h.pull(0, 100);
			h.local(1, [updateTitle('partial', 'late resurrection')]);
			h.push(1);

			// Pending replay and reopen while the accepted base is quarantined.
			h.local(1, [
				{
					kind: 'createRow',
					table: 'notes',
					rowId: 'quarantined',
					cells: { title: 'partial' },
				},
			]);
			h.push(1);
			h.pull(0);
			h.local(0, [
				{
					kind: 'updateRow',
					table: 'notes',
					rowId: 'quarantined',
					cells: { pinned: true },
				},
			]);
			h.reopen(0);
			expect(
				h.replicas[0].b.dump().rows[rowKey('notes', 'quarantined')],
			).toBeDefined();
			h.local(2, [del('quarantined')]);
			h.push(2);
			h.drain();
			for (const replica of h.replicas) {
				const dump = replica.b.dump();
				for (const rowId of ['partial', 'quarantined']) {
					expect(dump.rows[rowKey('notes', rowId)]).toBeUndefined();
					expect(dump.quarantine[rowKey('notes', rowId)]).toBeUndefined();
				}
			}
			expect(
				h.refServer.dump().canonical[rowKey('notes', 'partial')],
			).toBeUndefined();
		}));

	test('physical delete racing a late update folds to an accepted no-op', () =>
		withHarness((h) => {
			h.local(0, [create('race', 'v1')]);
			h.push(0);
			h.pull(1);
			h.pull(2);
			h.local(2, [updateTitle('race', 'late')]);
			h.local(1, [del('race')]);
			h.push(1);
			h.push(2); // the delayed update is accepted, and folds to nothing.
			h.drain();
			for (const replica of h.replicas) {
				const dump = replica.b.dump();
				expect(dump.rows[rowKey('notes', 'race')]).toBeUndefined();
				expect(dump.quarantine[rowKey('notes', 'race')]).toBeUndefined();
				expect(dump.outbox).toHaveLength(0);
			}
			expect(
				h.refServer.dump().canonical[rowKey('notes', 'race')],
			).toBeUndefined();
		}));

	test('create retried after a lost acknowledgement dedups without create-conflict', () =>
		withHarness((h) => {
			h.local(0, [create('retry', 'v1')]);
			h.push(0);
			expect(h.replicas[0].b.dump().outbox).toHaveLength(1);
			const request = h.replicas[0].a.pushRequest();
			expect(h.refServer.push(structuredClone(request))).toEqual({
				kind: 'push',
				ok: true,
			});
			expect(h.sqlServer.push(structuredClone(request))).toEqual({
				kind: 'push',
				ok: true,
			});
			expect(h.refServer.dump().serverSequence).toBe(1);
			h.pull(0);
			expect(h.replicas[0].b.dump().outbox).toHaveLength(0);
			expect(
				h.replicas[0].b.dump().rows[rowKey('notes', 'retry')],
			).toBeDefined();
		}));

	test('reordered pull pages cannot advance a noncontiguous cursor', () =>
		withHarness((h) => {
			h.local(1, [create('n1', 'first')]);
			h.push(1);
			h.local(1, [updateTitle('n1', 'second')]);
			h.push(1);
			const first = h.refServer.pull(h.replicas[0].ref.pullRequest(1));
			if (!first.ok || first.snapshotRequired)
				throw new Error('unexpected snapshot or pull refusal');
			const second = h.refServer.pull({
				...h.replicas[0].ref.pullRequest(1),
				cursor: first.newCursor,
			});
			const generation = h.replicas[0].generation;
			expect(h.applyCaptured(0, generation, second)).toBeFalse();
			expect(h.applyCaptured(0, generation, first)).toBeTrue();
			expect(h.applyCaptured(0, generation, second)).toBeTrue();
			expect(h.replicas[0].b.dump().rows[rowKey('notes', 'n1')].title).toBe(
				'second',
			);
		}));

	test('multi-row mutation and crash boundaries are atomic', () =>
		withHarness((h) => {
			const atomic: Operation[] = [
				create('n1', 'one'),
				create('n2', 'two', true),
				{
					kind: 'createRow',
					table: 'folders',
					rowId: 'f1',
					cells: { name: 'Inbox' },
				},
			];
			h.crashLocalBeforeCommit(0, atomic);
			expect(h.replicas[0].b.dump().outbox).toHaveLength(0);
			h.local(0, atomic);
			h.reopen(0);
			h.crashServerDuringPush(0, 2);
			expect(h.refServer.dump().serverSequence).toBe(0);
			h.push(0);
			const response = h.refServer.pull(h.replicas[1].ref.pullRequest());
			if (!response.ok || response.snapshotRequired)
				throw new Error('unexpected snapshot or pull refusal');
			expect(response.mutations).toHaveLength(1);
			h.crashDuringPull(1, response);
			expect(h.replicas[1].b.dump().pullCursor).toBe(0);
			h.pull(1);
			expect(Object.keys(h.replicas[1].b.dump().rows)).toHaveLength(3);
		}));

	test('stale responses are fenced by the database session generation', () =>
		withHarness((h) => {
			h.local(1, [create('n1', 'server')]);
			h.push(1);
			const generation = h.replicas[0].generation;
			const response = h.refServer.pull(h.replicas[0].ref.pullRequest());
			h.reopen(0);
			expect(h.applyCaptured(0, generation, response)).toBeFalse();
			expect(h.replicas[0].b.dump().pullCursor).toBe(0);
		}));

	test('server deduplicates actor sequences and refuses gaps, wrong identities, and duplicate creates', () =>
		withHarness((h) => {
			const mutation = {
				actorId: 'manual',
				actorSequence: 1,
				operations: [create('n1', 'one')],
			};
			const request = {
				kind: 'push' as const,
				...ENVELOPE,
				mutations: [mutation],
			};
			expect(h.refServer.push(request)).toEqual(h.sqlServer.push(request));
			expect(h.refServer.push(request)).toEqual(h.sqlServer.push(request));
			const gap = {
				...request,
				mutations: [{ ...mutation, actorSequence: 3 }],
			};
			expect(h.refServer.push(gap)).toEqual({
				kind: 'push',
				ok: false,
				reason: 'actor-sequence-gap',
			});
			expect(h.sqlServer.push(gap)).toEqual({
				kind: 'push',
				ok: false,
				reason: 'actor-sequence-gap',
			});
			const wrongSchema = {
				...request,
				recordsSchemaHash: 'other',
			};
			expect(h.refServer.push(wrongSchema)).toEqual({
				kind: 'push',
				ok: false,
				reason: 'records-schema-mismatch',
			});
			expect(h.sqlServer.push(wrongSchema)).toEqual({
				kind: 'push',
				ok: false,
				reason: 'records-schema-mismatch',
			});
			const wrongEpoch = { ...request, recordsEpoch: 'other' };
			expect(h.refServer.push(wrongEpoch)).toEqual({
				kind: 'push',
				ok: false,
				reason: 'records-epoch-mismatch',
			});
			expect(h.sqlServer.push(wrongEpoch)).toEqual({
				kind: 'push',
				ok: false,
				reason: 'records-epoch-mismatch',
			});

			// A createRow naming a live identity refuses the WHOLE push: the
			// earlier fresh row in the batch never commits and the actor's
			// high-water does not advance.
			const conflict = {
				kind: 'push' as const,
				...ENVELOPE,
				mutations: [
					{
						actorId: 'evil',
						actorSequence: 1,
						operations: [create('fresh', 'smuggled')],
					},
					{
						actorId: 'evil',
						actorSequence: 2,
						operations: [create('n1', 'duplicate')],
					},
				],
			};
			const refusal = {
				kind: 'push',
				ok: false,
				reason: 'create-conflict',
			} as const;
			expect(h.refServer.push(conflict)).toEqual(refusal);
			expect(h.sqlServer.push(conflict)).toEqual(refusal);
			for (const dump of [h.refServer.dump(), h.sqlServer.dump()]) {
				expect(dump.canonical[rowKey('notes', 'fresh')]).toBeUndefined();
				expect(dump.actorHighWater.evil).toBeUndefined();
				expect(dump.serverSequence).toBe(1);
			}
		}));

	test('corrupt replica with a duplicate create is paused, then recovers by rebootstrapping', () =>
		withHarness((h) => {
			h.local(0, [create('n1', 'base')]);
			h.push(0);
			const corruptPush = (actorSequence: number, operations: Operation[]) => ({
				kind: 'push' as const,
				...ENVELOPE,
				mutations: [{ actorId: 'corrupt', actorSequence, operations }],
			});
			expect(
				h.refServer.push(corruptPush(1, [create('c1', 'honest')])),
			).toEqual({ kind: 'push', ok: true });
			expect(
				h.sqlServer.push(corruptPush(1, [create('c1', 'honest')])),
			).toEqual({ kind: 'push', ok: true });
			const batch = {
				kind: 'push' as const,
				...ENVELOPE,
				mutations: [
					{
						actorId: 'corrupt',
						actorSequence: 2,
						operations: [create('c2', 'pending intent')],
					},
					{
						actorId: 'corrupt',
						actorSequence: 3,
						operations: [create('n1', 'duplicate')],
					},
				],
			};
			const refusal = {
				kind: 'push',
				ok: false,
				reason: 'create-conflict',
			} as const;
			expect(h.refServer.push(batch)).toEqual(refusal);
			expect(h.sqlServer.push(batch)).toEqual(refusal);
			// Retrying converges to the same refusal: the actor stays paused.
			expect(h.refServer.push(batch)).toEqual(refusal);
			expect(h.sqlServer.push(batch)).toEqual(refusal);
			for (const dump of [h.refServer.dump(), h.sqlServer.dump()]) {
				expect(dump.actorHighWater.corrupt).toBe(1);
				expect(dump.canonical[rowKey('notes', 'c2')]).toBeUndefined();
			}

			// Recovery: discard replica state, bootstrap the current snapshot,
			// and continue past the frozen high-water.
			h.publishSnapshot(2);
			const ref = new RefClient('corrupt');
			const a = new SqliteClientA(
				join(h.directory, 'corrupt-a.sqlite'),
				'corrupt',
			);
			const b = new SqliteClientB(
				join(h.directory, 'corrupt-b.sqlite'),
				'corrupt',
			);
			try {
				const refPull = h.refServer.pull(ref.pullRequest());
				const sqlPull = h.sqlServer.pull(a.pullRequest());
				if (
					!refPull.ok ||
					!refPull.snapshotRequired ||
					!sqlPull.ok ||
					!sqlPull.snapshotRequired
				)
					throw new Error('expected a snapshot bootstrap');
				expect(stableJson(sqlPull.manifest)).toBe(stableJson(refPull.manifest));
				const manifest = sqlPull.manifest;
				expect(ref.beginSnapshot(manifest)).toEqual({ ok: true });
				expect(a.beginSnapshot(manifest)).toEqual({ ok: true });
				expect(b.beginSnapshot(manifest)).toEqual({ ok: true });
				for (
					let index = 0;
					index < manifest.chunkChecksums.length;
					index += 1
				) {
					const chunk = h.sqlServer.snapshotChunk({
						kind: 'snapshotChunk',
						...ENVELOPE,
						generation: manifest.generation,
						index,
					});
					if (!chunk.ok) throw new Error(`chunk missing: ${chunk.reason}`);
					expect(ref.stageSnapshotChunk(chunk.chunk)).toEqual({ ok: true });
					expect(a.stageSnapshotChunk(chunk.chunk)).toEqual({ ok: true });
					expect(b.stageSnapshotChunk(chunk.chunk)).toEqual({ ok: true });
				}
				expect(ref.installSnapshot()).toEqual({ ok: true });
				expect(a.installSnapshot()).toEqual({ ok: true });
				expect(b.installSnapshot()).toEqual({ ok: true });
				expect(stableJson(a.dump())).toBe(stableJson(ref.dump()));
				expect(stableJson(b.dump())).toBe(stableJson(ref.dump()));
				// The discarded pending c2 is gone; the sequence resumes after the
				// frozen high-water so nothing dedups silently.
				expect(ref.dump().nextActorSequence).toBe(2);
				expect(ref.dump().rows[rowKey('notes', 'n1')]).toBeDefined();
				expect(ref.dump().rows[rowKey('notes', 'c1')]).toBeDefined();
				expect(ref.dump().rows[rowKey('notes', 'c2')]).toBeUndefined();
				const continued = [create('c3', 'after recovery')];
				ref.local(continued);
				a.local(continued);
				b.local(continued);
				expect(h.refServer.push(ref.pushRequest())).toEqual({
					kind: 'push',
					ok: true,
				});
				expect(h.sqlServer.push(a.pushRequest())).toEqual({
					kind: 'push',
					ok: true,
				});
				expect(h.refServer.dump().actorHighWater.corrupt).toBe(2);
				expect(h.sqlServer.dump().actorHighWater.corrupt).toBe(2);
			} finally {
				a.close();
				b.close();
			}
		}));

	test('folding an accepted duplicate createRow is a fatal replica corruption signal', () =>
		withHarness((h) => {
			const ref = new RefClient('victim');
			const a = new SqliteClientA(
				join(h.directory, 'victim-a.sqlite'),
				'victim',
			);
			const b = new SqliteClientB(
				join(h.directory, 'victim-b.sqlite'),
				'victim',
			);
			try {
				const first: PullResponse = {
					kind: 'pull',
					ok: true,
					snapshotRequired: false,
					fromCursor: 0,
					mutations: [
						{
							serverSequence: 1,
							actorId: 'remote-1',
							actorSequence: 1,
							operations: [create('n1', 'accepted')],
						},
					],
					newCursor: 1,
					hasMore: false,
				};
				expect(ref.applyPull(first)).toBeTrue();
				expect(a.applyPull(first)).toBeTrue();
				expect(b.applyPull(first)).toBeTrue();
				const corruptEcho: PullResponse = {
					kind: 'pull',
					ok: true,
					snapshotRequired: false,
					fromCursor: 1,
					mutations: [
						{
							serverSequence: 2,
							actorId: 'remote-2',
							actorSequence: 1,
							operations: [create('n1', 'duplicate')],
						},
					],
					newCursor: 2,
					hasMore: false,
				};
				expect(() => ref.applyPull(corruptEcho)).toThrow('replica corrupt');
				expect(() => a.applyPull(corruptEcho)).toThrow('replica corrupt');
				expect(() => b.applyPull(corruptEcho)).toThrow('replica corrupt');
				// The failed transactions roll back: local data is undamaged.
				expect(stableJson(a.dump())).toBe(stableJson(ref.dump()));
				expect(stableJson(b.dump())).toBe(stableJson(ref.dump()));
			} finally {
				a.close();
				b.close();
			}
		}));
});

function generated(seed: number, count: number): Event[] {
	const random = new Prng(seed);
	const events: Event[] = [];
	const created: string[] = [];
	for (let index = 0; index < count; index += 1) {
		const replica = random.int(3);
		const choice = random.int(6);
		if (choice === 0) {
			// Honest clients mint fresh identities: created row ids never repeat.
			const rowId = `n${seed}-${index}`;
			created.push(rowId);
			events.push({
				kind: 'local',
				replica,
				operations: [create(rowId, `s${seed}-${index}`, random.int(2) === 1)],
			});
		} else if (choice === 1) {
			// A delayed update may target a row that is already deleted: it
			// folds to a deterministic no-op everywhere.
			const rowId = created[random.int(created.length)] ?? `n${seed}-${index}`;
			events.push({
				kind: 'local',
				replica,
				operations: [updateTitle(rowId, `p${seed}-${index}`)],
			});
		} else if (choice === 2) {
			const rowId = created[random.int(created.length)] ?? `n${seed}-${index}`;
			events.push({
				kind: 'local',
				replica,
				operations: [del(rowId)],
			});
		} else if (choice === 3)
			events.push({
				kind: 'push',
				replica,
				acceptLimit: random.int(3) === 0 ? 1 : undefined,
			});
		else if (choice === 4)
			events.push({ kind: 'pull', replica, limit: random.int(3) + 1 });
		else
			events.push(
				random.int(2)
					? { kind: 'duplicatePull', replica }
					: { kind: 'reopen', replica },
			);
	}
	return events;
}

function scheduleFails(events: Event[]): boolean {
	const harness = new GateHarness();
	try {
		harness.run(events);
		harness.drain();
		return false;
	} catch {
		return true;
	} finally {
		harness.close();
	}
}

test('seeded three-replica schedules converge', () => {
	for (let seed = 1; seed <= 16; seed += 1) {
		const events = generated(seed, 80);
		const harness = new GateHarness();
		try {
			harness.run(events);
			harness.drain();
		} catch (error) {
			const smallest = minimize(events, scheduleFails);
			throw new Error(
				`seed ${seed} failed\nminimal schedule: ${stableJson(smallest)}`,
				{ cause: error },
			);
		} finally {
			harness.close();
		}
	}
});

test('Candidate B removes the canonical-shadow table', () =>
	withHarness((h) => {
		const query =
			"SELECT count(*) count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'";
		const candidateA = h.replicas[0].a.db
			.query<{ count: number }, []>(query)
			.get();
		const candidateB = h.replicas[0].b.db
			.query<{ count: number }, []>(query)
			.get();
		if (!candidateA || !candidateB) throw new Error('failed to count tables');
		expect(candidateA.count - candidateB.count).toBe(1);
	}));
