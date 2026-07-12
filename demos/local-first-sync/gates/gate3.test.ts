/**
 * Gate 3 schema epoch and incarnation transition tests.
 *
 * Compares independent in-memory and SQLite authorities while schemas freeze,
 * transform, activate, expire, and receive private replica intent by import.
 *
 * Key behaviors:
 * - one exact schema identity is accepted by one active incarnation;
 * - global baselines exclude private pending overlays;
 * - the identity map carries live row identity only: deleted rows are absent
 *   from the frozen snapshot, and a stale replica's copy of an upstream
 *   deletion is review-excluded instead of silently resurrected.
 */

import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteClientB } from './engine-client-b';
import {
	planAdoption,
	planOverlayImport,
	planPhysicalCopyAdoption,
	restoreReviewRowAsNew,
	transformRows,
} from './epoch-planner';
import type { BeginTransition, EpochTransform } from './epoch-protocol';
import { RefEpochAuthority } from './epoch-reference';
import { SqliteEpochAuthority } from './epoch-sqlite';
import type {
	ClientDump,
	Mutation,
	PushRequest,
	RequestEnvelope,
	SnapshotRow,
} from './protocol';
import { splitRowKey } from './protocol';
import { createSnapshotChunk, createSnapshotManifest } from './snapshot-codec';
import { stableJson } from './util';

const epoch1: RequestEnvelope = {
	protocolMajor: 1,
	schemaEpochId: 'epoch-1',
	databaseIncarnationId: 'incarnation-1',
};

const renameNotes: EpochTransform = {
	fromEpochId: 'epoch-1',
	toEpochId: 'epoch-2',
	tables: [
		{
			sourceTable: 'notes',
			destinations: [{ table: 'articles', rowId: 'preserve' }],
			fields: { title: 'name', pinned: 'starred' },
		},
	],
};

function setup(rows: SnapshotRow[] = []) {
	const directory = mkdtempSync(join(tmpdir(), 'epicenter-gate3-'));
	const initial = { id: 'incarnation-1', epochId: 'epoch-1', rows };
	const reference = new RefEpochAuthority(initial);
	const sqlite = new SqliteEpochAuthority(
		join(directory, 'authority.sqlite'),
		initial,
	);
	return {
		directory,
		reference,
		sqlite,
		close() {
			sqlite.close();
			rmSync(directory, { recursive: true, force: true });
		},
	};
}

function compare(
	reference: RefEpochAuthority,
	sqlite: SqliteEpochAuthority,
): void {
	if (stableJson(reference.dump()) !== stableJson(sqlite.dump()))
		throw new Error(
			`epoch authority divergence\nexpected ${stableJson(reference.dump())}\nactual   ${stableJson(sqlite.dump())}`,
		);
}

function incarnation(reference: RefEpochAuthority, id: string) {
	const found = reference
		.dump()
		.incarnations.find((candidate) => candidate.id === id);
	if (!found) throw new Error(`missing incarnation: ${id}`);
	return found;
}

function buildAll(
	reference: RefEpochAuthority,
	sqlite: SqliteEpochAuthority,
	leaseId: string,
	batchSize = 1,
): void {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const expected = reference.buildTransition(leaseId, batchSize, 0);
		const actual = sqlite.buildTransition(leaseId, batchSize, 0);
		expect(actual).toEqual(expected);
		compare(reference, sqlite);
		if (expected.ok && expected.complete) return;
	}
	throw new Error('baseline did not complete');
}

function transition(overrides: Partial<BeginTransition> = {}): BeginTransition {
	return {
		targetIncarnationId: 'incarnation-2',
		leaseId: 'lease-1',
		expiresAt: 100,
		transform: renameNotes,
		...overrides,
	};
}

function pushRequest(
	envelope: RequestEnvelope,
	actorId: string,
	actorSequence: number,
	operations: Mutation['operations'],
): PushRequest {
	return {
		kind: 'push',
		...envelope,
		mutations: [{ actorId, actorSequence, operations }],
	};
}

function visibleRows(dump: ClientDump): SnapshotRow[] {
	const rows: SnapshotRow[] = [];
	for (const [key, cells] of Object.entries({
		...dump.rows,
		...dump.quarantine,
	})) {
		const [table, rowId] = splitRowKey(
			key as Parameters<typeof splitRowKey>[0],
		);
		rows.push({ table, rowId, cells });
	}
	return rows;
}

/** Model a replica that synced the canonical baseline before going private. */
function installBaseline(client: SqliteClientB, rows: SnapshotRow[]): void {
	const chunk = createSnapshotChunk(1, 0, rows);
	const manifest = createSnapshotManifest({
		generation: 1,
		snapshotSequence: 1,
		chunkChecksums: [chunk.checksum],
		actorHighWater: {},
	});
	if (!client.beginSnapshot(manifest).ok)
		throw new Error('baseline begin failed');
	if (!client.stageSnapshotChunk(chunk).ok)
		throw new Error('baseline stage failed');
	if (!client.installSnapshot().ok) throw new Error('baseline install failed');
}

test('schema mismatch pauses sync while the old replica continues local writes', () => {
	const { directory, reference, sqlite, close } = setup();
	const client = new SqliteClientB(
		join(directory, 'client.sqlite'),
		'old-actor',
		epoch1,
	);
	try {
		client.local([
			{
				kind: 'createRow',
				table: 'notes',
				rowId: 'n1',
				cells: { title: 'local', pinned: false },
			},
		]);
		expect(reference.push(client.pushRequest())).toEqual(
			sqlite.push(client.pushRequest()),
		);
		expect(reference.beginTransition(transition())).toEqual(
			sqlite.beginTransition(transition()),
		);
		expect(reference.activate('lease-1', 0)).toEqual({
			ok: false,
			reason: 'baseline-incomplete',
		});
		expect(sqlite.activate('lease-1', 0)).toEqual(
			reference.activate('lease-1', 0),
		);
		buildAll(reference, sqlite, 'lease-1');
		expect(reference.activate('lease-1', 0)).toEqual(
			sqlite.activate('lease-1', 0),
		);

		client.local([
			{
				kind: 'createRow',
				table: 'notes',
				rowId: 'n2',
				cells: { title: 'still local', pinned: true },
			},
		]);
		expect(client.dump().outbox).toHaveLength(2);
		for (const changedEpoch of [
			'field-added',
			'table-added',
			'enum-widened',
			'nullability-changed',
		]) {
			const request = { ...client.pushRequest(), schemaEpochId: changedEpoch };
			expect(reference.push(request)).toEqual({
				ok: false,
				reason: 'schema-epoch-mismatch',
			});
			expect(sqlite.push(request)).toEqual(reference.push(request));
		}
		compare(reference, sqlite);
	} finally {
		client.close();
		close();
	}
});

test('freeze builds canonical baseline and private overlay imports after activation', () => {
	const canonical: SnapshotRow[] = [
		{
			table: 'notes',
			rowId: 'n1',
			cells: { title: 'canonical', pinned: false },
		},
	];
	const { directory, reference, sqlite, close } = setup(canonical);
	const client = new SqliteClientB(
		join(directory, 'client.sqlite'),
		'source-actor',
		epoch1,
	);
	try {
		installBaseline(client, canonical);
		// The initiator synced everything: its applied cursor equals the head
		// that freezes below, so its source-only rows are provably its own
		// pending creations.
		const appliedCursor = incarnation(reference, 'incarnation-1').head;
		client.local([
			{
				kind: 'updateRow',
				table: 'notes',
				rowId: 'n1',
				cells: { title: 'private' },
			},
		]);
		client.local([
			{
				kind: 'createRow',
				table: 'notes',
				rowId: 'n9',
				cells: { title: 'fresh', pinned: true },
			},
		]);
		expect(reference.beginTransition(transition())).toEqual(
			sqlite.beginTransition(transition()),
		);
		expect(reference.push(client.pushRequest())).toEqual({
			ok: false,
			reason: 'transition-frozen',
		});
		expect(sqlite.push(client.pushRequest())).toEqual(
			reference.push(client.pushRequest()),
		);
		const frozenHead = incarnation(reference, 'incarnation-1').head;
		buildAll(reference, sqlite, 'lease-1');
		// The global baseline excludes the initiator's private overlay.
		expect(incarnation(reference, 'incarnation-2').rows).toEqual([
			{
				table: 'articles',
				rowId: 'n1',
				cells: { name: 'canonical', starred: false },
			},
		]);
		expect(reference.activate('lease-1', 0)).toEqual(
			sqlite.activate('lease-1', 0),
		);

		const transformed = transformRows(visibleRows(client.dump()), renameNotes);
		expect(transformed.result).toEqual({ ok: true });
		const destination = incarnation(reference, 'incarnation-2').rows;
		const plan = planOverlayImport({
			actorId: 'import-actor',
			source: transformed.rows,
			destination,
			appliedCursor,
			frozenHead,
		});
		expect(plan.review).toEqual([]);
		expect(plan.operations).toEqual([
			{
				kind: 'updateRow',
				table: 'articles',
				rowId: 'n1',
				cells: { name: 'private' },
			},
			{
				kind: 'createRow',
				table: 'articles',
				rowId: 'n9',
				cells: { name: 'fresh', starred: true },
			},
		]);
		const targetEnvelope: RequestEnvelope = {
			protocolMajor: 1,
			schemaEpochId: 'epoch-2',
			databaseIncarnationId: 'incarnation-2',
		};
		const request = pushRequest(
			targetEnvelope,
			plan.actorId,
			1,
			plan.operations,
		);
		expect(reference.push(request)).toEqual(sqlite.push(request));
		const updated = incarnation(reference, 'incarnation-2').rows;
		// Equal canonical content is a no-op on a second comparison.
		const replan = planOverlayImport({
			actorId: 'import-actor',
			source: transformed.rows,
			destination: updated,
			appliedCursor,
			frozenHead,
		});
		expect(replan.operations).toEqual([]);
		expect(replan.review).toEqual([]);
		// A second import actor recreating the same identity is refused before
		// acceptance, atomically, on both authorities.
		const duplicate = pushRequest(targetEnvelope, 'another-import', 1, [
			{
				kind: 'createRow',
				table: 'articles',
				rowId: 'n9',
				cells: { name: 'dupe' },
			},
		]);
		expect(reference.push(duplicate)).toEqual({
			ok: false,
			reason: 'create-conflict',
		});
		expect(sqlite.push(duplicate)).toEqual(reference.push(duplicate));
		compare(reference, sqlite);
	} finally {
		client.close();
		close();
	}
});

test('expired lease deletes preparing incarnation and unfreezes source', () => {
	const { reference, sqlite, close } = setup();
	try {
		const collision = transition({ targetIncarnationId: 'incarnation-1' });
		expect(reference.beginTransition(collision)).toEqual({
			ok: false,
			reason: 'target-incarnation-exists',
		});
		expect(sqlite.beginTransition(collision)).toEqual(
			reference.beginTransition(collision),
		);
		expect(reference.beginTransition(transition())).toEqual(
			sqlite.beginTransition(transition()),
		);
		expect(reference.buildTransition('lease-1', 1, 100)).toEqual({
			ok: false,
			reason: 'lease-expired',
		});
		expect(sqlite.buildTransition('lease-1', 1, 100)).toEqual(
			reference.buildTransition('lease-1', 1, 100),
		);
		expect(reference.activate('lease-1', 100)).toEqual({
			ok: false,
			reason: 'lease-expired',
		});
		expect(sqlite.activate('lease-1', 100)).toEqual(
			reference.activate('lease-1', 100),
		);
		expect(reference.expire(99)).toEqual({
			ok: false,
			reason: 'lease-not-expired',
		});
		expect(sqlite.expire(99)).toEqual(reference.expire(99));
		expect(reference.expire(100)).toEqual(sqlite.expire(100));
		expect(reference.dump().incarnations).toHaveLength(1);
		expect(reference.dump().incarnations[0].status).toBe('active');
		compare(reference, sqlite);
	} finally {
		close();
	}
});

test('preparing baseline resumes from durable row progress after reopen', () => {
	const directory = mkdtempSync(join(tmpdir(), 'epicenter-gate3-resume-'));
	const path = join(directory, 'authority.sqlite');
	const initial = {
		id: 'incarnation-1',
		epochId: 'epoch-1',
		rows: ['a', 'b', 'c'].map(
			(rowId): SnapshotRow => ({
				table: 'notes',
				rowId,
				cells: { title: rowId },
			}),
		),
	};
	const reference = new RefEpochAuthority(initial);
	let sqlite = new SqliteEpochAuthority(path, initial);
	try {
		expect(reference.beginTransition(transition())).toEqual(
			sqlite.beginTransition(transition()),
		);
		expect(reference.buildTransition('lease-1', 1, 0)).toEqual(
			sqlite.buildTransition('lease-1', 1, 0),
		);
		expect(reference.dump().transition?.nextRowIndex).toBe(1);
		sqlite.close();
		sqlite = new SqliteEpochAuthority(path, initial);
		compare(reference, sqlite);
		buildAll(reference, sqlite, 'lease-1', 1);
		expect(reference.activate('lease-1', 0)).toEqual(
			sqlite.activate('lease-1', 0),
		);
		expect(incarnation(reference, 'incarnation-2').rows).toHaveLength(3);
		compare(reference, sqlite);
	} finally {
		sqlite.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test('one-to-many and many-to-one identity transforms fail before freeze', () => {
	const rows: SnapshotRow[] = [
		{ table: 'notes', rowId: 'a', cells: { title: 'A' } },
		{ table: 'notes', rowId: 'b', cells: { title: 'B' } },
	];
	const invalid: Array<{
		transform: EpochTransform;
		reason: 'one-to-many-identity' | 'many-to-one-identity';
	}> = [
		{
			transform: {
				...renameNotes,
				tables: [
					{
						...renameNotes.tables[0],
						destinations: [
							{ table: 'articles', rowId: 'preserve' as const },
							{ table: 'archive', rowId: 'preserve' as const },
						],
					},
				],
			},
			reason: 'one-to-many-identity',
		},
		{
			transform: {
				...renameNotes,
				tables: [
					{
						...renameNotes.tables[0],
						destinations: [{ table: 'articles', rowId: { constant: 'same' } }],
					},
				],
			},
			reason: 'many-to-one-identity',
		},
	];
	for (const { transform, reason } of invalid) {
		const { reference, sqlite, close } = setup(rows);
		try {
			const request = transition({ transform });
			expect(reference.beginTransition(request)).toEqual({ ok: false, reason });
			expect(sqlite.beginTransition(request)).toEqual(
				reference.beginTransition(request),
			);
			expect(reference.dump().incarnations[0].status).toBe('active');
			compare(reference, sqlite);
		} finally {
			close();
		}
	}
});

test('stale replica skipping epochs reviews upstream deletions and physical copies mint a fresh actor', () => {
	const initialRows: SnapshotRow[] = [
		{ table: 'notes', rowId: 'gone', cells: { title: 'Gone', pinned: false } },
		{ table: 'notes', rowId: 'kept', cells: { title: 'Keep', pinned: false } },
	];
	const { reference, sqlite, close } = setup(initialRows);
	try {
		// The stale replica synced at head 0 and then went offline with this
		// frozen local view.
		const staleLocal = structuredClone(initialRows);
		const staleCursor = incarnation(reference, 'incarnation-1').head;
		// The shared database deletes 'gone' physically while it is away.
		const deleteGone = pushRequest(epoch1, 'deleter', 1, [
			{ kind: 'deleteRow', table: 'notes', rowId: 'gone' },
		]);
		expect(reference.push(deleteGone)).toEqual({ ok: true });
		expect(sqlite.push(deleteGone)).toEqual({ ok: true });

		// Two epoch upgrades happen without the stale replica.
		expect(reference.beginTransition(transition())).toEqual(
			sqlite.beginTransition(transition()),
		);
		const frozenHead = incarnation(reference, 'incarnation-1').head;
		expect(frozenHead).toBeGreaterThan(staleCursor);
		buildAll(reference, sqlite, 'lease-1');
		expect(reference.activate('lease-1', 0)).toEqual(
			sqlite.activate('lease-1', 0),
		);
		const secondTransform: EpochTransform = {
			fromEpochId: 'epoch-2',
			toEpochId: 'epoch-3',
			tables: [
				{
					sourceTable: 'articles',
					destinations: [{ table: 'entries', rowId: 'preserve' }],
					fields: {},
				},
			],
		};
		const second = transition({
			targetIncarnationId: 'incarnation-3',
			leaseId: 'lease-2',
			transform: secondTransform,
		});
		expect(reference.beginTransition(second)).toEqual(
			sqlite.beginTransition(second),
		);
		buildAll(reference, sqlite, 'lease-2');
		expect(reference.activate('lease-2', 0)).toEqual(
			sqlite.activate('lease-2', 0),
		);
		const active = incarnation(reference, 'incarnation-3');
		// The deleted row is absent from every frozen snapshot: no tombstone
		// carries through the transforms.
		expect(active.rows).toEqual([
			{
				table: 'entries',
				rowId: 'kept',
				cells: { name: 'Keep', starred: false },
			},
		]);

		// The stale replica composes the skipped identity maps over its local
		// state and enters through the reviewable comparison.
		const composed = transformRows(
			transformRows(staleLocal, renameNotes).rows,
			secondTransform,
		);
		expect(composed.result).toEqual({ ok: true });
		const plan = planOverlayImport({
			actorId: 'import-actor',
			source: composed.rows,
			destination: active.rows,
			appliedCursor: staleCursor,
			frozenHead,
		});
		// Equal content is a no-op; the upstream deletion is review-required
		// and excluded by default, NOT auto-imported.
		expect(plan.operations).toEqual([]);
		expect(plan.review).toEqual([
			{
				table: 'entries',
				rowId: 'gone',
				cells: { name: 'Gone', starred: false },
			},
		]);
		// Restoring purged content is a new identity.
		expect(() => restoreReviewRowAsNew(plan.review[0], 'gone')).toThrow(
			'new row identity',
		);
		expect(restoreReviewRowAsNew(plan.review[0], 'gone-2')).toEqual({
			kind: 'createRow',
			table: 'entries',
			rowId: 'gone-2',
			cells: { name: 'Gone', starred: false },
		});

		// A physical copy adopts through the import door under a fresh actor.
		expect(() =>
			planPhysicalCopyAdoption(
				'copied-actor',
				'copied-actor',
				composed.rows,
				[],
			),
		).toThrow('must mint a new actor');
		expect(
			planPhysicalCopyAdoption(
				'copied-actor',
				'fresh-actor',
				composed.rows,
				[],
			),
		).toEqual({
			ok: true,
			plan: {
				actorId: 'fresh-actor',
				operations: [
					{
						kind: 'createRow',
						table: 'entries',
						rowId: 'gone',
						cells: { name: 'Gone', starred: false },
					},
					{
						kind: 'createRow',
						table: 'entries',
						rowId: 'kept',
						cells: { name: 'Keep', starred: false },
					},
				],
			},
		});
		// Adoption requires a destination with zero live rows and a
		// collision-free mapped identity set.
		expect(planAdoption('fresh-actor', composed.rows, active.rows)).toEqual({
			ok: false,
			reason: 'destination-not-empty',
		});
		expect(
			planAdoption('fresh-actor', [...composed.rows, ...composed.rows], []),
		).toEqual({ ok: false, reason: 'mapped-identity-collision' });
		compare(reference, sqlite);
	} finally {
		close();
	}
});
