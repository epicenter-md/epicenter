/**
 * Record Authority Binding Tests
 *
 * Verifies that the record-sync core exclusively owns discovery and binding of
 * authority identity metadata across every SQLite adapter.
 *
 * Key behaviors:
 * - First open mints and persists exactly one database incarnation
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
	schemaIdentity: 'notes-v1',
};

function setup() {
	const native = new Database(':memory:', { strict: true });
	return {
		native,
		database: createBunSqliteAdapter(native),
	};
}

test('first open persists one incarnation and restore reuses it', () => {
	const { database, native } = setup();
	let minted = 0;
	try {
		const opened = openRecordAuthority({
			database,
			request,
			createDatabaseIncarnationId: () => `database-${++minted}`,
			sha256,
		});
		expect(opened.ok).toBe(true);
		if (!opened.ok) throw new Error('Expected authority to open');
		expect(opened.databaseIncarnationId).toBe('database-1');

		const reopened = openRecordAuthority({
			database,
			request,
			createDatabaseIncarnationId: () => `database-${++minted}`,
			sha256,
		});
		expect(reopened.ok).toBe(true);
		if (!reopened.ok) throw new Error('Expected authority to reopen');
		expect(reopened.databaseIncarnationId).toBe('database-1');
		expect(minted).toBe(1);
		expect(restoreRecordAuthority({ database, sha256 })?.envelope).toEqual(
			opened.envelope,
		);
	} finally {
		native.close();
	}
});

test('binding refusals preserve existing authority identity', () => {
	const { database, native } = setup();
	try {
		const opened = openRecordAuthority({
			database,
			request,
			createDatabaseIncarnationId: () => 'database-1',
			sha256,
		});
		if (!opened.ok) throw new Error('Expected authority to open');
		expect(
			openRecordAuthority({
				database,
				request: { ...request, schemaIdentity: 'different' },
				createDatabaseIncarnationId: () => 'must-not-mint',
				sha256,
			}),
		).toEqual({ ok: false, reason: 'schema-identity-mismatch' });
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
				createDatabaseIncarnationId: () => 'must-not-mint',
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
					schemaIdentity: 'x'.repeat(
						RECORD_SYNC_ADMISSION_LIMITS.schemaIdentityBytes + 1,
					),
				},
				createDatabaseIncarnationId: () => 'must-not-mint',
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
			createDatabaseIncarnationId: () => 'database-1',
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
			createDatabaseIncarnationId: () => 'database-1',
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
			createDatabaseIncarnationId: () => 'database-1',
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
