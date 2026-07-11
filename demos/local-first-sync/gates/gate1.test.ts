/**
 * Gate 1 pending-visibility and physical-client-shape tests.
 *
 * Compares a pure model with two independent SQLite client representations and
 * a SQLite server after every local, push, pull, retry, crash, and reopen event.
 *
 * Key behaviors:
 * - pending intent remains visible until an exact ordered echo or snapshot;
 * - terminal deletion and quarantine are deterministic across replicas;
 * - Candidate B converges without a canonical client shadow.
 */

import { describe, expect, test } from 'bun:test';
import { type Event, GateHarness, minimize } from './harness';
import { ENVELOPE, type Operation, rowKey } from './protocol';
import { Prng, stableJson } from './util';

const note = (rowId: string, title: string, pinned = false): Operation => ({
	kind: 'patchRow',
	table: 'notes',
	rowId,
	cells: { title, pinned },
});
const patchTitle = (rowId: string, title: string): Operation => ({
	kind: 'patchRow',
	table: 'notes',
	rowId,
	cells: { title },
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
			h.local(0, [note('n1', 'pending')]);
			h.local(1, [note('n1', 'remote-before')]);
			h.push(1);
			h.pull(0);
			expect(
				h.replicas[0].b.dump().rows[rowKey('notes', 'n1')].cells.title,
			).toBe('pending');
			h.push(0); // successful response is deliberately ignored: only echo prunes.
			expect(h.replicas[0].b.dump().outbox).toHaveLength(1);
			h.pull(0, 1);
			h.duplicatePull(0);
			h.pull(0, 1);
			expect(h.replicas[0].b.dump().outbox).toHaveLength(0);
			h.local(1, [patchTitle('n1', 'remote-after')]);
			h.push(1);
			h.pull(0);
			expect(
				h.replicas[0].b.dump().rows[rowKey('notes', 'n1')].cells.title,
			).toBe('remote-after');
		}));

	test('partial rows quarantine, promote, accept patches, and terminally delete', () =>
		withHarness((h) => {
			h.local(1, [patchTitle('partial', 'needs pinned')]);
			h.push(1);
			h.pull(0);
			expect(
				h.replicas[0].b.dump().quarantine[rowKey('notes', 'partial')],
			).toBeDefined();
			h.local(1, [
				{
					kind: 'patchRow',
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
			h.local(0, [patchTitle('partial', 'pending overlay')]);
			h.reopen(0);
			h.push(0);
			h.local(2, [{ kind: 'deleteRow', table: 'notes', rowId: 'partial' }]);
			h.push(2);
			h.pull(0, 100);
			h.local(1, [patchTitle('partial', 'late resurrection')]);
			h.push(1);

			// Pending replay and reopen while the accepted base is quarantined.
			h.local(1, [patchTitle('quarantined', 'partial')]);
			h.push(1);
			h.pull(0);
			h.local(0, [
				{
					kind: 'patchRow',
					table: 'notes',
					rowId: 'quarantined',
					cells: { pinned: true },
				},
			]);
			h.reopen(0);
			expect(
				h.replicas[0].b.dump().rows[rowKey('notes', 'quarantined')],
			).toBeDefined();
			h.local(2, [{ kind: 'deleteRow', table: 'notes', rowId: 'quarantined' }]);
			h.push(2);
			h.drain();
			for (const replica of h.replicas)
				expect(replica.b.dump().tombstones).toContain(
					rowKey('notes', 'partial'),
				);
			for (const replica of h.replicas)
				expect(replica.b.dump().tombstones).toContain(
					rowKey('notes', 'quarantined'),
				);
		}));

	test('reordered pull pages cannot advance a noncontiguous cursor', () =>
		withHarness((h) => {
			h.local(1, [note('n1', 'first')]);
			h.push(1);
			h.local(1, [patchTitle('n1', 'second')]);
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
			expect(
				h.replicas[0].b.dump().rows[rowKey('notes', 'n1')].cells.title,
			).toBe('second');
		}));

	test('multi-row mutation and crash boundaries are atomic', () =>
		withHarness((h) => {
			const atomic: Operation[] = [
				note('n1', 'one'),
				note('n2', 'two', true),
				{
					kind: 'patchRow',
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
			h.local(1, [note('n1', 'server')]);
			h.push(1);
			const generation = h.replicas[0].generation;
			const response = h.refServer.pull(h.replicas[0].ref.pullRequest());
			h.reopen(0);
			expect(h.applyCaptured(0, generation, response)).toBeFalse();
			expect(h.replicas[0].b.dump().pullCursor).toBe(0);
		}));

	test('server deduplicates actor sequences and rejects gaps and wrong identities', () =>
		withHarness((h) => {
			const mutation = {
				actorId: 'manual',
				actorSequence: 1,
				operations: [note('n1', 'one')],
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
			const wrongEpoch = {
				...request,
				schemaEpochId: 'other',
			};
			expect(h.refServer.push(wrongEpoch).ok).toBeFalse();
			expect(h.sqlServer.push(wrongEpoch).ok).toBeFalse();
		}));
});

function generated(seed: number, count: number): Event[] {
	const random = new Prng(seed);
	const events: Event[] = [];
	for (let index = 0; index < count; index += 1) {
		const replica = random.int(3);
		const choice = random.int(6);
		const id = `n${random.int(5)}`;
		if (choice === 0)
			events.push({
				kind: 'local',
				replica,
				operations: [note(id, `s${seed}-${index}`, random.int(2) === 1)],
			});
		else if (choice === 1)
			events.push({
				kind: 'local',
				replica,
				operations: [patchTitle(id, `p${seed}-${index}`)],
			});
		else if (choice === 2)
			events.push({
				kind: 'local',
				replica,
				operations: [{ kind: 'deleteRow', table: 'notes', rowId: id }],
			});
		else if (choice === 3)
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
