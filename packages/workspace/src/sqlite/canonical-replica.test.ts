/**
 * Canonical Record Replica Tests
 *
 * Verifies the private file-owned actor, durable outbox, exact push retry,
 * current-state pull installation, and below-floor snapshot recovery.
 *
 * Key behaviors:
 * - optimistic records and contiguous outbox intent commit atomically
 * - uncertain pushes retry the exact sealed batch after process restart
 * - snapshots preserve accepted-after-head and newly pending local intent
 * - pulled schema-opaque state never creates local outbox commands
 */

import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { field } from '@epicenter/field';
import {
	createSnapshotManifest,
	openRecordAuthority,
	type PushRequest,
	RECORD_SYNC_ADMISSION_LIMITS,
	RECORD_SYNC_PROTOCOL_MAJOR,
} from '@epicenter/record-sync';
import { createBunSqliteAdapter } from '@epicenter/record-sync/bun';
import { expectOk } from 'wellcrafted/testing';
import { createCanonicalRecords } from './canonical-records.js';
import {
	type CanonicalReplicaTransport,
	createCanonicalReplica,
} from './canonical-replica.js';
import { defineTable } from './lens-definition.js';

const definitions = {
	skills: defineTable({
		fields: {
			title: field.string(),
			category: field.string(),
		},
		optional: ['category'],
	}),
};

async function sha256(value: string): Promise<string> {
	return new Bun.CryptoHasher('sha256').update(value).digest('hex');
}

function authorityTransport(
	authority: ReturnType<typeof openRecordAuthority>,
): CanonicalReplicaTransport {
	return {
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

function openLocal(
	path: string,
	transport: CanonicalReplicaTransport,
	options: {
		pushLimit?: number;
		pullLimit?: number;
		onRemoteCommit?: () => void;
	} = {},
) {
	const native = new Database(path, { create: true });
	const sqlite = createBunSqliteAdapter(native);
	const replica = createCanonicalReplica({
		sqlite,
		transport,
		sha256,
		...options,
	});
	const records = createCanonicalRecords(sqlite, definitions, {
		admit: replica.admit,
	});
	return { native, replica, records, skills: records.tables.skills };
}

function actorId(native: Database): string {
	return (
		native
			.query<{ actor_id: string }, []>(
				'SELECT actor_id FROM __epicenter_replica_meta WHERE id = 1',
			)
			.get()?.actor_id ?? ''
	);
}

function rawPayload(native: Database, rowId: string): Record<string, unknown> {
	const stored = native
		.query<{ payload: string }, [string]>(
			`SELECT payload FROM __epicenter_records
			 WHERE table_key = 'skills' AND row_id = ?`,
		)
		.get(rowId);
	if (!stored) throw new Error(`Missing canonical row '${rowId}'`);
	return JSON.parse(stored.payload);
}

function push(
	authority: ReturnType<typeof openRecordAuthority>,
	actor: string,
	commands: PushRequest['mutations'][number]['command'][],
) {
	return authority.push({
		protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
		kind: 'push',
		actorId: actor,
		mutations: commands.map((command, index) => ({
			actorSequence: index + 1,
			command,
		})),
	});
}

test('uncertain sealed push retries exactly after the replica file reopens', async () => {
	const root = mkdtempSync(join(tmpdir(), 'canonical-replica-'));
	const path = join(root, 'replica.sqlite3');
	const authorityNative = new Database(':memory:');
	const authority = openRecordAuthority({
		database: createBunSqliteAdapter(authorityNative),
		sha256,
	});
	const requests: PushRequest[] = [];
	let loseFirstReceipt = true;
	const transport: CanonicalReplicaTransport = {
		...authorityTransport(authority),
		async push(request) {
			requests.push(structuredClone(request));
			const response = authority.push(request);
			if (loseFirstReceipt) {
				loseFirstReceipt = false;
				throw new Error('connection lost after acceptance');
			}
			return response;
		},
	};

	try {
		const first = openLocal(path, transport);
		const created = first.skills.create({ title: 'Durable intent' });
		const originalActor = actorId(first.native);
		await expect(first.replica.synchronize()).rejects.toThrow(
			'connection lost after acceptance',
		);
		expect(first.replica.status()).toMatchObject({
			pendingCommands: 1,
			hasInflightPush: true,
		});
		first.native.close();

		const reopened = openLocal(path, transport);
		expect(actorId(reopened.native)).toBe(originalActor);
		await reopened.replica.synchronize();
		expect(requests).toHaveLength(2);
		expect(requests[1]).toEqual(requests[0]);
		expect(reopened.replica.status()).toEqual({
			pullCursor: 1,
			pendingCommands: 0,
			acceptedCommandsAwaitingPull: 0,
			hasInflightPush: false,
		});
		expect(expectOk(reopened.skills.get(created.id))).toEqual(created);
		expect(authority.inspect().rows).toHaveLength(1);
		reopened.native.close();
	} finally {
		authorityNative.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test('bounded pushes keep one contiguous file-owned actor sequence', async () => {
	const root = mkdtempSync(join(tmpdir(), 'canonical-replica-'));
	const authorityNative = new Database(':memory:');
	const authority = openRecordAuthority({
		database: createBunSqliteAdapter(authorityNative),
		sha256,
	});
	const sizes: number[] = [];
	const transport: CanonicalReplicaTransport = {
		...authorityTransport(authority),
		async push(request) {
			sizes.push(request.mutations.length);
			return authority.push(request);
		},
	};
	const local = openLocal(join(root, 'replica.sqlite3'), transport, {
		pushLimit: 2,
	});

	try {
		for (let index = 0; index < 5; index++) {
			local.skills.create({ title: `Skill ${index}` });
		}
		await local.replica.synchronize();
		expect(sizes).toEqual([2, 2, 1]);
		expect(authority.inspect().actorHighWater).toEqual({
			[actorId(local.native)]: 5,
		});
		expect(authority.inspect().rows).toHaveLength(5);
	} finally {
		local.native.close();
		authorityNative.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test('aggregate row admission rolls back the overflowing patch and outbox entry', async () => {
	const localNative = new Database(':memory:');
	const authorityNative = new Database(':memory:');
	const authority = openRecordAuthority({
		database: createBunSqliteAdapter(authorityNative),
		sha256,
	});
	const sqlite = createBunSqliteAdapter(localNative);
	const replica = createCanonicalReplica({
		sqlite,
		transport: authorityTransport(authority),
		sha256,
	});
	const largeDefinition = defineTable({
		fields: {
			first: field.string(),
			second: field.string(),
			third: field.string(),
		},
		optional: ['first', 'second', 'third'],
	});
	const rows = createCanonicalRecords(
		sqlite,
		{ rows: largeDefinition },
		{ admit: replica.admit },
	).tables.rows;
	const part = 'x'.repeat(180 * 1024);

	try {
		const created = rows.create({ first: part });
		expect(rows.patch(created.id, { second: part }).error).toBeNull();
		expect(replica.status().pendingCommands).toBe(2);
		expect(() => rows.patch(created.id, { third: part })).toThrow(
			'Canonical row exceeds portable record-sync limits',
		);
		expect(replica.status().pendingCommands).toBe(2);
		const stored = localNative
			.query<{ payload: string }, [string]>(
				`SELECT payload FROM __epicenter_records WHERE table_key = 'rows' AND row_id = ?`,
			)
			.get(created.id);
		expect(stored).toBeDefined();
		const payload = JSON.parse(stored?.payload ?? '{}');
		expect(payload).toEqual({ first: part, second: part });
		expect(JSON.stringify(payload).length).toBeLessThan(
			RECORD_SYNC_ADMISSION_LIMITS.encodedRowBytes,
		);

		await replica.synchronize();
		expect(replica.status().pendingCommands).toBe(0);
		expect(authority.inspect().rows[0]?.value).toEqual(payload);
	} finally {
		localNative.close();
		authorityNative.close();
	}
});

test('distributed aggregate refusal quarantines intent and rebases later commands', async () => {
	const root = mkdtempSync(join(tmpdir(), 'canonical-replica-'));
	const authorityNative = new Database(':memory:');
	const authority = openRecordAuthority({
		database: createBunSqliteAdapter(authorityNative),
		sha256,
	});
	const largeDefinition = defineTable({
		fields: {
			first: field.string(),
			second: field.string(),
		},
		optional: ['first', 'second'],
	});
	const transport = authorityTransport(authority);
	const openLargeLocal = (path: string) => {
		const native = new Database(path, { create: true });
		const sqlite = createBunSqliteAdapter(native);
		const replica = createCanonicalReplica({
			sqlite,
			transport,
			sha256,
			pushLimit: 2,
		});
		const rows = createCanonicalRecords(
			sqlite,
			{ rows: largeDefinition },
			{ admit: replica.admit },
		).tables.rows;
		return { native, replica, rows };
	};
	const accepted = push(authority, 'seed', [
		{
			kind: 'createRow',
			table: 'rows',
			rowId: 'shared',
			value: {},
		},
		{
			kind: 'createRow',
			table: 'rows',
			rowId: 'untouched',
			value: { first: 'authority baseline' },
		},
	]);
	expect(accepted.ok).toBeTrue();
	const first = openLargeLocal(join(root, 'first.sqlite3'));
	const secondPath = join(root, 'second.sqlite3');
	let second = openLargeLocal(secondPath);
	const part = 'x'.repeat(255 * 1024);

	try {
		await Promise.all([
			first.replica.synchronize(),
			second.replica.synchronize(),
		]);
		expect(first.rows.patch('shared', { first: part }).error).toBeNull();
		await first.replica.synchronize();

		const rolledBackCreate = second.rows.create({
			first: 'created inside rejected batch',
		});
		expect(second.rows.patch('shared', { second: part }).error).toBeNull();
		expect(
			second.rows.patch(rolledBackCreate.id, {
				second: 'depends on rejected create',
			}).error,
		).toBeNull();
		const retained = second.rows.create({ first: 'later local intent' });
		const refusedActor = actorId(second.native);
		await expect(second.replica.synchronize()).rejects.toThrow(
			'Record push permanently refused; 3 commands quarantined: row-too-large',
		);

		expect(actorId(second.native)).not.toBe(refusedActor);
		expect(second.replica.status()).toMatchObject({
			pullCursor: 3,
			pendingCommands: 1,
			hasInflightPush: false,
		});
		const quarantine = second.replica.inspectQuarantine();
		expect(quarantine).toMatchObject([
			{
				actorId: refusedActor,
				actorSequence: 1,
				reason: 'row-too-large',
				command: {
					kind: 'createRow',
					table: 'rows',
					rowId: rolledBackCreate.id,
				},
			},
			{
				actorId: refusedActor,
				actorSequence: 2,
				reason: 'row-too-large',
				command: {
					kind: 'patchRow',
					table: 'rows',
					rowId: 'shared',
					unset: [],
				},
			},
			{
				actorId: refusedActor,
				actorSequence: 3,
				reason: 'depends-on-rejected-batch',
				command: {
					kind: 'patchRow',
					table: 'rows',
					rowId: rolledBackCreate.id,
				},
			},
		]);
		const refusedCommand = quarantine[1]?.command;
		expect(refusedCommand?.kind).toBe('patchRow');
		if (refusedCommand?.kind !== 'patchRow') {
			throw new Error('Expected a quarantined patch command');
		}
		expect(refusedCommand.set.second).toBe(part);
		expect(expectOk(second.rows.get('shared'))).toEqual({
			id: 'shared',
			first: part,
		});
		expect(expectOk(second.rows.get('untouched'))).toEqual({
			id: 'untouched',
			first: 'authority baseline',
		});
		expect(expectOk(second.rows.get(rolledBackCreate.id))).toBeUndefined();
		expect(expectOk(second.rows.get(retained.id))).toEqual(retained);
		expect(
			authority
				.inspect()
				.rows.some(({ rowId }) => rowId === rolledBackCreate.id),
		).toBeFalse();
		expect(
			authority.inspect().rows.some(({ rowId }) => rowId === retained.id),
		).toBeFalse();

		second.native.close();
		second = openLargeLocal(secondPath);
		expect(second.replica.inspectQuarantine()).toHaveLength(3);
		expect(expectOk(second.rows.get(retained.id))).toEqual(retained);
		await second.replica.synchronize();
		expect(second.replica.status()).toMatchObject({
			pendingCommands: 0,
			hasInflightPush: false,
		});
		expect(
			authority.inspect().rows.some(({ rowId }) => rowId === retained.id),
		).toBeTrue();
	} finally {
		first.native.close();
		second.native.close();
		authorityNative.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test('create conflict quarantines a later recreate on every rejected batch row', async () => {
	const root = mkdtempSync(join(tmpdir(), 'canonical-replica-'));
	const authorityNative = new Database(':memory:');
	const authority = openRecordAuthority({
		database: createBunSqliteAdapter(authorityNative),
		sha256,
	});
	push(authority, 'seed', [
		{
			kind: 'createRow',
			table: 'skills',
			rowId: 'conflict',
			value: { title: 'Authority conflict' },
		},
		{
			kind: 'createRow',
			table: 'skills',
			rowId: 'deleted-in-batch',
			value: { title: 'Authority survivor' },
		},
	]);
	const local = openLocal(
		join(root, 'replica.sqlite3'),
		authorityTransport(authority),
		{ pushLimit: 2 },
	);

	try {
		await local.replica.synchronize();
		local.native
			.query(
				`DELETE FROM __epicenter_records
				 WHERE table_key = 'skills' AND row_id = ?`,
			)
			.run('conflict');
		local.replica.admit({
			kind: 'createRow',
			table: 'skills',
			rowId: 'conflict',
			value: { title: 'Conflicting local lifetime' },
		});
		local.skills.delete('deleted-in-batch');
		local.replica.admit({
			kind: 'createRow',
			table: 'skills',
			rowId: 'deleted-in-batch',
			value: { title: 'Ambiguous recreate' },
		});

		await expect(local.replica.synchronize()).rejects.toThrow(
			'Record push permanently refused; 3 commands quarantined: create-conflict',
		);
		expect(local.replica.status()).toMatchObject({
			pendingCommands: 0,
			hasInflightPush: false,
		});
		expect(local.replica.inspectQuarantine()).toMatchObject([
			{
				actorSequence: 1,
				reason: 'create-conflict',
				command: { kind: 'createRow', rowId: 'conflict' },
			},
			{
				actorSequence: 2,
				reason: 'create-conflict',
				command: { kind: 'deleteRow', rowId: 'deleted-in-batch' },
			},
			{
				actorSequence: 3,
				reason: 'depends-on-rejected-batch',
				command: { kind: 'createRow', rowId: 'deleted-in-batch' },
			},
		]);
		expect(expectOk(local.skills.get('conflict'))).toEqual({
			id: 'conflict',
			title: 'Authority conflict',
		});
		expect(expectOk(local.skills.get('deleted-in-batch'))).toEqual({
			id: 'deleted-in-batch',
			title: 'Authority survivor',
		});
		await local.replica.synchronize();
		expect(local.replica.inspectQuarantine()).toHaveLength(3);
	} finally {
		local.native.close();
		authorityNative.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test('interrupted bootstrap rebases retained commands before any rotated-actor push', async () => {
	const root = mkdtempSync(join(tmpdir(), 'canonical-replica-'));
	const authorityNative = new Database(':memory:');
	const authority = openRecordAuthority({
		database: createBunSqliteAdapter(authorityNative),
		sha256,
	});
	push(authority, 'remote-release', [
		{
			kind: 'createRow',
			table: 'skills',
			rowId: 'remote',
			value: { title: 'Authority baseline' },
		},
	]);
	let pushCalls = 0;
	const transport: CanonicalReplicaTransport = {
		...authorityTransport(authority),
		async push(request) {
			pushCalls += 1;
			return authority.push(request);
		},
	};
	const local = openLocal(join(root, 'replica.sqlite3'), transport);
	const retained = local.skills.create({ title: 'Retained after crash' });
	local.native.run(
		`UPDATE __epicenter_replica_meta SET
			actor_id = ?, pull_cursor = 0, inflight_first = NULL,
			inflight_last = NULL, requires_bootstrap = 1
		 WHERE id = 1`,
		[crypto.randomUUID()],
	);
	local.native.run('DELETE FROM __epicenter_records');

	try {
		await local.replica.synchronize();
		expect(pushCalls).toBe(0);
		expect(expectOk(local.skills.get('remote'))).toEqual({
			id: 'remote',
			title: 'Authority baseline',
		});
		expect(expectOk(local.skills.get(retained.id))).toEqual(retained);
		expect(local.replica.status()).toMatchObject({ pendingCommands: 1 });

		await local.replica.synchronize();
		expect(pushCalls).toBe(1);
		expect(local.replica.status()).toMatchObject({ pendingCommands: 0 });
	} finally {
		local.native.close();
		authorityNative.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test('an admit during active synchronization schedules another complete pass', async () => {
	const root = mkdtempSync(join(tmpdir(), 'canonical-replica-'));
	const authorityNative = new Database(':memory:');
	const authority = openRecordAuthority({
		database: createBunSqliteAdapter(authorityNative),
		sha256,
	});
	let local: ReturnType<typeof openLocal>;
	let admittedDuringPush = false;
	let joinedPass: Promise<unknown> | undefined;
	const transport: CanonicalReplicaTransport = {
		...authorityTransport(authority),
		async push(request) {
			const response = authority.push(request);
			if (!admittedDuringPush) {
				admittedDuringPush = true;
				local.skills.create({ title: 'Admitted during push' });
				joinedPass = local.replica.synchronize();
			}
			return response;
		},
	};
	local = openLocal(join(root, 'replica.sqlite3'), transport);

	try {
		local.skills.create({ title: 'Initial' });
		const initialPass = local.replica.synchronize();
		await initialPass;
		expect(joinedPass).toBe(initialPass);
		expect(local.replica.status()).toMatchObject({ pendingCommands: 0 });
		expect(authority.inspect().rows).toHaveLength(2);
	} finally {
		local.native.close();
		authorityNative.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test('two supervisors accept the same sealed receipt idempotently', async () => {
	const root = mkdtempSync(join(tmpdir(), 'canonical-replica-'));
	const path = join(root, 'replica.sqlite3');
	const authorityNative = new Database(':memory:');
	const authority = openRecordAuthority({
		database: createBunSqliteAdapter(authorityNative),
		sha256,
	});
	let arrivals = 0;
	let releasePushes: (() => void) | undefined;
	const bothPushing = new Promise<void>((resolve) => {
		releasePushes = resolve;
	});
	const transport: CanonicalReplicaTransport = {
		...authorityTransport(authority),
		async push(request) {
			const response = authority.push(request);
			arrivals += 1;
			if (arrivals === 2) releasePushes?.();
			await bothPushing;
			return response;
		},
	};
	const first = openLocal(path, transport);
	const second = openLocal(path, transport);

	try {
		first.skills.create({ title: 'Shared file' });
		await Promise.all([
			first.replica.synchronize(),
			second.replica.synchronize(),
		]);
		expect(arrivals).toBe(2);
		expect(first.replica.status()).toMatchObject({
			pullCursor: 1,
			pendingCommands: 0,
		});
		expect(authority.inspect().rows).toHaveLength(1);
	} finally {
		first.native.close();
		second.native.close();
		authorityNative.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test('a push receipt must authenticate the exact sealed batch', async () => {
	const root = mkdtempSync(join(tmpdir(), 'canonical-replica-'));
	const authorityNative = new Database(':memory:');
	const authority = openRecordAuthority({
		database: createBunSqliteAdapter(authorityNative),
		sha256,
	});
	const transport: CanonicalReplicaTransport = {
		...authorityTransport(authority),
		async push(request) {
			const response = authority.push(request);
			if (!response.ok) return response;
			return {
				...response,
				receipt: { ...response.receipt, batchChecksum: 'wrong-batch' },
			};
		},
	};
	const local = openLocal(join(root, 'replica.sqlite3'), transport);

	try {
		local.skills.create({ title: 'Exact intent' });
		await expect(local.replica.synchronize()).rejects.toThrow(
			'Push receipt does not match the sealed request',
		);
		expect(local.replica.status()).toMatchObject({
			pendingCommands: 1,
			hasInflightPush: true,
		});
	} finally {
		local.native.close();
		authorityNative.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test('pull installs mixed-release current state without enqueuing commands', async () => {
	const root = mkdtempSync(join(tmpdir(), 'canonical-replica-'));
	const authorityNative = new Database(':memory:');
	const authority = openRecordAuthority({
		database: createBunSqliteAdapter(authorityNative),
		sha256,
	});
	const accepted = push(authority, 'remote-release', [
		{
			kind: 'createRow',
			table: 'skills',
			rowId: 'shared',
			value: { title: 'Old', future: { retained: true } },
		},
		{
			kind: 'patchRow',
			table: 'skills',
			rowId: 'shared',
			set: { title: 'New', oldReleaseOnly: 1 },
			unset: [],
		},
		{
			kind: 'patchRow',
			table: 'skills',
			rowId: 'shared',
			set: { category: 'writing' },
			unset: ['oldReleaseOnly'],
		},
	]);
	expect(accepted.ok).toBe(true);
	const path = join(root, 'replica.sqlite3');
	let remoteCommits = 0;
	const local = openLocal(path, authorityTransport(authority), {
		onRemoteCommit: () => {
			remoteCommits += 1;
		},
	});

	try {
		await local.replica.synchronize();
		expect(rawPayload(local.native, 'shared')).toEqual({
			title: 'New',
			category: 'writing',
			future: { retained: true },
		});
		expect(expectOk(local.skills.get('shared'))).toEqual({
			id: 'shared',
			title: 'New',
			category: 'writing',
		});
		expect(local.replica.status()).toMatchObject({
			pullCursor: 3,
			pendingCommands: 0,
			acceptedCommandsAwaitingPull: 0,
		});
		expect(
			local.native.query('SELECT * FROM __epicenter_replica_outbox').all(),
		).toEqual([]);
		expect(remoteCommits).toBe(1);
		local.native.close();

		const reopened = openLocal(path, authorityTransport(authority));
		expect(reopened.replica.status().pullCursor).toBe(3);
		expect(rawPayload(reopened.native, 'shared').future).toEqual({
			retained: true,
		});
		reopened.native.close();
	} finally {
		authorityNative.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test('pending rebase preserves __proto__ as an ordinary own JSON key', async () => {
	const root = mkdtempSync(join(tmpdir(), 'canonical-replica-'));
	const authorityNative = new Database(':memory:');
	const authority = openRecordAuthority({
		database: createBunSqliteAdapter(authorityNative),
		sha256,
	});
	push(authority, 'remote-release', [
		{
			kind: 'createRow',
			table: 'skills',
			rowId: 'shared',
			value: { title: 'Remote' },
		},
	]);
	let local: ReturnType<typeof openLocal>;
	let admittedDuringPull = false;
	const transport: CanonicalReplicaTransport = {
		...authorityTransport(authority),
		async pull(request) {
			if (!admittedDuringPull) {
				admittedDuringPull = true;
				local.replica.admit({
					kind: 'patchRow',
					table: 'skills',
					rowId: 'shared',
					set: JSON.parse('{"__proto__":{"source":"pending-rebase"}}'),
					unset: [],
				});
			}
			return authority.pull(request);
		},
	};
	local = openLocal(join(root, 'replica.sqlite3'), transport);

	try {
		await local.replica.synchronize();
		const value = rawPayload(local.native, 'shared');
		expect(Object.hasOwn(value, '__proto__')).toBeTrue();
		expect(Object.getOwnPropertyDescriptor(value, '__proto__')?.value).toEqual({
			source: 'pending-rebase',
		});
		expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
		expect(Object.getPrototypeOf({})).not.toHaveProperty('source');
		expect(local.replica.status()).toMatchObject({ pendingCommands: 0 });
	} finally {
		local.native.close();
		authorityNative.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test('below-floor snapshot preserves accepted-after-head and pending local rows', async () => {
	const root = mkdtempSync(join(tmpdir(), 'canonical-replica-'));
	const authorityNative = new Database(':memory:');
	const authority = openRecordAuthority({
		database: createBunSqliteAdapter(authorityNative),
		sha256,
	});
	push(authority, 'remote-release', [
		{
			kind: 'createRow',
			table: 'skills',
			rowId: 'remote',
			value: { title: 'Snapshot row', future: 'opaque' },
		},
	]);
	const manifest = await authority.publishSnapshot({ maxChunkBytes: 64_000 });
	if (!manifest) throw new Error('Expected published snapshot');
	authority.compactDeletionsThrough(manifest.head);

	let createDuringSnapshot: (() => void) | undefined;
	let didCreateDuringSnapshot = false;
	const transport: CanonicalReplicaTransport = {
		...authorityTransport(authority),
		async snapshotChunk(request) {
			if (!didCreateDuringSnapshot) {
				didCreateDuringSnapshot = true;
				createDuringSnapshot?.();
			}
			return authority.snapshotChunk(request);
		},
	};
	const local = openLocal(join(root, 'replica.sqlite3'), transport);
	const acceptedAfterHead = local.skills.create({ title: 'Accepted after H' });
	let pendingRowId = '';
	createDuringSnapshot = () => {
		pendingRowId = local.skills.create({ title: 'Pending during snapshot' }).id;
	};

	try {
		await local.replica.synchronize();
		expect(local.replica.status()).toEqual({
			pullCursor: 3,
			pendingCommands: 0,
			acceptedCommandsAwaitingPull: 0,
			hasInflightPush: false,
		});
		expect(expectOk(local.skills.get('remote'))).toMatchObject({
			title: 'Snapshot row',
		});
		expect(expectOk(local.skills.get(acceptedAfterHead.id))).toMatchObject({
			title: 'Accepted after H',
		});
		expect(expectOk(local.skills.get(pendingRowId))).toMatchObject({
			title: 'Pending during snapshot',
		});

		expect(authority.inspect().rows).toHaveLength(3);
	} finally {
		local.native.close();
		authorityNative.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test('a stale staged snapshot cannot roll a shared replica backward', async () => {
	const root = mkdtempSync(join(tmpdir(), 'canonical-replica-'));
	const manifest = await createSnapshotManifest(sha256, {
		generation: 1,
		head: 1,
		chunkChecksums: ['already-staged'],
		actorHighWater: {},
	});
	let pulls = 0;
	const transport: CanonicalReplicaTransport = {
		async push() {
			throw new Error('Unexpected push');
		},
		async pull(request) {
			pulls += 1;
			if (pulls === 1) {
				return {
					kind: 'pull',
					ok: true,
					snapshotRequired: true,
					manifest,
				};
			}
			return {
				kind: 'pull',
				ok: true,
				snapshotRequired: false,
				fromCursor: request.cursor,
				entries: [],
				newCursor: request.cursor,
				hasMore: false,
			};
		},
		async snapshotChunk() {
			throw new Error('Completed staging must not redownload chunks');
		},
	};
	const local = openLocal(join(root, 'replica.sqlite3'), transport);

	try {
		local.native.run(
			`INSERT INTO __epicenter_records(table_key, row_id, payload)
			 VALUES ('skills', 'shared', '{"title":"newer"}')`,
		);
		local.native.run(
			'UPDATE __epicenter_replica_meta SET pull_cursor = 2 WHERE id = 1',
		);
		local.native.run(
			`INSERT INTO __epicenter_replica_snapshot_meta(
				id, generation, manifest_json, next_chunk_index
			) VALUES (1, ?, ?, 1)`,
			[manifest.generation, JSON.stringify(manifest)],
		);
		local.native.run(
			`INSERT INTO __epicenter_replica_snapshot_rows(
				generation, table_key, row_id, payload, last_server_sequence
			) VALUES (1, 'skills', 'shared', '{"title":"stale"}', 1)`,
		);

		await local.replica.synchronize();
		expect(local.replica.status().pullCursor).toBe(2);
		expect(expectOk(local.skills.get('shared'))).toMatchObject({
			title: 'newer',
		});
	} finally {
		local.native.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test('an invalid pull response cannot advance the transactional cursor', async () => {
	const root = mkdtempSync(join(tmpdir(), 'canonical-replica-'));
	const transport: CanonicalReplicaTransport = {
		async push() {
			throw new Error('Unexpected push');
		},
		async pull() {
			return {
				kind: 'pull',
				ok: true,
				snapshotRequired: false,
				fromCursor: 0,
				entries: [{ kind: 'row', table: 'skills', rowId: 'bad' }],
				newCursor: 1,
				hasMore: false,
			};
		},
		async snapshotChunk() {
			throw new Error('Unexpected snapshot');
		},
	};
	const local = openLocal(join(root, 'replica.sqlite3'), transport);

	try {
		await expect(local.replica.synchronize()).rejects.toThrow(
			'Invalid record pull response',
		);
		expect(local.replica.status().pullCursor).toBe(0);
		expect(
			local.native.query('SELECT * FROM __epicenter_records').all(),
		).toEqual([]);
	} finally {
		local.native.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test('a paginated pull must make monotone progress', async () => {
	const root = mkdtempSync(join(tmpdir(), 'canonical-replica-'));
	const transport: CanonicalReplicaTransport = {
		async push() {
			throw new Error('Unexpected push');
		},
		async pull(request) {
			return {
				kind: 'pull',
				ok: true,
				snapshotRequired: false,
				fromCursor: request.cursor,
				entries: [],
				newCursor: request.cursor,
				hasMore: true,
			};
		},
		async snapshotChunk() {
			throw new Error('Unexpected snapshot');
		},
	};
	const local = openLocal(join(root, 'replica.sqlite3'), transport);

	try {
		await expect(local.replica.synchronize()).rejects.toThrow(
			'Pull response does not continue the local cursor',
		);
		expect(local.replica.status().pullCursor).toBe(0);
	} finally {
		local.native.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test('a pull cannot exceed the requested entry count', async () => {
	const root = mkdtempSync(join(tmpdir(), 'canonical-replica-'));
	const transport: CanonicalReplicaTransport = {
		async push() {
			throw new Error('Unexpected push');
		},
		async pull(request) {
			return {
				kind: 'pull',
				ok: true,
				snapshotRequired: false,
				fromCursor: request.cursor,
				entries: [
					{
						kind: 'deletion',
						table: 'skills',
						rowId: 'one',
						lastServerSequence: 1,
					},
					{
						kind: 'deletion',
						table: 'skills',
						rowId: 'two',
						lastServerSequence: 2,
					},
				],
				newCursor: 2,
				hasMore: false,
			};
		},
		async snapshotChunk() {
			throw new Error('Unexpected snapshot');
		},
	};
	const local = openLocal(join(root, 'replica.sqlite3'), transport, {
		pullLimit: 1,
	});

	try {
		await expect(local.replica.synchronize()).rejects.toThrow(
			'Pull response exceeds the requested entry limit',
		);
		expect(local.replica.status().pullCursor).toBe(0);
	} finally {
		local.native.close();
		rmSync(root, { recursive: true, force: true });
	}
});
