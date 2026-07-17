/**
 * Cloudflare Record Backend Tests
 *
 * Verifies wire-v5 sync through the Durable Object RPC and SQLite adapters.
 *
 * Key behaviors:
 * - accepted state survives object restart and failed construction is retryable
 * - authenticated partitions map to independent Durable Object names
 * - accepted sealed rounds trigger snapshots served through snapshotChunk
 */

import { Database } from 'bun:sqlite';
import { expect, mock, test } from 'bun:test';
import { asPrincipalId } from '@epicenter/identity';
import {
	recordRoundDigest,
	RECORD_SYNC_ADMISSION_LIMITS,
	RECORD_SYNC_PROTOCOL_MAJOR,
	type RecordCommand,
	type SyncResponse,
	type SyncToken,
} from '@epicenter/row-sync';
import type { Records, RecordsPartition } from './contracts.js';

mock.module('cloudflare:workers', () => ({
	DurableObject: class {
		protected ctx: DurableObjectState;

		constructor(ctx: DurableObjectState, _env: Cloudflare.Env) {
			this.ctx = ctx;
		}
	},
}));

type SqlValue = ArrayBuffer | string | number | null;

function createStorage() {
	const database = new Database(':memory:', { strict: true });
	return {
		database,
		storage: {
			sql: {
				exec<TRow extends Record<string, SqlValue>>(
					sql: string,
					...bindings: SqlValue[]
				) {
					const statements = sql.split(';').filter((part) => part.trim());
					if (statements.length > 1) {
						database.exec(sql);
						return { toArray: () => [] as TRow[] };
					}
					const values = bindings.map((value) =>
						value instanceof ArrayBuffer ? new Uint8Array(value) : value,
					);
					const query = database.query<
						TRow,
						(string | number | null | Uint8Array)[]
					>(sql);
					if (/^\s*(SELECT|WITH|PRAGMA)\b/i.test(sql)) {
						return { toArray: () => query.all(...values) };
					}
					query.run(...values);
					return { toArray: () => [] as TRow[] };
				},
			},
			transactionSync<TResult>(run: () => TResult): TResult {
				return database.transaction(run)();
			},
		} as unknown as DurableObjectStorage,
	};
}

async function setup() {
	const { RecordAuthorityDurableObject, createDurableObjectRecords } =
		await import('./cloudflare.js');
	const objects = new Map<
		string,
		{
			storage: ReturnType<typeof createStorage>;
			object: InstanceType<typeof RecordAuthorityDurableObject>;
		}
	>();
	const names: string[] = [];
	const namespace = {
		getByName(name: string) {
			names.push(name);
			const existing = objects.get(name);
			if (existing) return existing.object;
			const storage = createStorage();
			const object = new RecordAuthorityDurableObject(
				{ storage: storage.storage } as DurableObjectState,
				{} as Cloudflare.Env,
			);
			objects.set(name, { storage, object });
			return object;
		},
	};
	return {
		names,
		objects,
		records: createDurableObjectRecords(
			namespace as unknown as DurableObjectNamespace<
				InstanceType<typeof RecordAuthorityDurableObject>
			>,
		),
		RecordAuthorityDurableObject,
	};
}

const partition: RecordsPartition = {
	principalId: asPrincipalId('alice'),
	workspaceId: 'wiki',
};

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
		nextToken = expectPage(
			await syncRound(records, target, nextToken, commands),
		).token;
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

test('current state survives Durable Object restart without an open handshake', async () => {
	const context = await setup();
	expect(
		(await createRows(context.records, partition, 'replica-1', ['page-1']))
			.acceptedRound,
	).toBe(1);

	const name = context.names[0];
	if (!name) throw new Error('Expected a Durable Object name');
	const owned = context.objects.get(name);
	if (!owned) throw new Error('Expected a Durable Object instance');
	owned.object = new context.RecordAuthorityDurableObject(
		{ storage: owned.storage.storage } as DurableObjectState,
		{} as Cloudflare.Env,
	);

	const page = expectPage(await readFromStart(context.records, partition));
	expect(page.entries).toEqual([
		expect.objectContaining({ rowId: 'page-1', value: { title: 'page-1' } }),
	]);
});

test('failed construction leaves Durable Object storage retryable', async () => {
	const { RecordAuthorityDurableObject } = await setup();
	const owned = createStorage();
	const storage = owned.storage as unknown as {
		transactionSync<TResult>(run: () => TResult): TResult;
	};
	const transactionSync = storage.transactionSync.bind(storage);
	let failNextTransaction = true;
	storage.transactionSync = <TResult>(run: () => TResult): TResult => {
		if (failNextTransaction) {
			failNextTransaction = false;
			throw new Error('injected initialization failure');
		}
		return transactionSync(run);
	};

	expect(
		() =>
			new RecordAuthorityDurableObject(
				{ storage: owned.storage } as DurableObjectState,
				{} as Cloudflare.Env,
			),
	).toThrow('injected initialization failure');
	const retried = new RecordAuthorityDurableObject(
		{ storage: owned.storage } as DurableObjectState,
		{} as Cloudflare.Env,
	);
	const command: RecordCommand = {
		kind: 'createRow',
		table: 'pages',
		rowId: 'page-1',
		value: { title: 'page-1' },
	};
	expect(
		(
			await retried.sync({
				protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
				kind: 'sync',
				token: token('replica-1'),
				sealedRound: {
					round: 1,
					requestDigest: recordRoundDigest([command]),
					commands: [command],
				},
			})
		).ok,
	).toBe(true);
});

test('authenticated principal and workspace pair determine object identity', async () => {
	const { names, records } = await setup();
	await readFromStart(records, partition);
	await readFromStart(records, {
		principalId: asPrincipalId('bob'),
		workspaceId: 'wiki',
	});
	await readFromStart(records, {
		principalId: asPrincipalId('alice'),
		workspaceId: 'notes',
	});

	expect(new Set(names)).toEqual(
		new Set(['["alice","wiki"]', '["bob","wiki"]', '["alice","notes"]']),
	);
});

test('production compaction serves a bounded snapshot to stale checkpoints', async () => {
	const { records } = await setup();
	const nextToken = await createRows(
		records,
		partition,
		'replica-compact',
		Array.from({ length: 1_000 }, (_, index) => `page-${index}`),
	);
	expect(
		expectPage(
			await syncRound(records, partition, nextToken, [
				{
					kind: 'createRow',
					table: 'pages',
					rowId: 'last',
					value: { title: 'last' },
				},
			]),
		).token.acceptedRound,
	).toBe(nextToken.acceptedRound + 1);

	const stale = await readFromStart(records, partition);
	expect(stale.ok && stale.snapshotRequired).toBe(true);
	if (!stale.ok || !stale.snapshotRequired)
		throw new Error('Expected snapshot');
	expect(
		await records.snapshotChunk(partition, {
			protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
			kind: 'snapshotChunk',
			generation: stale.manifest.generation,
			index: 0,
		}),
	).toMatchObject({ kind: 'snapshotChunk', ok: true });
});
