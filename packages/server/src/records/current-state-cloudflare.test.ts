/**
 * Current-State Durable Object Records Tests
 *
 * Verifies current-state operations across the Durable Object RPC boundary.
 *
 * Key behaviors:
 * - first-push registration and lookup cross the RPC boundary
 * - accepted state and receipts survive object restart
 * - authenticated partitions select independent object names
 * - push, pull, and acquire cross the RPC boundary unchanged
 * - failed initialization leaves storage retryable
 */

import { Database } from 'bun:sqlite';
import { expect, mock, test } from 'bun:test';
import { asPrincipalId } from '@epicenter/identity';
import {
	CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
	type CurrentStateWireRowIntent,
	rowRoundDigest,
} from '@epicenter/row-sync';
import type { CurrentStateRecordsPartition } from './current-state-contracts.js';

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
				get databaseSize() {
					return 0;
				},
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
	const {
		CurrentStateRowAuthorityDurableObject,
		createCurrentStateDurableObjectDocuments,
		createCurrentStateDurableObjectRecords,
		readCurrentStateAccountDatabaseSize,
	} = await import('./current-state-cloudflare.js');
	type RowObject = InstanceType<typeof CurrentStateRowAuthorityDurableObject>;
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
			const object = new CurrentStateRowAuthorityDurableObject(
				{
					storage: storage.storage,
					getWebSockets: () => [],
				} as unknown as DurableObjectState,
				{} as Cloudflare.Env,
			);
			objects.set(name, { storage, object });
			return object;
		},
	};
	return {
		names,
		objects,
		namespace,
		records: createCurrentStateDurableObjectRecords(
			namespace as unknown as DurableObjectNamespace<RowObject>,
		),
		CurrentStateRowAuthorityDurableObject,
		createCurrentStateDurableObjectDocuments,
		readCurrentStateAccountDatabaseSize,
		cleanup() {
			for (const owned of objects.values()) owned.storage.database.close();
			objects.clear();
		},
	};
}

const partition: CurrentStateRecordsPartition = {
	principalId: asPrincipalId('alice'),
	workspaceId: 'wiki',
};

const rid = (value: number) => value.toString(36).padStart(24, '0');

function pushRequest(replicaId: string, intents: CurrentStateWireRowIntent[]) {
	return {
		protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
		kind: 'push' as const,
		replicaId,
		round: 1,
		requestDigest: rowRoundDigest(intents),
		intents,
	};
}

test('hasReplica observes first-push registration across RPC', async () => {
	const context = await setup();
	try {
		expect(await context.records.hasReplica(partition, rid(100))).toBe(false);
		const intents = [
			{ kind: 'create', table: 'pages', rowId: rid(1), fields: { n: 1 } },
		] satisfies CurrentStateWireRowIntent[];
		const accepted = await context.records.push(
			partition,
			pushRequest(rid(100), intents),
		);
		expect(await context.records.hasReplica(partition, rid(100))).toBe(true);
		expect(
			await context.records.push(partition, pushRequest(rid(100), intents)),
		).toEqual(accepted);
	} finally {
		context.cleanup();
	}
});

test('accepted state and receipt survive Durable Object restart', async () => {
	const context = await setup();
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
		const accepted = await context.records.push(
			partition,
			pushRequest(replicaId, intents),
		);
		const name = context.names[0];
		if (!name) throw new Error('Expected a Durable Object name');
		const owned = context.objects.get(name);
		if (!owned) throw new Error('Expected a Durable Object instance');
		owned.object = new context.CurrentStateRowAuthorityDurableObject(
			{
				storage: owned.storage.storage,
				getWebSockets: () => [],
			} as unknown as DurableObjectState,
			{} as Cloudflare.Env,
		);

		expect(
			await context.records.push(partition, pushRequest(replicaId, intents)),
		).toEqual(accepted);
		expect(
			await context.records.acquire(partition, {
				protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
				kind: 'acquire',
				replicaId,
			}),
		).toMatchObject({
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
		context.cleanup();
	}
});

test('push, fixed pull, and acquire cross RPC unchanged', async () => {
	const context = await setup();
	try {
		const replicaId = rid(100);
		const intents: CurrentStateWireRowIntent[] = [
			{
				kind: 'create',
				table: 'pages',
				rowId: rid(1),
				fields: { title: 'Hello' },
			},
		];
		const pushed = await context.records.push(
			partition,
			pushRequest(replicaId, intents),
		);
		expect(pushed).toMatchObject({
			result: 'accepted',
			receipt: { acceptedRound: 1, appliedThrough: 1 },
		});
		expect(
			await context.records.pull(partition, {
				protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
				kind: 'pull',
				replicaId,
				after: 0,
			}),
		).toMatchObject({
			result: 'page',
			through: 1,
			checkpoint: 1,
			entries: [{ kind: 'row', fields: { title: 'Hello' } }],
		});
		expect(
			await context.records.acquire(partition, {
				protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
				kind: 'acquire',
				replicaId,
			}),
		).toMatchObject({ result: 'page', head: 1 });
	} finally {
		context.cleanup();
	}
});

test('principal alone determines the object name for every workspace', async () => {
	const context = await setup();
	try {
		for (const target of [
			partition,
			{ principalId: asPrincipalId('bob'), workspaceId: 'wiki' },
			{ principalId: asPrincipalId('alice'), workspaceId: 'notes' },
		]) {
			await context.records.hasReplica(target, rid(100));
		}
		expect(new Set(context.names)).toEqual(new Set(['alice', 'bob']));
		expect(
			await context.readCurrentStateAccountDatabaseSize(
				context.namespace as unknown as DurableObjectNamespace<
					InstanceType<typeof context.CurrentStateRowAuthorityDurableObject>
				>,
				partition.principalId,
			),
		).toBe(0);
	} finally {
		context.cleanup();
	}
});

test('document upgrade sends workspace identity to the principal object', async () => {
	const context = await setup();
	let objectName: string | undefined;
	let forwarded: Request | undefined;
	const namespace = {
		getByName(name: string) {
			objectName = name;
			return {
				fetch(request: Request) {
					forwarded = request;
					return new Response(null, { status: 204 });
				},
			};
		},
	};
	try {
		const documents = context.createCurrentStateDurableObjectDocuments(
			namespace as unknown as DurableObjectNamespace<
				InstanceType<typeof context.CurrentStateRowAuthorityDurableObject>
			>,
		);
		await documents.handleUpgrade({
			partition,
			address: { table: 'pages', rowId: rid(1) },
			authorizationExpiresAt: Date.now() + 60_000,
			request: new Request('https://example.test/document', {
				headers: { upgrade: 'websocket' },
			}),
		});

		expect(objectName).toBe('alice');
		expect(forwarded?.headers.get('x-epicenter-document-workspace')).toBe(
			'wiki',
		);
		expect(forwarded?.headers.get('x-epicenter-document-table')).toBe('pages');
		expect(forwarded?.headers.get('x-epicenter-document-row')).toBe(rid(1));
	} finally {
		context.cleanup();
	}
});

test('one principal object deletes one workspace without deleting its siblings', async () => {
	const context = await setup();
	const notes = { ...partition, workspaceId: 'notes' };
	try {
		await context.records.push(
			partition,
			pushRequest(rid(100), [
				{ kind: 'create', table: 'pages', rowId: rid(1), fields: { n: 1 } },
			]),
		);
		await context.records.push(
			notes,
			pushRequest(rid(100), [
				{ kind: 'create', table: 'pages', rowId: rid(2), fields: { n: 2 } },
			]),
		);
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
		expect(new Set(context.names)).toEqual(new Set(['alice']));
	} finally {
		context.cleanup();
	}
});

test('workspace deletion closes hibernating sockets before their handshake', async () => {
	const context = await setup();
	const owned = createStorage();
	const closes: { code: number; reason: string }[] = [];
	const socket = {
		readyState: WebSocket.OPEN,
		deserializeAttachment() {
			return {
				version: 1,
				workspaceId: 'wiki',
				table: 'pages',
				rowId: rid(1),
				acceptedAt: Date.now(),
				authorizationExpiresAt: Date.now() + 60_000,
				connected: false,
			};
		},
		close(code: number, reason: string) {
			closes.push({ code, reason });
		},
	};
	try {
		const object = new context.CurrentStateRowAuthorityDurableObject(
			{
				storage: owned.storage,
				getWebSockets: () => [socket as unknown as WebSocket],
			} as unknown as DurableObjectState,
			{} as Cloudflare.Env,
		);
		await object.deleteWorkspace('wiki');
		expect(closes).toEqual([{ code: 1000, reason: 'not-live' }]);
	} finally {
		owned.database.close();
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
				new context.CurrentStateRowAuthorityDurableObject(
					{
						storage: owned.storage,
						getWebSockets: () => [],
					} as unknown as DurableObjectState,
					{} as Cloudflare.Env,
				),
		).toThrow('injected initialization failure');
		const retried = new context.CurrentStateRowAuthorityDurableObject(
			{
				storage: owned.storage,
				getWebSockets: () => [],
			} as unknown as DurableObjectState,
			{} as Cloudflare.Env,
		);
		expect(await retried.hasReplica('wiki', rid(100))).toBe(false);
	} finally {
		owned.database.close();
		context.cleanup();
	}
});
