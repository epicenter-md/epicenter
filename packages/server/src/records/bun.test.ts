/**
 * Bun Row Backend Tests
 *
 * Verifies RowIntent sync over persistent, partitioned Bun SQLite authorities.
 *
 * Key behaviors:
 * - enrollment and accepted sealed rounds survive reopen
 * - exact retries are idempotent and unknown replicas are refused
 * - compaction moves stale replicas to paged baseline acquisition
 */

import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asPrincipalId } from '@epicenter/identity';
import {
	decodeBase64,
	encodeBase64,
	ROW_SYNC_ADMISSION_LIMITS,
	ROW_SYNC_PROTOCOL_MAJOR,
	rowRoundDigest,
	type SyncResponse,
	type SyncToken,
	type WireRowIntent,
} from '@epicenter/row-sync';
import * as Y from '@y/y';
import { createBunRecords } from './bun.js';
import type { Records, RecordsPartition } from './contracts.js';

const partition: RecordsPartition = {
	principalId: asPrincipalId('alice'),
	workspaceId: 'wiki',
};

const rid = (value: number) => value.toString(36).padStart(24, '0');

function setup() {
	const dir = mkdtempSync(join(tmpdir(), 'epicenter-rows-'));
	const opened = createBunRecords({ dir });
	return {
		dir,
		...opened,
		cleanup() {
			opened.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

function expectPage(
	response: SyncResponse,
): Extract<SyncResponse, { result: 'page' }> {
	if (response.result !== 'page') {
		throw new Error(`Expected a sync page: ${JSON.stringify(response)}`);
	}
	return response;
}

async function enroll(
	records: Records,
	target: RecordsPartition,
): Promise<SyncToken> {
	const response = await records.enroll(target, {
		protocolMajor: ROW_SYNC_PROTOCOL_MAJOR,
		kind: 'enroll',
	});
	if (response.result !== 'enrolled')
		throw new Error(`Enrollment failed: ${response.result}`);
	return { replicaId: response.replicaId, acceptedRound: 0, checkpoint: 0 };
}

async function syncRound(
	records: Records,
	target: RecordsPartition,
	token: SyncToken,
	intents: WireRowIntent[],
	submission: number,
) {
	return records.sync(target, {
		protocolMajor: ROW_SYNC_PROTOCOL_MAJOR,
		kind: 'sync',
		token,
		sealedRound: {
			round: token.acceptedRound + 1,
			requestDigest: rowRoundDigest(intents),
			submission,
			intents,
		},
	});
}

async function createRows(
	records: Records,
	target: RecordsPartition,
	rowIds: string[],
	firstDocumentUpdate?: string,
): Promise<SyncToken> {
	let token = await enroll(records, target);
	let submission = 0;
	for (
		let offset = 0;
		offset < rowIds.length;
		offset += ROW_SYNC_ADMISSION_LIMITS.intentsPerRound
	) {
		const intents: WireRowIntent[] = rowIds
			.slice(offset, offset + ROW_SYNC_ADMISSION_LIMITS.intentsPerRound)
			.map((rowId, index) => ({
				kind: 'create',
				table: 'pages',
				rowId,
				fields: { title: rowId },
				...(offset + index === 0 && firstDocumentUpdate !== undefined
					? { documentUpdate: firstDocumentUpdate }
					: {}),
			}));
		token = expectPage(
			await syncRound(records, target, token, intents, (submission += 1)),
		).token;
	}
	return token;
}

function documentUpdates(): [initial: string, incremental: string] {
	const document = new Y.Doc();
	try {
		const text = document.get('content');
		text.insert(0, 'hello');
		const initial = Y.encodeStateAsUpdate(document);
		const stateVector = Y.encodeStateVector(document);
		text.insert(5, ' world');
		return [
			encodeBase64(initial),
			encodeBase64(Y.encodeStateAsUpdate(document, stateVector)),
		];
	} finally {
		document.destroy();
	}
}

test('enrollment and RowIntent state survive closing and reopening', async () => {
	const context = setup();
	try {
		const [initial, incremental] = documentUpdates();
		let token = await enroll(context.records, partition);
		token = expectPage(
			await syncRound(
				context.records,
				partition,
				token,
				[
					{
						kind: 'create',
						table: 'pages',
						rowId: rid(1),
						fields: { title: 'Initial' },
						documentUpdate: initial,
					},
				],
				1,
			),
		).token;
		token = expectPage(
			await syncRound(
				context.records,
				partition,
				token,
				[
					{
						kind: 'update',
						table: 'pages',
						rowId: rid(1),
						fields: { set: { title: 'Updated' }, unset: [] },
						documentUpdate: incremental,
					},
				],
				2,
			),
		).token;
		expect(token.acceptedRound).toBe(2);
		context.close();

		const reopened = createBunRecords({ dir: context.dir });
		try {
			const baseline = await reopened.records.baselineScan(partition, {
				protocolMajor: ROW_SYNC_PROTOCOL_MAJOR,
				kind: 'baselineScan',
			});
			expect(baseline.result).toBe('page');
			if (baseline.result !== 'page') throw new Error('Expected a baseline page');
			expect(baseline.rows[0]).toMatchObject({
				table: 'pages',
				rowId: rid(1),
				fields: { title: 'Updated' },
			});
			const installed = new Y.Doc();
			try {
				for (const update of baseline.rows[0]?.document?.updates ?? []) {
					Y.applyUpdate(installed, decodeBase64(update));
				}
				expect(installed.get('content').toString()).toBe('hello world');
			} finally {
				installed.destroy();
			}
		} finally {
			reopened.close();
		}
	} finally {
		context.cleanup();
	}
});

test('principal and workspace pairs own independent authorities', async () => {
	const context = setup();
	try {
		const targets = [
			[partition, rid(1)],
			[{ principalId: asPrincipalId('bob'), workspaceId: 'wiki' }, rid(2)],
			[{ principalId: asPrincipalId('alice'), workspaceId: 'notes' }, rid(3)],
		] as const;
		for (const [target, rowId] of targets) {
			await createRows(context.records, target, [rowId]);
		}
		for (const [target, rowId] of targets) {
			const baseline = await context.records.baselineScan(target, {
				protocolMajor: ROW_SYNC_PROTOCOL_MAJOR,
				kind: 'baselineScan',
			});
			expect(baseline.result === 'page' && baseline.rows.map((row) => row.rowId)).toEqual([
				rowId,
			]);
		}
	} finally {
		context.cleanup();
	}
});

test('exact retry is idempotent and an unknown replica is refused', async () => {
	const context = setup();
	try {
		const token = await enroll(context.records, partition);
		const intents: WireRowIntent[] = [
			{
				kind: 'create',
				table: 'pages',
				rowId: rid(1),
				fields: { title: 'Retry once' },
			},
		];
		const accepted = expectPage(
			await syncRound(context.records, partition, token, intents, 1),
		);
		const retry = expectPage(
			await context.records.sync(partition, {
				protocolMajor: ROW_SYNC_PROTOCOL_MAJOR,
				kind: 'sync',
				token: accepted.token,
				sealedRound: {
					round: 1,
					requestDigest: rowRoundDigest(intents),
					submission: 2,
					intents,
				},
			}),
		);
		expect(retry).toMatchObject({
			token: { acceptedRound: 1, checkpoint: 1 },
			outcomes: [],
			submission: 2,
		});

		expect(
			await context.records.sync(partition, {
				protocolMajor: ROW_SYNC_PROTOCOL_MAJOR,
				kind: 'sync',
				token: {
					replicaId: 'unknownreplica0000000000',
					acceptedRound: 0,
					checkpoint: 0,
				},
			}),
		).toEqual({ result: 'unknown-replica' });
	} finally {
		context.cleanup();
	}
});

test('compaction requires a stale replica to page through a baseline scan', async () => {
	const context = setup();
	try {
		const rowIds = Array.from({ length: 1_001 }, (_, index) => rid(index + 1));
		const [initial] = documentUpdates();
		const token = await createRows(context.records, partition, rowIds, initial);
		const stale = await context.records.sync(partition, {
			protocolMajor: ROW_SYNC_PROTOCOL_MAJOR,
			kind: 'sync',
			token: { ...token, checkpoint: 0 },
		});
		expect(stale).toMatchObject({
			result: 'baseline-required',
			retentionFloor: 1,
		});

		const first = await context.records.baselineScan(partition, {
			protocolMajor: ROW_SYNC_PROTOCOL_MAJOR,
			kind: 'baselineScan',
			pageLimit: 1,
		});
		if (first.result !== 'page')
			throw new Error('Expected the first baseline page');
		expect(first).toMatchObject({ hasMore: true, retentionFloor: 1 });
		expect(first.rows.map((row) => row.rowId)).toEqual([rid(1)]);
		expect(first.rows[0]?.document).toMatchObject({ updates: [] });
		const compacted = new Y.Doc();
		try {
			const baseline = first.rows[0]?.document?.baseline;
			if (!baseline) throw new Error('Expected a compacted document baseline');
			Y.applyUpdate(compacted, decodeBase64(baseline));
			expect(compacted.get('content').toString()).toBe('hello');
		} finally {
			compacted.destroy();
		}

		const second = await context.records.baselineScan(partition, {
			protocolMajor: ROW_SYNC_PROTOCOL_MAJOR,
			kind: 'baselineScan',
			after: { table: 'pages', rowId: rid(1) },
			pageLimit: 1,
		});
		expect(
			second.result === 'page' && second.rows.map((row) => row.rowId),
		).toEqual([rid(2)]);
	} finally {
		context.cleanup();
	}
});
