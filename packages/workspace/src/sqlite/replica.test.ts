/**
 * SQLite Replica Runtime Tests
 *
 * Verifies the durable client half of record sync against a real SQLite
 * authority. These tests focus on identity, atomic optimistic writes, exact
 * protocol validation, convergence, and verified snapshot replacement.
 *
 * Key behaviors:
 * - Actor sequence and outbox advance in the application transaction
 * - Pull pages atomically advance the projection and durable cursor
 * - Lost acknowledgements, conflicts, tombstones, and snapshots converge
 */

import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { field } from '@epicenter/field';
import {
	createRecordAuthority,
	type Mutation,
	parsePullResponse,
	type RecordAuthority,
} from '@epicenter/record-sync';
import { createBunSqliteAdapter } from '@epicenter/record-sync/bun';
import { defineTable, defineWorkspace } from './definition.js';
import {
	createReplicaRuntime,
	type ReplicaSyncPort,
	startReplicaSyncSupervisor,
} from './replica.js';

const definition = defineWorkspace({
	id: 'replica-tests',
	name: 'Replica tests',
	epoch: 'v1',
	tables: {
		notes: defineTable({
			id: field.string(),
			title: field.string(),
			pinned: field.boolean(),
		}),
	},
});

const sha256 = async (value: string) =>
	createHash('sha256').update(value).digest('hex');

function createServer(databaseIncarnationId = 'database-1') {
	const native = new Database(':memory:');
	const envelope = {
		protocolMajor: 1,
		schemaIdentity: definition.schemaIdentity,
		databaseIncarnationId,
	};
	const authority = createRecordAuthority({
		database: createBunSqliteAdapter(native),
		envelope,
		sha256,
	});
	return { native, authority, envelope };
}

function createPort(
	authority: RecordAuthority,
	databaseIncarnationId = 'database-1',
): ReplicaSyncPort {
	return {
		bindWorkspace(workspaceId) {
			expect(workspaceId).toBe(definition.id);
		},
		async openDatabase(request) {
			expect(request).toEqual({
				workspaceId: definition.id,
				schemaIdentity: definition.schemaIdentity,
				protocolMajor: 1,
			});
			return { databaseIncarnationId };
		},
		async push(request) {
			return authority.push(request);
		},
		async pull(request) {
			return authority.pull(request);
		},
		async snapshotChunk(request) {
			return authority.snapshotChunk(request);
		},
	};
}

test('an existing replica opens and accepts writes while its authority is offline', async () => {
	const server = createServer();
	const native = new Database(':memory:');
	const first = await openReplica({
		native,
		port: createPort(server.authority),
		actorId: 'durable-actor',
	});
	first.runtime.database.tables.notes.put(note('before', 'online'));

	const offlinePort: ReplicaSyncPort = {
		bindWorkspace() {},
		async openDatabase() {
			throw new Error('offline');
		},
		async push() {
			throw new Error('offline');
		},
		async pull() {
			throw new Error('offline');
		},
		async snapshotChunk() {
			throw new Error('offline');
		},
	};
	const reopened = await openReplica({
		native,
		port: offlinePort,
		actorId: 'must-not-replace',
	});
	reopened.runtime.database.tables.notes.put(note('offline', 'still writable'));
	expect(reopened.runtime.database.tables.notes.get('offline')).toEqual(
		note('offline', 'still writable'),
	);
	expect(reopened.runtime.inspect()).toMatchObject({
		actorId: 'durable-actor',
		nextActorSequence: 3,
	});
	await expect(reopened.runtime.syncOnce()).rejects.toThrow('offline');
	native.close();
	server.native.close();
});

async function openReplica({
	native = new Database(':memory:'),
	port,
	actorId,
	pullLimit,
}: {
	native?: Database;
	port: ReplicaSyncPort;
	actorId: string;
	pullLimit?: number;
}) {
	const runtime = await createReplicaRuntime({
		definition,
		sqlite: createBunSqliteAdapter(native),
		sync: port,
		protocolMajor: 1,
		createActorId: () => actorId,
		sha256,
		onObserverError: () => {},
		pullLimit,
	});
	return { native, runtime };
}

function note(id: string, title: string, pinned = false) {
	return { id, title, pinned };
}

test('fresh bind persists actor identity and restart preserves its sequence', async () => {
	const server = createServer();
	const native = new Database(':memory:');
	const first = await openReplica({
		native,
		port: createPort(server.authority),
		actorId: 'actor-first',
	});
	first.runtime.database.tables.notes.put(note('n1', 'one'));
	expect(first.runtime.inspect()).toMatchObject({
		actorId: 'actor-first',
		nextActorSequence: 2,
		appliedServerSequence: 0,
	});

	const restarted = await openReplica({
		native,
		port: createPort(server.authority),
		actorId: 'actor-must-not-replace',
	});
	expect(restarted.runtime.inspect()).toMatchObject({
		actorId: 'actor-first',
		nextActorSequence: 2,
	});
	expect(restarted.runtime.database.tables.notes.get('n1')).toEqual(
		note('n1', 'one'),
	);
	native.close();
	server.native.close();
});

test('one application transaction creates one atomic ordered outbox mutation', async () => {
	const server = createServer();
	const { native, runtime } = await openReplica({
		port: createPort(server.authority),
		actorId: 'actor-a',
	});
	runtime.database.transact(({ tables }) => {
		tables.notes.put(note('n1', 'one'));
		tables.notes.put(note('n2', 'two', true));
	});
	const [mutation] = runtime.inspect().outbox;
	expect(mutation).toMatchObject({ actorId: 'actor-a', actorSequence: 1 });
	expect(mutation?.operations).toHaveLength(2);
	expect(runtime.inspect().nextActorSequence).toBe(2);

	native.exec(
		`CREATE TRIGGER reject_outbox BEFORE INSERT ON __epicenter_replica_outbox BEGIN SELECT RAISE(ABORT, 'reject outbox'); END`,
	);
	expect(() =>
		runtime.database.tables.notes.put(note('rollback', 'no')),
	).toThrow('reject outbox');
	expect(runtime.database.tables.notes.get('rollback')).toBeNull();
	expect(runtime.inspect().nextActorSequence).toBe(2);
	native.close();
	server.native.close();
});

test('lost push acknowledgement retries safely and own echo prunes outbox', async () => {
	const server = createServer();
	const base = createPort(server.authority);
	let loseAck = true;
	const port: ReplicaSyncPort = {
		...base,
		async push(request) {
			const response = await base.push(request);
			if (loseAck) {
				loseAck = false;
				throw new Error('connection lost');
			}
			return response;
		},
	};
	const { native, runtime } = await openReplica({ port, actorId: 'actor-a' });
	runtime.database.tables.notes.put(note('n1', 'one'));
	await expect(runtime.syncOnce()).rejects.toThrow('connection lost');
	expect(runtime.inspect().outbox).toHaveLength(1);
	await runtime.syncOnce();
	expect(runtime.inspect()).toMatchObject({
		appliedServerSequence: 1,
		outbox: [],
	});
	native.close();
	server.native.close();
});

test('two replicas converge by server order while different cells merge', async () => {
	const server = createServer();
	const a = await openReplica({
		port: createPort(server.authority),
		actorId: 'actor-a',
	});
	const b = await openReplica({
		port: createPort(server.authority),
		actorId: 'actor-b',
	});
	a.runtime.database.tables.notes.put(note('same', 'from-a'));
	b.runtime.database.tables.notes.put(note('same', 'from-b', true));
	await a.runtime.syncOnce();
	await b.runtime.syncOnce();
	await a.runtime.syncOnce();
	expect(a.runtime.database.tables.notes.get('same')).toEqual(
		note('same', 'from-b', true),
	);
	expect(b.runtime.database.tables.notes.get('same')).toEqual(
		note('same', 'from-b', true),
	);

	a.runtime.database.tables.notes.put(note('merge', 'base'));
	await a.runtime.syncOnce();
	await b.runtime.syncOnce();
	a.runtime.database.tables.notes.patch('merge', { title: 'title-a' });
	b.runtime.database.tables.notes.patch('merge', { pinned: true });
	await a.runtime.syncOnce();
	await b.runtime.syncOnce();
	await a.runtime.syncOnce();
	expect(a.runtime.database.tables.notes.get('merge')).toEqual(
		note('merge', 'title-a', true),
	);
	a.native.close();
	b.native.close();
	server.native.close();
});

test('invalid remote rows quarantine, later patches promote, and deletes remain terminal', async () => {
	const server = createServer();
	const { native, runtime } = await openReplica({
		port: createPort(server.authority),
		actorId: 'local',
	});
	const push = (mutation: Mutation) =>
		server.authority.push({
			kind: 'push',
			...server.envelope,
			mutations: [mutation],
		});
	push({
		actorId: 'remote',
		actorSequence: 1,
		operations: [
			{
				kind: 'patchRow',
				table: 'notes',
				rowId: 'n1',
				cells: { title: 'partial' },
			},
		],
	});
	await runtime.syncOnce();
	expect(runtime.database.tables.notes.get('n1')).toBeNull();
	expect(
		native.query('SELECT * FROM __epicenter_quarantine').all(),
	).toHaveLength(1);
	push({
		actorId: 'remote',
		actorSequence: 2,
		operations: [
			{
				kind: 'patchRow',
				table: 'notes',
				rowId: 'n1',
				cells: { pinned: false },
			},
		],
	});
	await runtime.syncOnce();
	expect(runtime.database.tables.notes.get('n1')).toEqual(
		note('n1', 'partial'),
	);
	push({
		actorId: 'remote',
		actorSequence: 3,
		operations: [{ kind: 'deleteRow', table: 'notes', rowId: 'n1' }],
	});
	push({
		actorId: 'remote',
		actorSequence: 4,
		operations: [
			{
				kind: 'patchRow',
				table: 'notes',
				rowId: 'n1',
				cells: { title: 'zombie' },
			},
		],
	});
	await runtime.syncOnce();
	expect(runtime.database.tables.notes.get('n1')).toBeNull();
	expect(
		native.query('SELECT * FROM __epicenter_tombstones').all(),
	).toHaveLength(1);
	native.close();
	server.native.close();
});

test('corrupt page rolls back projection and cursor together', async () => {
	const server = createServer();
	server.authority.push({
		kind: 'push',
		...server.envelope,
		mutations: [
			{
				actorId: 'remote',
				actorSequence: 1,
				operations: [
					{
						kind: 'patchRow',
						table: 'notes',
						rowId: 'n1',
						cells: { title: 'one', pinned: false },
					},
				],
			},
		],
	});
	const base = createPort(server.authority);
	const port: ReplicaSyncPort = {
		...base,
		async pull(request) {
			const response = parsePullResponse(await base.pull(request));
			if (response.ok && !response.snapshotRequired && response.mutations[0]) {
				response.mutations[0].serverSequence = 2;
				response.newCursor = 2;
			}
			return response;
		},
	};
	const { native, runtime } = await openReplica({ port, actorId: 'local' });
	await expect(runtime.syncOnce()).rejects.toThrow('contiguous server page');
	expect(runtime.inspect().appliedServerSequence).toBe(0);
	expect(runtime.database.tables.notes.get('n1')).toBeNull();
	native.close();
	server.native.close();
});

test('verified snapshot installs its high-water and prunes accepted local work', async () => {
	const server = createServer();
	const port = createPort(server.authority);
	const { native, runtime } = await openReplica({ port, actorId: 'actor-a' });
	runtime.database.tables.notes.put(note('local', 'accepted'));
	const [pending] = runtime.inspect().outbox;
	if (!pending) throw new Error('expected pending mutation');
	server.authority.push({
		kind: 'push',
		...server.envelope,
		mutations: [pending],
	});
	await server.authority.publishSnapshot({ maxChunkBytes: 512 * 1024 });
	await runtime.syncOnce();
	expect(runtime.inspect()).toMatchObject({
		appliedServerSequence: 1,
		outbox: [],
	});
	expect(runtime.database.tables.notes.get('local')).toEqual(
		note('local', 'accepted'),
	);
	native.close();
	server.native.close();
});

test('snapshot high-water cannot prune intent the authority never echoed', async () => {
	const server = createServer();
	const { native, runtime } = await openReplica({
		port: createPort(server.authority),
		actorId: 'actor-a',
	});
	runtime.database.tables.notes.put(note('local', 'pending'));
	server.authority.push({
		kind: 'push',
		...server.envelope,
		mutations: [
			{
				actorId: 'actor-a',
				actorSequence: 1,
				operations: [
					{
						kind: 'patchRow',
						table: 'notes',
						rowId: 'collision-1',
						cells: { title: 'one', pinned: false },
					},
				],
			},
			{
				actorId: 'actor-a',
				actorSequence: 2,
				operations: [
					{
						kind: 'patchRow',
						table: 'notes',
						rowId: 'collision-2',
						cells: { title: 'two', pinned: false },
					},
				],
			},
		],
	});
	await server.authority.publishSnapshot({ maxChunkBytes: 512 * 1024 });

	await expect(runtime.syncOnce()).rejects.toThrow(
		'actor high-water contradicts local intent',
	);
	expect(runtime.inspect().outbox).toHaveLength(1);
	expect(runtime.database.tables.notes.get('local')).toEqual(
		note('local', 'pending'),
	);
	native.close();
	server.native.close();
});

test('actor sequence exhaustion rolls back the application write', async () => {
	const server = createServer();
	const { native, runtime } = await openReplica({
		port: createPort(server.authority),
		actorId: 'actor-a',
	});
	native
		.query(
			'UPDATE __epicenter_replica SET next_actor_sequence = ? WHERE id = 1',
		)
		.run(Number.MAX_SAFE_INTEGER);

	expect(() =>
		runtime.database.tables.notes.put(note('too-late', 'rolled back')),
	).toThrow('actor sequence is exhausted');
	expect(runtime.database.tables.notes.get('too-late')).toBeNull();
	expect(runtime.inspect().outbox).toEqual([]);
	native.close();
	server.native.close();
});

test('restart opens locally but refuses to sync a different authority incarnation', async () => {
	const firstServer = createServer('database-1');
	const native = new Database(':memory:');
	await openReplica({
		native,
		port: createPort(firstServer.authority, 'database-1'),
		actorId: 'actor-a',
	});
	const replacement = createServer('database-2');
	const restarted = await openReplica({
		native,
		port: createPort(replacement.authority, 'database-2'),
		actorId: 'actor-b',
	});
	await expect(restarted.runtime.syncOnce()).rejects.toThrow(
		'database incarnation',
	);
	native.close();
	firstServer.native.close();
	replacement.native.close();
});

test('sync supervisor retries failures and aborts in-flight disposal', async () => {
	let attempts = 0;
	let activeSignal: AbortSignal | undefined;
	const errors: unknown[] = [];
	const supervisor = startReplicaSyncSupervisor(
		{
			async syncOnce(signal) {
				attempts++;
				activeSignal = signal;
				if (attempts === 1) throw new Error('offline');
				await new Promise<void>((_resolve, reject) => {
					signal?.addEventListener('abort', () => reject(signal.reason), {
						once: true,
					});
				});
			},
		},
		{
			onError: (error) => errors.push(error),
			pollIntervalMs: 0,
			retryDelaysMs: [0],
		},
	);

	supervisor.request();
	await waitFor(() => attempts === 2);
	await supervisor.dispose();

	expect(activeSignal?.aborted).toBe(true);
	expect(errors).toHaveLength(1);
});

async function waitFor(check: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (check()) return;
		await Bun.sleep(1);
	}
	throw new Error('Timed out waiting for replica test condition');
}
