/**
 * Bun Records Backend Tests
 *
 * Verifies the persistent Bun SQLite implementation of the portable records
 * backend, including durable identity and authenticated partition isolation.
 *
 * Key behaviors:
 * - Database incarnation and mutations survive closing and reopening
 * - Protocol and schema mismatches refuse without replacing stored identity
 * - Principal and workspace pairs use independent SQLite authorities
 * - Production compaction sends stale cursors through bounded snapshots
 */

import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asPrincipalId } from '@epicenter/identity';
import {
	RECORD_SYNC_PROTOCOL_MAJOR,
	type RequestEnvelope,
} from '@epicenter/record-sync';
import { createBunRecords } from './bun.js';
import type { RecordsPartition } from './contracts.js';

const sha256 = async (value: string) =>
	createHash('sha256').update(value).digest('hex');
const partition: RecordsPartition = {
	principalId: asPrincipalId('alice'),
	workspaceId: 'wiki',
};

function setup() {
	const dir = mkdtempSync(join(tmpdir(), 'epicenter-records-'));
	const opened = createBunRecords({ dir, sha256 });
	return {
		dir,
		...opened,
		cleanup() {
			opened.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

async function openEnvelope(
	records: ReturnType<typeof createBunRecords>['records'],
	target = partition,
	schemaIdentity = 'schema-1',
): Promise<RequestEnvelope> {
	const result = await records.open(target, {
		protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
		schemaIdentity,
	});
	if (!result.ok) throw new Error(`Open refused: ${result.reason}`);
	return {
		protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
		schemaIdentity,
		databaseIncarnationId: result.databaseIncarnationId,
	};
}

test('database identity and mutation log survive closing and reopening', async () => {
	const first = setup();
	try {
		const envelope = await openEnvelope(first.records);
		expect(
			await first.records.push(partition, {
				...envelope,
				kind: 'push',
				mutations: [
					{
						actorId: 'actor-1',
						actorSequence: 1,
						operations: [
							{
								kind: 'patchRow',
								table: 'pages',
								rowId: 'page-1',
								cells: { title: 'Hello' },
							},
						],
					},
				],
			}),
		).toEqual({ kind: 'push', ok: true });
		first.close();

		const second = createBunRecords({ dir: first.dir, sha256 });
		try {
			const reopened = await openEnvelope(second.records);
			expect(reopened.databaseIncarnationId).toBe(
				envelope.databaseIncarnationId,
			);
			const pulled = await second.records.pull(partition, {
				...reopened,
				kind: 'pull',
				cursor: 0,
				limit: 100,
			});
			expect(
				pulled.ok && !pulled.snapshotRequired && pulled.mutations,
			).toHaveLength(1);
		} finally {
			second.close();
		}
	} finally {
		first.cleanup();
	}
});

test('protocol and schema refusals do not replace stored identity', async () => {
	const context = setup();
	try {
		const envelope = await openEnvelope(context.records);
		expect(
			await context.records.open(partition, {
				protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR + 1,
				schemaIdentity: envelope.schemaIdentity,
			}),
		).toEqual({ ok: false, reason: 'protocol-mismatch' });
		expect(
			await context.records.open(partition, {
				protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
				schemaIdentity: 'different-schema',
			}),
		).toEqual({ ok: false, reason: 'schema-identity-mismatch' });
		expect((await openEnvelope(context.records)).databaseIncarnationId).toBe(
			envelope.databaseIncarnationId,
		);
	} finally {
		context.cleanup();
	}
});

test('principal and workspace pairs own independent database incarnations', async () => {
	const context = setup();
	try {
		const aliceWiki = await openEnvelope(context.records, partition);
		const bobWiki = await openEnvelope(context.records, {
			principalId: asPrincipalId('bob'),
			workspaceId: 'wiki',
		});
		const aliceNotes = await openEnvelope(context.records, {
			principalId: asPrincipalId('alice'),
			workspaceId: 'notes',
		});

		expect(
			new Set([
				aliceWiki.databaseIncarnationId,
				bobWiki.databaseIncarnationId,
				aliceNotes.databaseIncarnationId,
			]).size,
		).toBe(3);
	} finally {
		context.cleanup();
	}
});

test('production compaction serves a snapshot and chunks to a stale cursor', async () => {
	const context = setup();
	try {
		const envelope = await openEnvelope(context.records);
		expect(
			await context.records.push(partition, {
				...envelope,
				kind: 'push',
				mutations: Array.from({ length: 1_000 }, (_, index) => ({
					actorId: 'actor-compact',
					actorSequence: index + 1,
					operations: [
						{
							kind: 'patchRow' as const,
							table: 'pages',
							rowId: `page-${index}`,
							cells: { title: `Page ${index}` },
						},
					],
				})),
			}),
		).toEqual({ kind: 'push', ok: true });
		const pulled = await context.records.pull(partition, {
			...envelope,
			kind: 'pull',
			cursor: 0,
			limit: 100,
		});
		expect(pulled.ok && pulled.snapshotRequired).toBe(true);
		if (!pulled.ok || !pulled.snapshotRequired)
			throw new Error('Expected snapshot bootstrap');
		const chunk = await context.records.snapshotChunk(partition, {
			...envelope,
			kind: 'snapshotChunk',
			generation: pulled.manifest.generation,
			index: 0,
		});
		expect(chunk.ok).toBe(true);
	} finally {
		context.cleanup();
	}
});
