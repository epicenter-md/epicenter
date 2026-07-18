/**
 * Current-State Bun Records Tests
 *
 * Verifies persistent partitioned authorities through the new Bun backend.
 *
 * Key behaviors:
 * - first push registers a client-owned retry identity idempotently
 * - accepted current state and receipts survive backend reopen
 * - principal and workspace pairs own independent SQLite authorities
 * - accepted pushes compact to the predictable retained sequence window
 * - first open deletes the authorized legacy authority tables
 */

import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asPrincipalId } from '@epicenter/identity';
import {
	CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
	type CurrentStateWireRowIntent,
	rowRoundDigest,
} from '@epicenter/row-sync';
import type { BunWorkspaceDocumentSocketData } from './current-state-bun.js';
import { createCurrentStateBunRecords } from './current-state-bun.js';
import type {
	CurrentStateRecords,
	CurrentStateRecordsPartition,
} from './current-state-contracts.js';

const partition: CurrentStateRecordsPartition = {
	principalId: asPrincipalId('alice'),
	workspaceId: 'wiki',
};

const rid = (value: number) => value.toString(36).padStart(24, '0');

function setup() {
	const dir = mkdtempSync(join(tmpdir(), 'epicenter-current-rows-'));
	const opened = createCurrentStateBunRecords({ dir });
	return {
		dir,
		...opened,
		cleanup() {
			opened.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

async function push(
	records: CurrentStateRecords,
	target: CurrentStateRecordsPartition,
	replicaId: string,
	round: number,
	intents: CurrentStateWireRowIntent[],
) {
	return records.push(target, {
		protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
		kind: 'push',
		replicaId,
		round,
		requestDigest: rowRoundDigest(intents),
		intents,
	});
}

test('hasReplica observes first-push registration', async () => {
	const context = setup();
	try {
		expect(await context.records.hasReplica(partition, rid(100))).toBe(false);
		const intents = [
			{ kind: 'create', table: 'pages', rowId: rid(1), fields: { n: 1 } },
		] satisfies CurrentStateWireRowIntent[];
		const accepted = await push(
			context.records,
			partition,
			rid(100),
			1,
			intents,
		);
		expect(await context.records.hasReplica(partition, rid(100))).toBe(true);
		expect(
			await push(context.records, partition, rid(100), 1, intents),
		).toEqual(accepted);
	} finally {
		context.cleanup();
	}
});

test('accepted state and receipts survive closing and reopening', async () => {
	const context = setup();
	try {
		const replicaId = rid(100);
		const intents: CurrentStateWireRowIntent[] = [
			{
				kind: 'create',
				table: 'pages',
				rowId: rid(1),
				fields: { title: 'Persisted' },
			},
		];
		const accepted = await push(
			context.records,
			partition,
			replicaId,
			1,
			intents,
		);
		expect(accepted).toMatchObject({
			result: 'accepted',
			receipt: { acceptedRound: 1, appliedThrough: 1 },
		});
		context.close();

		const reopened = createCurrentStateBunRecords({ dir: context.dir });
		try {
			expect(
				await reopened.records.push(partition, {
					protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
					kind: 'push',
					replicaId,
					round: 1,
					requestDigest: rowRoundDigest(intents),
					intents,
				}),
			).toEqual(accepted);
			const acquired = await reopened.records.acquire(partition, {
				protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
				kind: 'acquire',
				replicaId,
			});
			expect(acquired).toMatchObject({
				result: 'page',
				rows: [
					{
						table: 'pages',
						rowId: rid(1),
						fields: { title: 'Persisted' },
					},
				],
			});
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
			const replicaId = rid(100);
			await push(context.records, target, replicaId, 1, [
				{
					kind: 'create',
					table: 'pages',
					rowId,
					fields: { title: rowId },
				},
			]);
		}
		for (const [target, rowId] of targets) {
			const replicaId = rid(100);
			const acquired = await context.records.acquire(target, {
				protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
				kind: 'acquire',
				replicaId,
			});
			expect(
				acquired.result === 'page' && acquired.rows.map((row) => row.rowId),
			).toEqual([rowId]);
		}
	} finally {
		context.cleanup();
	}
});

test('workspaces under one principal share one database and delete independently', async () => {
	const context = setup();
	const notes = { ...partition, workspaceId: 'notes' };
	try {
		await push(context.records, partition, rid(100), 1, [
			{ kind: 'create', table: 'pages', rowId: rid(1), fields: { n: 1 } },
		]);
		await push(context.records, notes, rid(100), 1, [
			{ kind: 'create', table: 'pages', rowId: rid(2), fields: { n: 2 } },
		]);

		expect(
			readdirSync(join(context.dir, 'principals', 'alice')).filter((name) =>
				name.endsWith('.sqlite'),
			),
		).toEqual(['authority.sqlite']);
		await context.records.deleteWorkspace(partition);
		expect(await context.records.hasReplica(partition, rid(100))).toBe(false);
		expect(
			await context.records.acquire(notes, {
				protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
				kind: 'acquire',
				replicaId: rid(100),
			}),
		).toMatchObject({
			result: 'page',
			rows: [{ rowId: rid(2), fields: { n: 2 } }],
		});
	} finally {
		context.cleanup();
	}
});

test('workspace deletion closes upgraded document sockets before their handshake', async () => {
	const context = setup();
	const closes: { code: number; reason: string }[] = [];
	const socket = {
		data: {
			surface: 'workspace-document',
			kind: 'document',
			partition,
			address: { table: 'pages', rowId: rid(1) },
			authorizationExpiresAt: Date.now() + 60_000,
			connected: false,
		} satisfies BunWorkspaceDocumentSocketData,
		close(code: number, reason: string) {
			closes.push({ code, reason });
		},
	};
	try {
		context.websocket.open?.(socket as never);
		await context.records.deleteWorkspace(partition);
		expect(closes).toEqual([{ code: 1000, reason: 'not-live' }]);
	} finally {
		context.cleanup();
	}
});

test('partition components cannot escape their principal directory', async () => {
	const context = setup();
	try {
		await context.records.hasReplica(
			{
				principalId: asPrincipalId('..'),
				workspaceId: '..',
			},
			rid(100),
		);
		expect(readdirSync(join(context.dir, 'principals'))).toEqual(['%2E%2E']);
		expect(readdirSync(join(context.dir, 'principals', '%2E%2E'))).toContain(
			'authority.sqlite',
		);
	} finally {
		context.cleanup();
	}
});

test('accepted pushes retain the newest one thousand sequences', async () => {
	const context = setup();
	try {
		const replicaId = rid(100);
		let round = 0;
		let remaining = 1_001;
		while (remaining > 0) {
			const count = Math.min(64, remaining);
			const intents = Array.from(
				{ length: count },
				(): CurrentStateWireRowIntent => ({
					kind: 'update',
					table: 'pages',
					rowId: rid(999),
					fields: { set: { absent: true }, unset: [] },
				}),
			);
			round += 1;
			const response = await push(
				context.records,
				partition,
				replicaId,
				round,
				intents,
			);
			expect(response.result).toBe('accepted');
			remaining -= count;
		}

		expect(
			await context.records.pull(partition, {
				protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
				kind: 'pull',
				replicaId,
				after: 0,
			}),
		).toMatchObject({
			result: 'acquisition-required',
			retentionFloor: 1,
		});
	} finally {
		context.cleanup();
	}
});

test('first authority open deletes legacy authority tables', async () => {
	const context = setup();
	try {
		context.close();
		const principalDir = join(context.dir, 'principals', 'alice');
		mkdirSync(principalDir, { recursive: true });
		const filename = join(principalDir, 'authority.sqlite');
		const database = new Database(filename);
		database.run('CREATE TABLE row_sync_meta (id INTEGER PRIMARY KEY)');
		database.run('INSERT INTO row_sync_meta(id) VALUES (1)');
		database.close();

		const reopened = createCurrentStateBunRecords({ dir: context.dir });
		try {
			await reopened.records.hasReplica(partition, rid(100));
		} finally {
			reopened.close();
		}

		const inspected = new Database(filename, {
			readonly: true,
		});
		try {
			expect(
				inspected
					.query<{ name: string }, []>(
						"SELECT name FROM sqlite_master WHERE name = 'row_sync_meta'",
					)
					.all(),
			).toEqual([]);
			expect(
				inspected
					.query<{ name: string }, []>(
						"SELECT name FROM sqlite_master WHERE name = 'row_authority_meta'",
					)
					.all(),
			).toEqual([{ name: 'row_authority_meta' }]);
		} finally {
			inspected.close();
		}
	} finally {
		context.cleanup();
	}
});
