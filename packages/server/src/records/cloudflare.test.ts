import { Database } from 'bun:sqlite';
import { expect, mock, test } from 'bun:test';
import { asPrincipalId } from '@epicenter/identity';
import { RECORD_SYNC_PROTOCOL_MAJOR } from '@epicenter/record-sync';

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

const partition = {
	principalId: asPrincipalId('alice'),
	workspaceId: 'wiki',
};

function createRequest(actorId: string, actorSequence: number, rowId: string) {
	return {
		protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
		kind: 'push' as const,
		actorId,
		mutations: [
			{
				actorSequence,
				command: {
					kind: 'createRow' as const,
					table: 'pages',
					rowId,
					value: { title: rowId },
				},
			},
		],
	};
}

test('current state survives Durable Object restart without an open handshake', async () => {
	const context = await setup();
	expect(
		(
			await context.records.push(
				partition,
				createRequest('actor-1', 1, 'page-1'),
			)
		).ok,
	).toBe(true);

	const name = context.names[0];
	if (!name) throw new Error('Expected a Durable Object name');
	const owned = context.objects.get(name);
	if (!owned) throw new Error('Expected a Durable Object instance');
	owned.object = new context.RecordAuthorityDurableObject(
		{ storage: owned.storage.storage } as DurableObjectState,
		{} as Cloudflare.Env,
	);

	const pulled = await context.records.pull(partition, {
		protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
		kind: 'pull',
		cursor: 0,
		limit: 100,
	});
	expect(pulled.ok && !pulled.snapshotRequired && pulled.entries).toEqual([
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
	expect((await retried.push(createRequest('actor-1', 1, 'page-1'))).ok).toBe(
		true,
	);
});

test('authenticated principal and workspace pair determine object identity', async () => {
	const { names, records } = await setup();
	await records.pull(partition, {
		protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
		kind: 'pull',
		cursor: 0,
		limit: 1,
	});
	await records.pull(
		{ principalId: asPrincipalId('bob'), workspaceId: 'wiki' },
		{
			protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
			kind: 'pull',
			cursor: 0,
			limit: 1,
		},
	);
	await records.pull(
		{ principalId: asPrincipalId('alice'), workspaceId: 'notes' },
		{
			protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
			kind: 'pull',
			cursor: 0,
			limit: 1,
		},
	);

	expect(new Set(names)).toEqual(
		new Set(['["alice","wiki"]', '["bob","wiki"]', '["alice","notes"]']),
	);
});

test('production compaction serves a bounded snapshot to stale cursors', async () => {
	const { records } = await setup();
	expect(
		(
			await records.push(partition, {
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
			})
		).ok,
	).toBe(true);
	expect(
		(
			await records.push(
				partition,
				createRequest('actor-compact', 1_001, 'last'),
			)
		).ok,
	).toBe(true);
	const pulled = await records.pull(partition, {
		protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
		kind: 'pull',
		cursor: 0,
		limit: 100,
	});
	expect(pulled.ok && pulled.snapshotRequired).toBe(true);
	if (!pulled.ok || !pulled.snapshotRequired)
		throw new Error('Expected snapshot');
	expect(
		await records.snapshotChunk(partition, {
			protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
			kind: 'snapshotChunk',
			generation: pulled.manifest.generation,
			index: 0,
		}),
	).toMatchObject({ kind: 'snapshotChunk', ok: true });
});
