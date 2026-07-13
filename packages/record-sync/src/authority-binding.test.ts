/**
 * Record Authority Binding Tests
 *
 * Verifies that the record-sync core exclusively owns discovery and binding of
 * authority identity metadata across every SQLite adapter.
 *
 * Key behaviors:
 * - First open mints and persists exactly one database identity
 * - Restore reconstructs an authority without minting another identity
 * - Protocol and schema refusals leave durable identity unchanged
 * - Refusing an unopened database does not partially initialize storage
 * - Published snapshot chunks stay within their encoded byte limit
 */

import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createBunSqliteAdapter } from './adapters/bun.js';
import { RECORD_SYNC_ADMISSION_LIMITS } from './admission.js';
import { openRecordAuthority, restoreRecordAuthority } from './authority.js';
import { RECORD_SYNC_PROTOCOL_MAJOR } from './protocol.js';

const sha256 = async (value: string) =>
	createHash('sha256').update(value).digest('hex');
const request = {
	protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
	recordsSchemaHash: 'notes-v1',
};

function setup() {
	const native = new Database(':memory:', { strict: true });
	return {
		native,
		database: createBunSqliteAdapter(native),
	};
}

test('first open persists one database id and restore reuses it', () => {
	const { database, native } = setup();
	let minted = 0;
	try {
		const opened = openRecordAuthority({
			database,
			request,
			createDatabaseId: () => `database-${++minted}`,
			sha256,
		});
		expect(opened.ok).toBe(true);
		if (!opened.ok) throw new Error('Expected authority to open');
		expect(opened.databaseId).toBe('database-1');

		const reopened = openRecordAuthority({
			database,
			request,
			createDatabaseId: () => `database-${++minted}`,
			sha256,
		});
		expect(reopened.ok).toBe(true);
		if (!reopened.ok) throw new Error('Expected authority to reopen');
		expect(reopened.databaseId).toBe('database-1');
		expect(minted).toBe(1);
		expect(restoreRecordAuthority({ database, sha256 })?.envelope).toEqual(
			opened.envelope,
		);
	} finally {
		native.close();
	}
});

test('family selection fences an already-open source database', async () => {
	const { database, native } = setup();
	try {
		const opened = openRecordAuthority({
			database,
			request,
			createDatabaseId: () => 'database-a',
			sha256,
		});
		if (!opened.ok) throw new Error('Expected authority to open');
		expect(
			opened.authority.push({
				kind: 'push',
				...opened.envelope,
				mutations: [
					{
						actorId: 'actor-a',
						actorSequence: 1,
						operations: [
							{
								kind: 'createRow',
								table: 'notes',
								rowId: 'n1',
								cells: { title: 'Retained source' },
							},
						],
					},
				],
			}),
		).toEqual({ kind: 'push', ok: true });

		database.transaction(() => {
			database.run(
				`INSERT INTO record_sync_databases(
					database_id, storage_version, protocol_major, records_schema_hash,
					status, server_sequence, watermark, snapshot_generation
				) VALUES ('database-b', 1, ?, 'notes-v2', 'live', 0, 0, 0)`,
				[RECORD_SYNC_PROTOCOL_MAJOR],
			);
			database.run(
				"UPDATE record_sync_databases SET status = 'fenced' WHERE database_id = 'database-a'",
			);
			database.run(
				"UPDATE record_sync_family SET current_database_id = 'database-b' WHERE id = 1",
			);
		});

		expect(
			opened.authority.push({
				kind: 'push',
				...opened.envelope,
				mutations: [],
			}),
		).toEqual({ kind: 'push', ok: false, reason: 'database-id-mismatch' });
		await expect(
			opened.authority.publishSnapshot({ maxChunkBytes: 1024 }),
		).rejects.toThrow('no longer current');
		expect(restoreRecordAuthority({ database, sha256 })?.envelope).toEqual({
			protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
			recordsSchemaHash: 'notes-v2',
			databaseId: 'database-b',
		});
		expect(
			database.all<{ title: string }>(
				`SELECT json_extract(cells_json, '$.title') AS title
				 FROM record_sync_canonical_rows WHERE database_id = 'database-a'`,
			),
		).toEqual([{ title: 'Retained source' }]);
	} finally {
		native.close();
	}
});

test('open reports the stored descriptor without replacing authority identity', () => {
	const { database, native } = setup();
	try {
		const opened = openRecordAuthority({
			database,
			request,
			createDatabaseId: () => 'database-1',
			sha256,
		});
		if (!opened.ok) throw new Error('Expected authority to open');
		expect(
			openRecordAuthority({
				database,
				request: { ...request, recordsSchemaHash: 'different' },
				createDatabaseId: () => 'must-not-mint',
				sha256,
			}),
		).toMatchObject({
			ok: true,
			databaseId: opened.databaseId,
			recordsSchemaHash: request.recordsSchemaHash,
		});
		expect(restoreRecordAuthority({ database, sha256 })?.envelope).toEqual(
			opened.envelope,
		);
	} finally {
		native.close();
	}
});

test('unsupported protocol refuses without initializing an empty database', () => {
	const { database, native } = setup();
	try {
		expect(
			openRecordAuthority({
				database,
				request: {
					...request,
					protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR + 1,
				},
				createDatabaseId: () => 'must-not-mint',
				sha256,
			}),
		).toEqual({ ok: false, reason: 'protocol-mismatch' });
		expect(restoreRecordAuthority({ database, sha256 })).toBeNull();
	} finally {
		native.close();
	}
});

test('invalid binding input refuses before initializing storage', () => {
	const { database, native } = setup();
	try {
		expect(() =>
			openRecordAuthority({
				database,
				request: {
					...request,
					recordsSchemaHash: 'x'.repeat(
						RECORD_SYNC_ADMISSION_LIMITS.recordsSchemaHashBytes + 1,
					),
				},
				createDatabaseId: () => 'must-not-mint',
				sha256,
			}),
		).toThrow('Invalid record authority binding request');
		expect(restoreRecordAuthority({ database, sha256 })).toBeNull();
	} finally {
		native.close();
	}
});

test('snapshot publication bounds every encoded chunk by bytes', async () => {
	const { database, native } = setup();
	try {
		const opened = openRecordAuthority({
			database,
			request,
			createDatabaseId: () => 'database-1',
			sha256,
		});
		if (!opened.ok) throw new Error('Expected authority to open');
		expect(
			opened.authority.push({
				...opened.envelope,
				kind: 'push',
				mutations: [
					{
						actorId: 'actor-1',
						actorSequence: 1,
						operations: Array.from({ length: 4 }, (_, index) => ({
							kind: 'createRow' as const,
							table: 'notes',
							rowId: `note-${index}`,
							cells: { body: 'x'.repeat(80) },
						})),
					},
				],
			}),
		).toEqual({ kind: 'push', ok: true });
		const maxChunkBytes = 320;
		const manifest = await opened.authority.publishSnapshot({ maxChunkBytes });
		expect(manifest.chunkChecksums.length).toBeGreaterThan(1);
		for (let index = 0; index < manifest.chunkChecksums.length; index += 1) {
			const response = opened.authority.snapshotChunk({
				...opened.envelope,
				kind: 'snapshotChunk',
				generation: manifest.generation,
				index,
			});
			if (!response.ok) throw new Error('Expected snapshot chunk');
			expect(
				new TextEncoder().encode(JSON.stringify(response.chunk)).byteLength,
			).toBeLessThanOrEqual(maxChunkBytes);
		}
	} finally {
		native.close();
	}
});

test('snapshot publication cannot exceed the protocol chunk ceiling', async () => {
	const { database, native } = setup();
	try {
		const opened = openRecordAuthority({
			database,
			request,
			createDatabaseId: () => 'database-1',
			sha256,
		});
		if (!opened.ok) throw new Error('Expected authority to open');
		await expect(
			opened.authority.publishSnapshot({
				maxChunkBytes:
					RECORD_SYNC_ADMISSION_LIMITS.encodedSnapshotChunkBytes + 1,
			}),
		).rejects.toThrow('maxChunkBytes must be an integer');
	} finally {
		native.close();
	}
});

test('push rejects a patch that would make the canonical row unsnapshotable', () => {
	const { database, native } = setup();
	try {
		const opened = openRecordAuthority({
			database,
			request,
			createDatabaseId: () => 'database-1',
			sha256,
		});
		if (!opened.ok) throw new Error('Expected authority to open');
		const body = 'x'.repeat(RECORD_SYNC_ADMISSION_LIMITS.encodedCellBytes);

		expect(
			opened.authority.push({
				...opened.envelope,
				kind: 'push',
				mutations: [
					{
						actorId: 'actor-1',
						actorSequence: 1,
						operations: [
							{
								kind: 'createRow',
								table: 'notes',
								rowId: 'note-1',
								cells: { one: body },
							},
						],
					},
				],
			}),
		).toEqual({ kind: 'push', ok: true });
		expect(
			opened.authority.push({
				...opened.envelope,
				kind: 'push',
				mutations: [
					{
						actorId: 'actor-1',
						actorSequence: 2,
						operations: [
							{
								kind: 'updateRow',
								table: 'notes',
								rowId: 'note-1',
								cells: { two: body },
							},
						],
					},
				],
			}),
		).toEqual({ kind: 'push', ok: false, reason: 'row-too-large' });
	} finally {
		native.close();
	}
});
