/**
 * Records Database Succession Tests
 *
 * Proves the production one-slot state machine over the same partitioned
 * authority tables used by ordinary push, pull, and snapshot publication.
 *
 * Key behaviors:
 * - A pending upload is invisible until one atomic activation transaction
 * - Uploaded snapshot chunks become the successor's initial checkpoint
 * - Write-first activation goes stale; activation-first fences the source
 * - A different content-addressed manifest replaces the one staging slot
 */

import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createBunSqliteAdapter } from './adapters/bun.js';
import { openRecordAuthority, restoreRecordAuthority } from './authority.js';
import { RECORD_SYNC_PROTOCOL_MAJOR } from './protocol.js';
import { createSnapshotChunk } from './snapshot.js';
import {
	createCandidateManifest,
	createRecordSuccession,
} from './succession.js';

const sha256 = async (value: string) =>
	createHash('sha256').update(value).digest('hex');

function setup() {
	const native = new Database(':memory:', { strict: true });
	const database = createBunSqliteAdapter(native);
	const opened = openRecordAuthority({
		database,
		request: {
			protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
			recordsSchemaHash: 'schema-a',
		},
		createDatabaseId: () => 'database-a',
		sha256,
	});
	if (!opened.ok) throw new Error('Expected source database to open');
	return {
		native,
		database,
		opened,
		succession: createRecordSuccession({ database, sha256 }),
	};
}

async function candidate({
	sourceHead,
	title,
}: {
	sourceHead: number;
	title: string;
}) {
	const chunks = [
		await createSnapshotChunk(sha256, 1, 0, [
			{ table: 'articles', rowId: 'a1', cells: { title } },
		]),
	];
	return {
		chunks,
		manifest: await createCandidateManifest({
			sha256,
			sourceDatabaseId: 'database-a',
			sourceHead,
			targetRecordsSchemaHash: 'schema-b',
			chunks,
		}),
	};
}

function firstChunk(value: Awaited<ReturnType<typeof candidate>>) {
	const chunk = value.chunks[0];
	if (!chunk) throw new Error('Candidate has no first chunk');
	return chunk;
}

test('sealed upload activates as the new database and initial checkpoint', async () => {
	const context = setup();
	try {
		const next = await candidate({ sourceHead: 0, title: 'Migrated' });
		expect(await context.succession.stage(next.manifest)).toMatchObject({
			ok: true,
			replaced: false,
		});
		expect(
			await context.succession.upload(
				next.manifest.candidateId,
				firstChunk(next),
			),
		).toEqual({ ok: true });
		expect(context.succession.activate(next.manifest.candidateId)).toEqual({
			ok: false,
			reason: 'candidate-not-sealed',
		});
		expect(await context.succession.seal(next.manifest.candidateId)).toEqual({
			ok: true,
		});
		expect(context.succession.activate(next.manifest.candidateId)).toEqual({
			ok: true,
			status: 'activated',
		});
		expect(context.succession.activate(next.manifest.candidateId)).toEqual({
			ok: true,
			status: 'already-active',
		});
		expect(await context.succession.stage(next.manifest)).toEqual({
			ok: false,
			reason: 'candidate-already-exists',
		});

		expect(
			context.opened.authority.push({
				kind: 'push',
				...context.opened.envelope,
				mutations: [],
			}),
		).toEqual({ kind: 'push', ok: false, reason: 'database-id-mismatch' });
		const restored = restoreRecordAuthority({
			database: context.database,
			sha256,
		});
		expect(restored?.envelope).toEqual({
			protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
			recordsSchemaHash: 'schema-b',
			databaseId: next.manifest.candidateId,
		});
		if (!restored) throw new Error('Expected successor authority to restore');
		const bootstrap = restored.authority.pull({
			kind: 'pull',
			...restored.envelope,
			cursor: 0,
			limit: 10,
		});
		expect(bootstrap).toMatchObject({
			ok: true,
			snapshotRequired: true,
			manifest: { generation: 1, snapshotSequence: 1 },
		});
		expect(
			context.database.all<{
				database_id: string;
				status: string;
				server_sequence: number;
			}>(
				`SELECT database_id, status, server_sequence
				 FROM record_sync_databases ORDER BY status, database_id`,
			),
		).toEqual([
			{ database_id: 'database-a', status: 'fenced', server_sequence: 0 },
			{
				database_id: next.manifest.candidateId,
				status: 'live',
				server_sequence: 1,
			},
		]);
		expect(
			context.database.all<{ title: string }>(
				`SELECT json_extract(cells_json, '$.title') AS title
				 FROM record_sync_canonical_rows WHERE database_id = ?`,
				[next.manifest.candidateId],
			),
		).toEqual([{ title: 'Migrated' }]);
		expect(
			context.database.all<{ rows_json: string }>(
				`SELECT rows_json FROM record_sync_snapshot_chunks
				 WHERE database_id = ?`,
				[next.manifest.candidateId],
			),
		).toEqual([{ rows_json: JSON.stringify(firstChunk(next).rows) }]);
	} finally {
		context.native.close();
	}
});

test('source write makes activation stale and a rebuilt manifest replaces the slot', async () => {
	const context = setup();
	try {
		const stale = await candidate({ sourceHead: 0, title: 'Stale' });
		await context.succession.stage(stale.manifest);
		await context.succession.upload(
			stale.manifest.candidateId,
			firstChunk(stale),
		);
		await context.succession.seal(stale.manifest.candidateId);
		expect(
			context.opened.authority.push({
				kind: 'push',
				...context.opened.envelope,
				mutations: [
					{
						actorId: 'writer',
						actorSequence: 1,
						operations: [
							{
								kind: 'createRow',
								table: 'notes',
								rowId: 'n1',
								cells: { title: 'Concurrent write' },
							},
						],
					},
				],
			}),
		).toEqual({ kind: 'push', ok: true });
		expect(context.succession.activate(stale.manifest.candidateId)).toEqual({
			ok: false,
			reason: 'stale-head',
		});

		const fresh = await candidate({ sourceHead: 1, title: 'Fresh' });
		expect(await context.succession.stage(fresh.manifest)).toMatchObject({
			ok: true,
			replaced: true,
		});
		expect(
			await context.succession.upload(
				stale.manifest.candidateId,
				firstChunk(stale),
			),
		).toEqual({
			ok: false,
			reason: 'candidate-not-staged',
		});
	} finally {
		context.native.close();
	}
});

test('sealing checks canonical identity order across chunk boundaries', async () => {
	const context = setup();
	try {
		const chunks = [
			await createSnapshotChunk(sha256, 1, 0, [
				{ table: 'notes', rowId: 'n2', cells: { title: 'Second' } },
			]),
			await createSnapshotChunk(sha256, 1, 1, [
				{ table: 'notes', rowId: 'n1', cells: { title: 'First' } },
			]),
		];
		const manifest = await createCandidateManifest({
			sha256,
			sourceDatabaseId: 'database-a',
			sourceHead: 0,
			targetRecordsSchemaHash: 'schema-b',
			chunks,
		});
		expect(await context.succession.stage(manifest)).toMatchObject({
			ok: true,
		});
		for (const chunk of chunks) {
			expect(
				await context.succession.upload(manifest.candidateId, chunk),
			).toEqual({ ok: true });
		}
		expect(await context.succession.seal(manifest.candidateId)).toEqual({
			ok: false,
			reason: 'rows-not-canonical',
		});
	} finally {
		context.native.close();
	}
});
