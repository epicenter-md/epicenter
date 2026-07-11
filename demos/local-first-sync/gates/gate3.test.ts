/**
 * Gate 3 schema epoch and incarnation transition tests.
 *
 * Compares independent in-memory and SQLite authorities while schemas freeze,
 * transform, activate, expire, and receive private replica intent by import.
 *
 * Key behaviors:
 * - one exact schema identity is accepted by one active incarnation;
 * - global baselines exclude private pending overlays;
 * - transforms preserve zero-to-one row and tombstone identity.
 */

import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteClientB } from './engine-client-b';
import {
	planImport,
	planPhysicalCopyImport,
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
	for (const [key, row] of Object.entries({
		...dump.rows,
		...dump.quarantine,
	})) {
		const [table, rowId] = splitRowKey(
			key as Parameters<typeof splitRowKey>[0],
		);
		rows.push({ table, rowId, deleted: false, cells: row.cells });
	}
	for (const key of dump.tombstones) {
		const [table, rowId] = splitRowKey(key);
		rows.push({ table, rowId, deleted: true, cells: {} });
	}
	return rows;
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
				kind: 'patchRow',
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
				kind: 'patchRow',
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
			deleted: false,
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
		client.local([
			{
				kind: 'patchRow',
				table: 'notes',
				rowId: 'n1',
				cells: { title: 'private', pinned: false },
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
		buildAll(reference, sqlite, 'lease-1');
		expect(incarnation(reference, 'incarnation-2').rows[0].cells.name).toBe(
			'canonical',
		);
		expect(reference.activate('lease-1', 0)).toEqual(
			sqlite.activate('lease-1', 0),
		);

		const transformed = transformRows(visibleRows(client.dump()), renameNotes);
		expect(transformed.result).toEqual({ ok: true });
		const destination = incarnation(reference, 'incarnation-2').rows;
		const plan = planImport('import-actor', transformed.rows, destination);
		expect(plan.operations).toEqual([
			{
				kind: 'patchRow',
				table: 'articles',
				rowId: 'n1',
				cells: { name: 'private' },
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
		expect(
			planImport('import-actor', transformed.rows, updated).operations,
		).toEqual([]);
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
				deleted: rowId === 'b',
				cells: rowId === 'b' ? {} : { title: rowId },
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
		{ table: 'notes', rowId: 'a', deleted: false, cells: { title: 'A' } },
		{ table: 'notes', rowId: 'b', deleted: true, cells: {} },
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

test('skipped epochs carry tombstones and physical copies require a fresh actor', () => {
	const rows: SnapshotRow[] = [
		{ table: 'notes', rowId: 'gone', deleted: true, cells: {} },
	];
	const { reference, sqlite, close } = setup(rows);
	try {
		reference.beginTransition(transition());
		sqlite.beginTransition(transition());
		buildAll(reference, sqlite, 'lease-1');
		reference.activate('lease-1', 0);
		sqlite.activate('lease-1', 0);
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
		expect(active.rows).toEqual([
			{ table: 'entries', rowId: 'gone', deleted: true, cells: {} },
		]);
		expect(() =>
			planPhysicalCopyImport('copied-actor', 'copied-actor', rows, []),
		).toThrow('must mint a new actor');
		const adopted = planPhysicalCopyImport(
			'copied-actor',
			'fresh-actor',
			rows,
			[],
		);
		expect(adopted.actorId).toBe('fresh-actor');
		compare(reference, sqlite);
	} finally {
		close();
	}
});
