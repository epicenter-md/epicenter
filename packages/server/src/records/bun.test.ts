import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asPrincipalId } from '@epicenter/identity';
import { RECORD_SYNC_PROTOCOL_MAJOR } from '@epicenter/record-sync';
import { createBunRecords } from './bun.js';
import type { Records, RecordsPartition } from './contracts.js';

const sha256 = async (value: string) =>
	createHash('sha256').update(value).digest('hex');
const partition: RecordsPartition = {
	principalId: asPrincipalId('alice'),
	workspaceId: 'wiki',
};

function setup(hash = sha256) {
	const dir = mkdtempSync(join(tmpdir(), 'epicenter-records-'));
	const opened = createBunRecords({ dir, sha256: hash });
	return {
		dir,
		...opened,
		cleanup() {
			opened.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

async function createRow(
	records: Records,
	target: RecordsPartition,
	actorId: string,
	actorSequence: number,
	rowId: string,
) {
	return records.push(target, {
		protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
		kind: 'push',
		actorId,
		mutations: [
			{
				actorSequence,
				command: {
					kind: 'createRow',
					table: 'pages',
					rowId,
					value: { title: rowId },
				},
			},
		],
	});
}

test('current state survives closing and reopening without an open handshake', async () => {
	const first = setup();
	try {
		expect(
			(await createRow(first.records, partition, 'actor-1', 1, 'page-1')).ok,
		).toBe(true);
		first.close();

		const second = createBunRecords({ dir: first.dir, sha256 });
		try {
			const pulled = await second.records.pull(partition, {
				protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
				kind: 'pull',
				cursor: 0,
				limit: 100,
			});
			expect(pulled.ok && !pulled.snapshotRequired && pulled.entries).toEqual([
				expect.objectContaining({
					kind: 'row',
					table: 'pages',
					rowId: 'page-1',
					value: { title: 'page-1' },
				}),
			]);
		} finally {
			second.close();
		}
	} finally {
		first.cleanup();
	}
});

test('principal and workspace pairs own independent authorities', async () => {
	const context = setup();
	try {
		const bobWiki = {
			principalId: asPrincipalId('bob'),
			workspaceId: 'wiki',
		};
		const aliceNotes = {
			principalId: asPrincipalId('alice'),
			workspaceId: 'notes',
		};
		await createRow(context.records, partition, 'alice-wiki', 1, 'alice-wiki');
		await createRow(context.records, bobWiki, 'bob-wiki', 1, 'bob-wiki');
		await createRow(
			context.records,
			aliceNotes,
			'alice-notes',
			1,
			'alice-notes',
		);

		for (const [target, rowId] of [
			[partition, 'alice-wiki'],
			[bobWiki, 'bob-wiki'],
			[aliceNotes, 'alice-notes'],
		] as const) {
			const pulled = await context.records.pull(target, {
				protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
				kind: 'pull',
				cursor: 0,
				limit: 100,
			});
			expect(
				pulled.ok && !pulled.snapshotRequired && pulled.entries,
			).toHaveLength(1);
			expect(
				pulled.ok && !pulled.snapshotRequired && pulled.entries[0]?.rowId,
			).toBe(rowId);
		}
	} finally {
		context.cleanup();
	}
});

test('production compaction serves a bounded snapshot to stale cursors', async () => {
	const context = setup();
	try {
		const first = await context.records.push(partition, {
			protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
			kind: 'push',
			actorId: 'actor-compact',
			mutations: Array.from({ length: 1_000 }, (_, index) => ({
				actorSequence: index + 1,
				command: {
					kind: 'createRow' as const,
					table: 'pages',
					rowId: `page-${index}`,
					value: { title: `Page ${index}` },
				},
			})),
		});
		expect(first.ok).toBe(true);
		expect(
			(
				await createRow(
					context.records,
					partition,
					'actor-compact',
					1_001,
					'last',
				)
			).ok,
		).toBe(true);
		const pulled = await context.records.pull(partition, {
			protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
			kind: 'pull',
			cursor: 0,
			limit: 100,
		});
		expect(pulled.ok && pulled.snapshotRequired).toBe(true);
		if (!pulled.ok || !pulled.snapshotRequired)
			throw new Error('Expected snapshot');
		expect(
			await context.records.snapshotChunk(partition, {
				protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
				kind: 'snapshotChunk',
				generation: pulled.manifest.generation,
				index: 0,
			}),
		).toMatchObject({ kind: 'snapshotChunk', ok: true });
	} finally {
		context.cleanup();
	}
});

test('snapshot publication failure cannot change an accepted push', async () => {
	let failSnapshotHash = false;
	const context = setup(async (value) => {
		if (failSnapshotHash) throw new Error('injected snapshot hash failure');
		return sha256(value);
	});
	try {
		const first = await context.records.push(partition, {
			protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
			kind: 'push',
			actorId: 'actor-failed-compaction',
			mutations: Array.from({ length: 1_000 }, (_, index) => ({
				actorSequence: index + 1,
				command: {
					kind: 'createRow' as const,
					table: 'pages',
					rowId: `page-${index}`,
					value: { title: `Page ${index}` },
				},
			})),
		});
		expect(first.ok).toBe(true);
		failSnapshotHash = true;
		expect(
			(
				await createRow(
					context.records,
					partition,
					'actor-failed-compaction',
					1_001,
					'last',
				)
			).ok,
		).toBe(true);
		const pulled = await context.records.pull(partition, {
			protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
			kind: 'pull',
			cursor: 0,
			limit: 100,
		});
		expect(
			pulled.ok && !pulled.snapshotRequired && pulled.entries,
		).toHaveLength(100);
	} finally {
		context.cleanup();
	}
});
