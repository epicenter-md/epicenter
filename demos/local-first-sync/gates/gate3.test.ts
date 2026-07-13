/**
 * Gate 3 Immutable Database Succession Tests
 *
 * Compares independent in-memory and SQLite authorities for the collapsed
 * one-slot succession model before it enters the production record authority.
 *
 * Key behaviors:
 * - Content-addressed manifests and chunks replay exactly through one staging slot
 * - A complete sealed database activates only against its exact source head
 * - Write-first activation goes stale; activation-first permanently fences writes
 * - The uploaded chunks become the successor's initial checkpoint and survive restart
 */

import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	createCandidateChunk,
	createCandidateManifest,
	type Gate3Authority,
} from './gate3-protocol.js';
import { createGate3Reference } from './gate3-reference.js';
import { createGate3Sqlite } from './gate3-sqlite.js';
import type { SnapshotRow } from './protocol.js';
import { stableJson } from './util.js';

const initial = {
	databaseId: 'database-a',
	schemaHash: 'schema-a',
	rows: [
		{
			table: 'notes',
			rowId: 'n1',
			cells: { title: 'Original', pinned: false },
		},
	],
};

function setup() {
	const directory = mkdtempSync(join(tmpdir(), 'epicenter-gate3-'));
	const path = join(directory, 'authority.sqlite');
	const reference = createGate3Reference(initial);
	const sqlite = createGate3Sqlite(path, initial);
	return {
		directory,
		path,
		reference,
		sqlite,
		close() {
			sqlite.close();
			rmSync(directory, { recursive: true, force: true });
		},
	};
}

function both<TResult>(
	context: ReturnType<typeof setup>,
	run: (authority: Gate3Authority) => TResult,
): TResult {
	const expected = run(context.reference);
	expect(run(context.sqlite)).toEqual(expected);
	expect(context.sqlite.dump()).toEqual(context.reference.dump());
	return expected;
}

function buildCandidate({
	sourceDatabaseId = 'database-a',
	sourceHead = 0,
	targetSchemaHash = 'schema-b',
	rows,
	rowsPerChunk = 1,
}: {
	sourceDatabaseId?: string;
	sourceHead?: number;
	targetSchemaHash?: string;
	rows: SnapshotRow[];
	rowsPerChunk?: number;
}) {
	const chunks = Array.from(
		{ length: Math.max(1, Math.ceil(rows.length / rowsPerChunk)) },
		(_, index) =>
			createCandidateChunk(
				index,
				rows.slice(index * rowsPerChunk, (index + 1) * rowsPerChunk),
			),
	);
	return {
		chunks,
		manifest: createCandidateManifest({
			sourceDatabaseId,
			sourceHead,
			targetSchemaHash,
			chunks,
		}),
	};
}

function chunkAt(candidate: ReturnType<typeof buildCandidate>, index: number) {
	const chunk = candidate.chunks[index];
	if (!chunk) throw new Error(`Missing candidate chunk ${index}`);
	return chunk;
}

test('sealed content-addressed chunks activate as the successor checkpoint', () => {
	const context = setup();
	try {
		const targetRows: SnapshotRow[] = [
			{
				table: 'articles',
				rowId: 'n1',
				cells: { name: 'Original', starred: false },
			},
			{
				table: 'articles',
				rowId: 'n2',
				cells: { name: 'Second', starred: true },
			},
		];
		const candidate = buildCandidate({ rows: targetRows });

		expect(
			both(context, (authority) => authority.stage(candidate.manifest)),
		).toEqual({
			ok: true,
			candidateId: candidate.manifest.candidateId,
			replaced: false,
		});
		expect(
			both(context, (authority) => authority.stage(candidate.manifest)),
		).toEqual({
			ok: true,
			candidateId: candidate.manifest.candidateId,
			replaced: false,
		});
		expect(
			both(context, (authority) =>
				authority.readDatabase(candidate.manifest.candidateId),
			),
		).toEqual({ ok: false, reason: 'database-not-readable' });
		expect(
			both(context, (authority) =>
				authority.write(candidate.manifest.candidateId, {
					kind: 'createRow',
					table: 'articles',
					rowId: 'forbidden',
					cells: { name: 'Not a database yet' },
				}),
			),
		).toEqual({ ok: false, reason: 'database-not-live' });
		expect(
			both(context, (authority) =>
				authority.upload(candidate.manifest.candidateId, chunkAt(candidate, 0)),
			),
		).toEqual({ ok: true });
		expect(
			both(context, (authority) =>
				authority.write(candidate.manifest.candidateId, {
					kind: 'deleteRow',
					table: 'articles',
					rowId: 'n1',
				}),
			),
		).toEqual({ ok: false, reason: 'database-not-live' });
		expect(
			both(context, (authority) =>
				authority.upload(candidate.manifest.candidateId, chunkAt(candidate, 0)),
			),
		).toEqual({ ok: true });
		expect(
			both(context, (authority) =>
				authority.seal(candidate.manifest.candidateId),
			),
		).toEqual({ ok: false, reason: 'missing-chunks' });
		const tampered = structuredClone(chunkAt(candidate, 1));
		const tamperedRow = tampered.rows[0];
		if (!tamperedRow) throw new Error('Missing row in candidate chunk 1');
		tamperedRow.cells.name = 'Tampered';
		expect(
			both(context, (authority) =>
				authority.upload(candidate.manifest.candidateId, tampered),
			),
		).toEqual({ ok: false, reason: 'invalid-chunk' });
		expect(
			both(context, (authority) =>
				authority.upload(candidate.manifest.candidateId, chunkAt(candidate, 1)),
			),
		).toEqual({ ok: true });
		expect(
			both(context, (authority) =>
				authority.seal(candidate.manifest.candidateId),
			),
		).toEqual({ ok: true });
		expect(
			both(context, (authority) =>
				authority.activate(candidate.manifest.candidateId),
			),
		).toEqual({ ok: true, status: 'activated' });

		expect(
			both(context, (authority) =>
				authority.readDatabase(candidate.manifest.candidateId),
			),
		).toEqual({
			ok: true,
			snapshot: {
				databaseId: candidate.manifest.candidateId,
				schemaHash: 'schema-b',
				head: 1,
				rows: targetRows,
			},
		});
		expect(
			both(context, (authority) =>
				authority.checkpointChunks(candidate.manifest.candidateId),
			),
		).toEqual(candidate.chunks);
		expect(
			both(context, (authority) =>
				authority.write('database-a', {
					kind: 'updateRow',
					table: 'notes',
					rowId: 'n1',
					cells: { title: 'Too late' },
				}),
			),
		).toEqual({ ok: false, reason: 'database-fenced' });
		expect(
			both(context, (authority) =>
				authority.activate(candidate.manifest.candidateId),
			),
		).toEqual({ ok: true, status: 'already-active' });
		expect(
			both(context, (authority) => authority.stage(candidate.manifest)),
		).toEqual({ ok: false, reason: 'candidate-already-exists' });
		expect(stableJson(context.reference.dump())).not.toContain('actor');
		expect(stableJson(context.reference.dump())).not.toContain('device');
	} finally {
		context.close();
	}
});

test('a different manifest replaces the one staging slot without candidate races', () => {
	const context = setup();
	try {
		const first = buildCandidate({
			rows: [{ table: 'articles', rowId: 'n1', cells: { name: 'First' } }],
		});
		const second = buildCandidate({
			rows: [{ table: 'articles', rowId: 'n1', cells: { name: 'Second' } }],
		});
		both(context, (authority) => authority.stage(first.manifest));
		both(context, (authority) =>
			authority.upload(first.manifest.candidateId, chunkAt(first, 0)),
		);

		expect(
			both(context, (authority) => authority.stage(second.manifest)),
		).toEqual({
			ok: true,
			candidateId: second.manifest.candidateId,
			replaced: true,
		});
		expect(
			both(context, (authority) =>
				authority.upload(first.manifest.candidateId, chunkAt(first, 0)),
			),
		).toEqual({ ok: false, reason: 'candidate-not-staged' });
		expect(
			context.reference
				.dump()
				.databases.some(({ id }) => id === first.manifest.candidateId),
		).toBe(false);
		expect(
			both(context, (authority) =>
				authority.discard(second.manifest.candidateId),
			),
		).toEqual({ ok: true });
		expect(context.reference.dump().stagedUpload).toBeNull();
	} finally {
		context.close();
	}
});

test('a write-first race goes stale and a fresh replacement can activate', () => {
	const context = setup();
	try {
		const stale = buildCandidate({
			rows: [{ table: 'articles', rowId: 'n1', cells: { name: 'Original' } }],
		});
		both(context, (authority) => authority.stage(stale.manifest));
		both(context, (authority) =>
			authority.upload(stale.manifest.candidateId, chunkAt(stale, 0)),
		);
		both(context, (authority) => authority.seal(stale.manifest.candidateId));
		expect(
			both(context, (authority) =>
				authority.write('database-a', {
					kind: 'updateRow',
					table: 'notes',
					rowId: 'n1',
					cells: { title: 'Changed while staging' },
				}),
			),
		).toEqual({ ok: true, head: 1 });
		expect(
			both(context, (authority) =>
				authority.activate(stale.manifest.candidateId),
			),
		).toEqual({ ok: false, reason: 'stale-head' });

		const fresh = buildCandidate({
			sourceHead: 1,
			rows: [
				{
					table: 'articles',
					rowId: 'n1',
					cells: { name: 'Changed while staging' },
				},
			],
		});
		expect(
			both(context, (authority) => authority.stage(fresh.manifest)),
		).toEqual({
			ok: true,
			candidateId: fresh.manifest.candidateId,
			replaced: true,
		});
		both(context, (authority) =>
			authority.upload(fresh.manifest.candidateId, chunkAt(fresh, 0)),
		);
		both(context, (authority) => authority.seal(fresh.manifest.candidateId));
		expect(
			both(context, (authority) =>
				authority.activate(fresh.manifest.candidateId),
			),
		).toEqual({ ok: true, status: 'activated' });
	} finally {
		context.close();
	}
});

test('seal refuses duplicate or out-of-order row identities across chunks', () => {
	const context = setup();
	try {
		const duplicate = buildCandidate({
			rows: [
				{ table: 'articles', rowId: 'n1', cells: { name: 'First' } },
				{ table: 'articles', rowId: 'n1', cells: { name: 'Duplicate' } },
			],
		});
		both(context, (authority) => authority.stage(duplicate.manifest));
		for (const chunk of duplicate.chunks)
			both(context, (authority) =>
				authority.upload(duplicate.manifest.candidateId, chunk),
			);
		expect(
			both(context, (authority) =>
				authority.seal(duplicate.manifest.candidateId),
			),
		).toEqual({ ok: false, reason: 'rows-not-canonical' });
	} finally {
		context.close();
	}
});

test('manifest arithmetic is authenticated and a schema-only successor is valid', () => {
	const context = setup();
	try {
		const candidate = buildCandidate({ rows: [] });
		const invalid = structuredClone(candidate.manifest);
		invalid.rowCount = 1;
		expect(both(context, (authority) => authority.stage(invalid))).toEqual({
			ok: false,
			reason: 'invalid-manifest',
		});
		expect(
			both(context, (authority) => authority.stage(candidate.manifest)),
		).toMatchObject({ ok: true });
		expect(
			both(context, (authority) =>
				authority.upload(candidate.manifest.candidateId, chunkAt(candidate, 0)),
			),
		).toEqual({ ok: true });
		expect(
			both(context, (authority) =>
				authority.seal(candidate.manifest.candidateId),
			),
		).toEqual({ ok: true });
		expect(
			both(context, (authority) =>
				authority.activate(candidate.manifest.candidateId),
			),
		).toEqual({ ok: true, status: 'activated' });
		expect(
			both(context, (authority) =>
				authority.readDatabase(candidate.manifest.candidateId),
			),
		).toMatchObject({ ok: true, snapshot: { rows: [] } });
	} finally {
		context.close();
	}
});

test('SQLite restart preserves current selection, checkpoint, and source fence', () => {
	const directory = mkdtempSync(join(tmpdir(), 'epicenter-gate3-restart-'));
	const path = join(directory, 'authority.sqlite');
	const reference = createGate3Reference(initial);
	let sqlite = createGate3Sqlite(path, initial);
	const runBoth = <TResult>(run: (authority: Gate3Authority) => TResult) => {
		const expected = run(reference);
		expect(run(sqlite)).toEqual(expected);
		return expected;
	};
	try {
		const candidate = buildCandidate({
			rows: [{ table: 'articles', rowId: 'n1', cells: { name: 'Durable' } }],
		});
		runBoth((authority) => authority.stage(candidate.manifest));
		runBoth((authority) =>
			authority.upload(candidate.manifest.candidateId, chunkAt(candidate, 0)),
		);
		runBoth((authority) => authority.seal(candidate.manifest.candidateId));
		runBoth((authority) => authority.activate(candidate.manifest.candidateId));
		const before = reference.dump();
		sqlite.close();
		sqlite = createGate3Sqlite(path, {
			databaseId: 'must-not-reinitialize',
			schemaHash: 'wrong',
			rows: [],
		});
		expect(sqlite.dump()).toEqual(before);
		expect(sqlite.activate(candidate.manifest.candidateId)).toEqual({
			ok: true,
			status: 'already-active',
		});
		expect(
			sqlite.write('database-a', {
				kind: 'deleteRow',
				table: 'notes',
				rowId: 'n1',
			}),
		).toEqual({ ok: false, reason: 'database-fenced' });
		expect(sqlite.checkpointChunks(candidate.manifest.candidateId)).toEqual(
			candidate.chunks,
		);
	} finally {
		sqlite.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
