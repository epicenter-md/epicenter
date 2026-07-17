/**
 * Cloudflare Row Backend Tests
 *
 * Verifies RowIntent sync through the Durable Object RPC and SQLite adapters.
 *
 * Key behaviors:
 * - enrollment and accepted rounds survive object restart
 * - authenticated partitions map to independent Durable Object names
 * - exact retry, unknown-replica refusal, and baseline paging cross RPC
 */

import { Database } from 'bun:sqlite';
import { expect, mock, test } from 'bun:test';
import { asPrincipalId } from '@epicenter/identity';
import {
	ROW_SYNC_ADMISSION_LIMITS,
	ROW_SYNC_PROTOCOL_MAJOR,
	rowRoundDigest,
	type SyncResponse,
	type SyncToken,
	type WireRowIntent,
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
				return database.transaction(run).immediate();
			},
		} as unknown as DurableObjectStorage,
	};
}

async function setup() {
	const { RowAuthorityDurableObject, createDurableObjectRecords } =
		await import('./cloudflare.js');
	type RowObject = InstanceType<typeof RowAuthorityDurableObject>;
	const objects = new Map<
		string,
		{ storage: ReturnType<typeof createStorage>; object: RowObject }
	>();
	const names: string[] = [];
	const namespace = {
		getByName(name: string) {
			names.push(name);
			const existing = objects.get(name);
			if (existing) return existing.object;
			const storage = createStorage();
			const object = new RowAuthorityDurableObject(
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
			namespace as unknown as DurableObjectNamespace<RowObject>,
		),
		RowAuthorityDurableObject,
		cleanup() {
			for (const owned of objects.values()) owned.storage.database.close();
			objects.clear();
		},
	};
}

const partition: RecordsPartition = {
	principalId: asPrincipalId('alice'),
	workspaceId: 'wiki',
};

const rid = (value: number) => value.toString(36).padStart(24, '0');

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
			.map((rowId) => ({
				kind: 'create',
				table: 'pages',
				rowId,
				fields: { title: rowId },
			}));
		token = expectPage(
			await syncRound(records, target, token, intents, (submission += 1)),
		).token;
	}
	return token;
}

test('enrollment and accepted state survive Durable Object restart', async () => {
	const context = await setup();
	try {
		const token = await enroll(context.records, partition);
		expectPage(
			await syncRound(
				context.records,
				partition,
				token,
				[
					{
						kind: 'create',
						table: 'pages',
						rowId: rid(1),
						fields: { title: 'Persisted' },
					},
				],
				1,
			),
		);

		const name = context.names[0];
		if (!name) throw new Error('Expected a Durable Object name');
		const owned = context.objects.get(name);
		if (!owned) throw new Error('Expected a Durable Object instance');
		owned.object = new context.RowAuthorityDurableObject(
			{ storage: owned.storage.storage } as DurableObjectState,
			{} as Cloudflare.Env,
		);

		const baseline = await context.records.baselineScan(partition, {
			protocolMajor: ROW_SYNC_PROTOCOL_MAJOR,
			kind: 'baselineScan',
		});
		expect(baseline.result === 'page' && baseline.rows).toEqual([
			{
				table: 'pages',
				rowId: rid(1),
				fields: { title: 'Persisted' },
			},
		]);
	} finally {
		context.cleanup();
	}
});

test('failed construction leaves Durable Object storage retryable', async () => {
	const context = await setup();
	const owned = createStorage();
	try {
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
				new context.RowAuthorityDurableObject(
					{ storage: owned.storage } as DurableObjectState,
					{} as Cloudflare.Env,
				),
		).toThrow('injected initialization failure');
		const retried = new context.RowAuthorityDurableObject(
			{ storage: owned.storage } as DurableObjectState,
			{} as Cloudflare.Env,
		);
		expect(
			await retried.enroll({
				protocolMajor: ROW_SYNC_PROTOCOL_MAJOR,
				kind: 'enroll',
			}),
		).toMatchObject({ result: 'enrolled' });
	} finally {
		owned.database.close();
		context.cleanup();
	}
});

test('authenticated principal and workspace pair determine object identity', async () => {
	const context = await setup();
	try {
		await context.records.baselineScan(partition, {
			protocolMajor: ROW_SYNC_PROTOCOL_MAJOR,
			kind: 'baselineScan',
		});
		await context.records.baselineScan(
			{ principalId: asPrincipalId('bob'), workspaceId: 'wiki' },
			{ protocolMajor: ROW_SYNC_PROTOCOL_MAJOR, kind: 'baselineScan' },
		);
		await context.records.baselineScan(
			{ principalId: asPrincipalId('alice'), workspaceId: 'notes' },
			{ protocolMajor: ROW_SYNC_PROTOCOL_MAJOR, kind: 'baselineScan' },
		);

		expect(new Set(context.names)).toEqual(
			new Set(['["alice","wiki"]', '["bob","wiki"]', '["alice","notes"]']),
		);
	} finally {
		context.cleanup();
	}
});

test('exact retry is idempotent and an unknown replica is refused', async () => {
	const context = await setup();
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

test('compaction requires stale RPC clients to page through a baseline scan', async () => {
	const context = await setup();
	try {
		const rowIds = Array.from({ length: 1_001 }, (_, index) => rid(index + 1));
		const token = await createRows(context.records, partition, rowIds);
		expect(
			await context.records.sync(partition, {
				protocolMajor: ROW_SYNC_PROTOCOL_MAJOR,
				kind: 'sync',
				token: { ...token, checkpoint: 0 },
			}),
		).toMatchObject({
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
		expect(first.rows.map((row) => row.rowId)).toEqual([rid(1)]);
		expect(first.hasMore).toBe(true);

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
