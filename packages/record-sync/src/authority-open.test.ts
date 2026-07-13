/**
 * Record Authority Open Tests
 *
 * Verifies that the record-sync core owns authority discovery and records-epoch
 * fencing across every SQLite adapter.
 *
 * Key behaviors:
 * - First open mints and persists exactly one records epoch
 * - Open descriptively reports the stored schema and epoch
 * - Stale durable identity writes, cursors, snapshots, and chunks are fenced
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

test('first open persists one records epoch and restore reuses it', () => {
	const { database, native } = setup();
	try {
		const opened = openRecordAuthority({
			database,
			request,
			sha256,
		});
		expect(opened.ok).toBe(true);
		if (!opened.ok) throw new Error('Expected authority to open');
		expect(opened.recordsEpoch).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
		expect(opened.recordsSchemaHash).toBe('notes-v1');

		const reopened = openRecordAuthority({
			database,
			request,
			sha256,
		});
		expect(reopened.ok).toBe(true);
		if (!reopened.ok) throw new Error('Expected authority to reopen');
		expect(reopened.recordsEpoch).toBe(opened.recordsEpoch);
		expect(reopened.recordsSchemaHash).toBe('notes-v1');
		expect(restoreRecordAuthority({ database, sha256 })?.envelope).toEqual(
			opened.envelope,
		);
	} finally {
		native.close();
	}
});

test('restore refuses durable identity outside the wire contract', () => {
	const { database, native } = setup();
	try {
		const opened = openRecordAuthority({ database, request, sha256 });
		if (!opened.ok) throw new Error('Expected authority to open');
		database.run(
			"UPDATE record_sync_meta SET value = ? WHERE key = 'recordsEpoch'",
			['x'.repeat(RECORD_SYNC_ADMISSION_LIMITS.identifierBytes + 1)],
		);

		expect(() => restoreRecordAuthority({ database, sha256 })).toThrow(
			'Invalid record-sync identity metadata',
		);
		expect(() => openRecordAuthority({ database, request, sha256 })).toThrow(
			'Invalid record-sync identity metadata',
		);
	} finally {
		native.close();
	}
});

test('open reports the stored descriptor without replacing the records epoch', () => {
	const { database, native } = setup();
	try {
		const opened = openRecordAuthority({
			database,
			request,
			sha256,
		});
		if (!opened.ok) throw new Error('Expected authority to open');
		expect(
			openRecordAuthority({
				database,
				request: { ...request, recordsSchemaHash: 'different' },
				sha256,
			}),
		).toMatchObject({
			ok: true,
			recordsEpoch: opened.recordsEpoch,
			recordsSchemaHash: 'notes-v1',
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
				sha256,
			}),
		).toEqual({ ok: false, reason: 'protocol-mismatch' });
		expect(restoreRecordAuthority({ database, sha256 })).toBeNull();
	} finally {
		native.close();
	}
});

test('invalid open input refuses before initializing storage', () => {
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
				sha256,
			}),
		).toThrow('Invalid record authority open request');
		expect(restoreRecordAuthority({ database, sha256 })).toBeNull();
	} finally {
		native.close();
	}
});

test('stored epoch change fences stale writes, cursors, snapshots, and chunks', async () => {
	const { database, native } = setup();
	try {
		const opened = openRecordAuthority({
			database,
			request,
			sha256,
		});
		if (!opened.ok) throw new Error('Expected authority to open');
		const manifest = await opened.authority.publishSnapshot({
			maxChunkBytes: 1_024,
		});
		database.run(
			"UPDATE record_sync_meta SET value = 'epoch-2' WHERE key = 'recordsEpoch'",
		);

		expect(
			opened.authority.push({
				...opened.envelope,
				kind: 'push',
				mutations: [
					{
						actorId: 'stale-actor',
						actorSequence: 1,
						operations: [
							{
								kind: 'createRow',
								table: 'notes',
								rowId: 'must-not-commit',
								cells: { title: 'stale' },
							},
						],
					},
				],
			}),
		).toEqual({ kind: 'push', ok: false, reason: 'records-epoch-mismatch' });
		expect(
			database.all<{ count: number }>(
				"SELECT COUNT(*) AS count FROM record_sync_canonical_rows WHERE row_id = 'must-not-commit'",
			)[0]?.count,
		).toBe(0);
		expect(
			opened.authority.pull({
				...opened.envelope,
				kind: 'pull',
				cursor: 0,
				limit: 100,
			}),
		).toEqual({ kind: 'pull', ok: false, reason: 'records-epoch-mismatch' });
		expect(
			opened.authority.snapshotChunk({
				...opened.envelope,
				kind: 'snapshotChunk',
				generation: manifest.generation,
				index: 0,
			}),
		).toEqual({
			kind: 'snapshotChunk',
			ok: false,
			reason: 'records-epoch-mismatch',
		});
		await expect(
			opened.authority.publishSnapshot({ maxChunkBytes: 1_024 }),
		).rejects.toThrow('record-sync identity is no longer current');
		await expect(
			opened.authority.maybePublishSnapshot({
				mutationThreshold: 100,
				maxChunkBytes: 1_024,
			}),
		).rejects.toThrow('record-sync identity is no longer current');
	} finally {
		native.close();
	}
});

test('stored schema change without a new epoch fails closed', async () => {
	const { database, native } = setup();
	try {
		const opened = openRecordAuthority({
			database,
			request,
			sha256,
		});
		if (!opened.ok) throw new Error('Expected authority to open');
		database.run(
			"UPDATE record_sync_meta SET value = 'notes-v2' WHERE key = 'recordsSchemaHash'",
		);

		expect(
			opened.authority.push({
				...opened.envelope,
				kind: 'push',
				mutations: [],
			}),
		).toEqual({ kind: 'push', ok: false, reason: 'records-schema-mismatch' });
		expect(
			opened.authority.pull({
				...opened.envelope,
				kind: 'pull',
				cursor: 0,
				limit: 100,
			}),
		).toEqual({ kind: 'pull', ok: false, reason: 'records-schema-mismatch' });
		await expect(
			opened.authority.publishSnapshot({ maxChunkBytes: 1_024 }),
		).rejects.toThrow('record-sync identity is no longer current');
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
