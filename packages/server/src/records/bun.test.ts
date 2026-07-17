/**
 * Bun Record Backend Tests
 *
 * Verifies wire-v5 sealed-round sync over persistent Bun SQLite authorities.
 *
 * Key behaviors:
 * - accepted state survives reopen and partitions remain isolated
 * - accepted sealed rounds trigger production snapshot compaction
 * - snapshot publication failures never change an accepted sync response
 */

import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asPrincipalId } from '@epicenter/identity';
import {
	recordRoundDigest,
	RECORD_SYNC_ADMISSION_LIMITS,
	RECORD_SYNC_PROTOCOL_MAJOR,
	type RecordCommand,
	type SyncResponse,
	type SyncToken,
} from '@epicenter/row-sync';
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

function token(
	replicaId: string,
	acceptedRound = 0,
	checkpoint = 0,
): SyncToken {
	return { replicaId, acceptedRound, checkpoint };
}

function expectPage(
	response: SyncResponse,
): Extract<SyncResponse, { ok: true; snapshotRequired: false }> {
	if (!response.ok || response.snapshotRequired) {
		throw new Error(`Expected an incremental page: ${JSON.stringify(response)}`);
	}
	return response;
}

async function syncRound(
	records: Records,
	target: RecordsPartition,
	tokenValue: SyncToken,
	commands: RecordCommand[],
) {
	return records.sync(target, {
		protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
		kind: 'sync',
		token: tokenValue,
		sealedRound: {
			round: tokenValue.acceptedRound + 1,
			requestDigest: recordRoundDigest(commands),
			commands,
		},
	});
}

async function createRows(
	records: Records,
	target: RecordsPartition,
	replicaId: string,
	rowIds: string[],
): Promise<SyncToken> {
	let nextToken = token(replicaId);
	for (
		let offset = 0;
		offset < rowIds.length;
		offset += RECORD_SYNC_ADMISSION_LIMITS.commandsPerRound
	) {
		const commands = rowIds
			.slice(offset, offset + RECORD_SYNC_ADMISSION_LIMITS.commandsPerRound)
			.map(
				(rowId): RecordCommand => ({
					kind: 'createRow',
					table: 'pages',
					rowId,
					value: { title: rowId },
				}),
			);
		const page = expectPage(
			await syncRound(records, target, nextToken, commands),
		);
		nextToken = page.token;
	}
	return nextToken;
}

async function readFromStart(records: Records, target: RecordsPartition) {
	return records.sync(target, {
		protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
		kind: 'sync',
		token: token('reader'),
		pageLimit: RECORD_SYNC_ADMISSION_LIMITS.stateEntriesPerPage,
	});
}

test('current state survives closing and reopening without an open handshake', async () => {
	const first = setup();
	try {
		expect(
			(await createRows(first.records, partition, 'replica-1', ['page-1']))
				.acceptedRound,
		).toBe(1);
		first.close();

		const second = createBunRecords({ dir: first.dir, sha256 });
		try {
			const page = expectPage(await readFromStart(second.records, partition));
			expect(page.entries).toEqual([
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
		await createRows(context.records, partition, 'alice-wiki', ['alice-wiki']);
		await createRows(context.records, bobWiki, 'bob-wiki', ['bob-wiki']);
		await createRows(context.records, aliceNotes, 'alice-notes', [
			'alice-notes',
		]);

		for (const [target, rowId] of [
			[partition, 'alice-wiki'],
			[bobWiki, 'bob-wiki'],
			[aliceNotes, 'alice-notes'],
		] as const) {
			const page = expectPage(await readFromStart(context.records, target));
			expect(page.entries).toHaveLength(1);
			expect(page.entries[0]?.rowId).toBe(rowId);
		}
	} finally {
		context.cleanup();
	}
});

test('production compaction serves a bounded snapshot to stale checkpoints', async () => {
	const context = setup();
	try {
		const firstThousand = Array.from(
			{ length: 1_000 },
			(_, index) => `page-${index}`,
		);
		const nextToken = await createRows(
			context.records,
			partition,
			'replica-compact',
			firstThousand,
		);
		expect(
			expectPage(
				await syncRound(context.records, partition, nextToken, [
					{
						kind: 'createRow',
						table: 'pages',
						rowId: 'last',
						value: { title: 'last' },
					},
				]),
			).token.acceptedRound,
		).toBe(nextToken.acceptedRound + 1);

		const stale = await readFromStart(context.records, partition);
		expect(stale.ok && stale.snapshotRequired).toBe(true);
		if (!stale.ok || !stale.snapshotRequired)
			throw new Error('Expected snapshot');
		expect(
			await context.records.snapshotChunk(partition, {
				protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
				kind: 'snapshotChunk',
				generation: stale.manifest.generation,
				index: 0,
			}),
		).toMatchObject({ kind: 'snapshotChunk', ok: true });
	} finally {
		context.cleanup();
	}
});

test('snapshot publication failure cannot change an accepted sync', async () => {
	let failSnapshotHash = false;
	const context = setup(async (value) => {
		if (failSnapshotHash) throw new Error('injected snapshot hash failure');
		return sha256(value);
	});
	try {
		const nextToken = await createRows(
			context.records,
			partition,
			'replica-failed-compaction',
			Array.from({ length: 1_000 }, (_, index) => `page-${index}`),
		);
		failSnapshotHash = true;
		const accepted = expectPage(
			await syncRound(context.records, partition, nextToken, [
				{
					kind: 'createRow',
					table: 'pages',
					rowId: 'last',
					value: { title: 'last' },
				},
			]),
		);
		expect(accepted.token.acceptedRound).toBe(nextToken.acceptedRound + 1);

		const stale = expectPage(await readFromStart(context.records, partition));
		expect(stale.entries).toHaveLength(
			RECORD_SYNC_ADMISSION_LIMITS.stateEntriesPerPage,
		);
	} finally {
		context.cleanup();
	}
});
