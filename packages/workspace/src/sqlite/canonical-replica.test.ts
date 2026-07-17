/**
 * Canonical Record Replica Tests (ADR-0131/0132/0133)
 *
 * Verifies the sealed-round client: durable pending intent, exact round
 * retry, paged catch-up installation, mirrored fold replay, the deletion
 * fence, and below-floor snapshot recovery.
 *
 * Key behaviors:
 * - optimistic records and outbox intent commit atomically
 * - an uncertain round retries the exact digest after process restart
 * - a divergent clone receives the terminal fork verdict
 * - own writes never regress while catch-up pages stream
 * - pulled schema-opaque state never creates local outbox commands
 */

import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { field } from '@epicenter/field';
import {
	openRecordAuthority,
	RECORD_SYNC_PROTOCOL_MAJOR,
	type RecordCommand,
	RESERVED_KV_ROW_ID,
	RESERVED_KV_TABLE,
	recordRoundDigest,
	type SyncRequest,
} from '@epicenter/record-sync';
import { createBunSqliteAdapter } from '@epicenter/record-sync/bun';
import { expectOk } from 'wellcrafted/testing';
import { createCanonicalRecords } from './canonical-records.js';
import {
	type CanonicalReplicaDiagnostic,
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
		async sync(request) {
			return authority.sync(request);
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
		roundLimit?: number;
		pageLimit?: number;
		onRemoteCommit?: () => void;
		onDiagnostic?: (diagnostic: CanonicalReplicaDiagnostic) => void;
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

function rawPayload(
	native: Database,
	rowId: string,
	table = 'skills',
): Record<string, unknown> {
	const stored = native
		.query<{ payload: string }, [string, string]>(
			`SELECT payload FROM __epicenter_records
			 WHERE table_key = ? AND row_id = ?`,
		)
		.get(table, rowId);
	if (!stored) throw new Error(`Missing canonical row '${table}/${rowId}'`);
	return JSON.parse(stored.payload);
}

function writerRound(
	authority: ReturnType<typeof openRecordAuthority>,
	replicaId: string,
	acceptedRound: number,
	commands: RecordCommand[],
) {
	const request: SyncRequest = {
		protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
		kind: 'sync',
		token: { replicaId, acceptedRound, checkpoint: 0 },
		sealedRound: {
			round: acceptedRound + 1,
			requestDigest: recordRoundDigest(commands),
			commands,
		},
	};
	const response = authority.sync(request);
	if (!response.ok) throw new Error(`writer round refused: ${response.reason}`);
	return response;
}

test('optimistic writes and durable intent commit atomically, then one round syncs', async () => {
	const root = mkdtempSync(join(tmpdir(), 'canonical-replica-'));
	const authorityNative = new Database(':memory:');
	try {
		const authority = openRecordAuthority({
			database: createBunSqliteAdapter(authorityNative),
			sha256,
		});
		const { native, replica, skills } = openLocal(
			join(root, 'replica.sqlite3'),
			authorityTransport(authority),
		);
		const created = skills.create({ title: 'Fold' });
		expectOk(skills.patch(created.id, { category: 'sync' }));
		expect(replica.status()).toMatchObject({
			checkpoint: 0,
			pendingCommands: 2,
			hasInflightRound: false,
		});

		const status = await replica.synchronize();
		expect(status).toMatchObject({
			checkpoint: 2,
			pendingCommands: 0,
			hasInflightRound: false,
		});
		expect(authority.inspect().rows).toMatchObject([
			{ rowId: created.id, value: { title: 'Fold', category: 'sync' } },
		]);
		expect(rawPayload(native, created.id)).toEqual({
			title: 'Fold',
			category: 'sync',
		});
		native.close();
	} finally {
		authorityNative.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test('an uncertain round retries the exact digest after the replica file reopens', async () => {
	const root = mkdtempSync(join(tmpdir(), 'canonical-replica-'));
	const path = join(root, 'replica.sqlite3');
	const authorityNative = new Database(':memory:');
	try {
		const authority = openRecordAuthority({
			database: createBunSqliteAdapter(authorityNative),
			sha256,
		});
		// The request commits, the response is lost.
		const lossy: CanonicalReplicaTransport = {
			async sync(request) {
				authority.sync(request);
				throw new Error('response lost');
			},
			async snapshotChunk() {
				throw new Error('unused');
			},
		};
		const first = openLocal(path, lossy);
		const created = first.skills.create({ title: 'Uncertain' });
		await expect(first.replica.synchronize()).rejects.toThrow('response lost');
		expect(first.replica.status()).toMatchObject({ hasInflightRound: true });
		first.native.close();

		// Another replica overwrites the same key before the retry.
		writerRound(authority, 'writer-b', 0, [
			{
				kind: 'patchRow',
				table: 'skills',
				rowId: created.id,
				set: { title: 'Overwritten' },
				unset: [],
			},
		]);

		// Crash boundary: only the file survives. The retry matches the stored
		// digest, refolds nothing, and pages show the overwrite.
		const reopened = openLocal(path, authorityTransport(authority));
		const status = await reopened.replica.synchronize();
		expect(status).toMatchObject({ pendingCommands: 0, hasInflightRound: false });
		expect(authority.inspect().rows).toMatchObject([
			{ rowId: created.id, value: { title: 'Overwritten' } },
		]);
		expect(rawPayload(reopened.native, created.id)).toEqual({
			title: 'Overwritten',
		});
		reopened.native.close();
	} finally {
		authorityNative.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test('a request lost before commit folds as the same round on retry', async () => {
	const root = mkdtempSync(join(tmpdir(), 'canonical-replica-'));
	const authorityNative = new Database(':memory:');
	try {
		const authority = openRecordAuthority({
			database: createBunSqliteAdapter(authorityNative),
			sha256,
		});
		let dropRequests = 1;
		const flaky: CanonicalReplicaTransport = {
			async sync(request) {
				if (dropRequests > 0) {
					dropRequests -= 1;
					throw new Error('request lost');
				}
				return authority.sync(request);
			},
			async snapshotChunk(request) {
				return authority.snapshotChunk(request);
			},
		};
		const { native, replica, skills } = openLocal(
			join(root, 'replica.sqlite3'),
			flaky,
		);
		const created = skills.create({ title: 'Lost request' });
		await expect(replica.synchronize()).rejects.toThrow('request lost');
		expect(authority.inspect().head).toBe(0);

		await replica.synchronize();
		expect(authority.inspect().rows).toMatchObject([
			{ rowId: created.id, value: { title: 'Lost request' } },
		]);
		expect(authority.inspect().replicaRounds).toMatchObject(
			Object.fromEntries([[Object.keys(authority.inspect().replicaRounds)[0]!, 1]]),
		);
		native.close();
	} finally {
		authorityNative.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test('a divergent clone receives the terminal fork verdict', async () => {
	const root = mkdtempSync(join(tmpdir(), 'canonical-replica-'));
	const path = join(root, 'replica.sqlite3');
	const clonePath = join(root, 'clone.sqlite3');
	const authorityNative = new Database(':memory:');
	try {
		const authority = openRecordAuthority({
			database: createBunSqliteAdapter(authorityNative),
			sha256,
		});
		const original = openLocal(path, authorityTransport(authority));
		original.skills.create({ title: 'Base' });
		await original.replica.synchronize();
		original.native.close();

		// Fork the physical file, then let both copies write divergently.
		copyFileSync(path, clonePath);
		const survivor = openLocal(path, authorityTransport(authority));
		const clone = openLocal(clonePath, authorityTransport(authority));
		survivor.skills.create({ title: 'From survivor' });
		clone.skills.create({ title: 'From clone' });

		await survivor.replica.synchronize();
		await expect(clone.replica.synchronize()).rejects.toThrow(
			'Record sync refused: replica-fork',
		);
		// The clone's intent stays durable and inspectable for app-level
		// recovery (fresh identity + resubmission); nothing was silently lost.
		expect(clone.replica.status()).toMatchObject({ hasInflightRound: true });
		survivor.native.close();
		clone.native.close();
	} finally {
		authorityNative.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test('own writes never regress while catch-up pages stream, across a crash', async () => {
	const root = mkdtempSync(join(tmpdir(), 'canonical-replica-'));
	const path = join(root, 'replica.sqlite3');
	const authorityNative = new Database(':memory:');
	try {
		const authority = openRecordAuthority({
			database: createBunSqliteAdapter(authorityNative),
			sha256,
		});
		for (let index = 0; index < 7; index += 1) {
			writerRound(authority, 'writer', index, [
				{
					kind: 'createRow',
					table: 'skills',
					rowId: `remote-${index}`,
					value: { title: `Remote ${index}` },
				},
			]);
		}

		// Fail after the first successful page so pagination is interrupted.
		let pagesServed = 0;
		const flaky: CanonicalReplicaTransport = {
			async sync(request) {
				const response = authority.sync(request);
				pagesServed += 1;
				if (pagesServed === 1) return response;
				throw new Error('connection dropped');
			},
			async snapshotChunk(request) {
				return authority.snapshotChunk(request);
			},
		};
		const first = openLocal(path, flaky, { pageLimit: 2 });
		const created = first.skills.create({ title: 'Mine' });
		await expect(first.replica.synchronize()).rejects.toThrow(
			'connection dropped',
		);
		// The first page installed; the sealed round replays over it.
		expect(first.replica.status().checkpoint).toBeGreaterThan(0);
		expect(rawPayload(first.native, created.id)).toEqual({ title: 'Mine' });
		first.native.close();

		// Crash boundary: reopen the file, resume paging to head.
		const reopened = openLocal(path, authorityTransport(authority), {
			pageLimit: 2,
		});
		expect(rawPayload(reopened.native, created.id)).toEqual({ title: 'Mine' });
		const status = await reopened.replica.synchronize();
		expect(status).toMatchObject({ pendingCommands: 0, hasInflightRound: false });
		expect(rawPayload(reopened.native, created.id)).toEqual({ title: 'Mine' });
		const scan = reopened.skills.scan({ limit: 100 });
		expect(scan.rows).toHaveLength(8);
		reopened.native.close();
	} finally {
		authorityNative.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test('a concurrent deletion wins over a late edit and fences queued body appends', async () => {
	const root = mkdtempSync(join(tmpdir(), 'canonical-replica-'));
	const authorityNative = new Database(':memory:');
	try {
		const authority = openRecordAuthority({
			database: createBunSqliteAdapter(authorityNative),
			sha256,
		});
		const diagnostics: CanonicalReplicaDiagnostic[] = [];
		// One command per round so the queued body edit is still in the outbox
		// (not sealed) when the deletion entry installs: the fence's shape. An
		// already-sealed append is immutable and relies on the authority fold.
		const { native, replica, skills } = openLocal(
			join(root, 'replica.sqlite3'),
			authorityTransport(authority),
			{
				roundLimit: 1,
				onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
			},
		);
		const created = skills.create({ title: 'Doomed' });
		await replica.synchronize();

		// Another replica deletes the row at the authority.
		writerRound(authority, 'writer-b', 0, [
			{ kind: 'deleteRow', table: 'skills', rowId: created.id },
		]);

		// Meanwhile this replica queues a scalar edit and a body edit.
		expectOk(skills.patch(created.id, { title: 'Late edit' }));
		replica.admit({
			kind: 'bodyAppend',
			table: 'skills',
			rowId: created.id,
			update: 'bGF0ZS1ib2R5',
		});

		await replica.synchronize();
		// The deletion installed; the queued body append was fenced before it
		// could ship; the late patch was accepted upstream as a no-op.
		expect(
			diagnostics.some(
				(diagnostic) => diagnostic.command.kind === 'bodyAppend',
			),
		).toBeTrue();
		expect(authority.inspect().rows).toEqual([]);
		expect(authority.inspect().bodyLog).toEqual([]);
		expect(
			native
				.query('SELECT * FROM __epicenter_records')
				.all(),
		).toEqual([]);
		native.close();
	} finally {
		authorityNative.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test('body updates install by sequence and deletion purges local body state', async () => {
	const root = mkdtempSync(join(tmpdir(), 'canonical-replica-'));
	const authorityNative = new Database(':memory:');
	try {
		const authority = openRecordAuthority({
			database: createBunSqliteAdapter(authorityNative),
			sha256,
		});
		writerRound(authority, 'writer', 0, [
			{ kind: 'createRow', table: 'notes', rowId: 'note-1', value: {} },
			{ kind: 'bodyAppend', table: 'notes', rowId: 'note-1', update: 'b25l' },
			{ kind: 'bodyAppend', table: 'notes', rowId: 'note-1', update: 'dHdv' },
		]);
		const { native, replica } = openLocal(
			join(root, 'replica.sqlite3'),
			authorityTransport(authority),
		);
		await replica.synchronize();
		expect(
			native
				.query<{ update_b64: string; last_server_sequence: number }, []>(
					`SELECT update_b64, last_server_sequence
					 FROM __epicenter_replica_bodies ORDER BY last_server_sequence`,
				)
				.all(),
		).toEqual([
			{ update_b64: 'b25l', last_server_sequence: 2 },
			{ update_b64: 'dHdv', last_server_sequence: 3 },
		]);

		writerRound(authority, 'writer', 1, [
			{ kind: 'deleteRow', table: 'notes', rowId: 'note-1' },
		]);
		await replica.synchronize();
		expect(
			native.query('SELECT * FROM __epicenter_replica_bodies').all(),
		).toEqual([]);
		native.close();
	} finally {
		authorityNative.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test('a below-floor replica bootstraps after its round folds, keeping pending intent', async () => {
	const root = mkdtempSync(join(tmpdir(), 'canonical-replica-'));
	const authorityNative = new Database(':memory:');
	try {
		const authority = openRecordAuthority({
			database: createBunSqliteAdapter(authorityNative),
			sha256,
		});
		writerRound(authority, 'writer', 0, [
			{ kind: 'createRow', table: 'skills', rowId: 'kept', value: { title: 'Kept' } },
			{ kind: 'createRow', table: 'skills', rowId: 'doomed', value: { title: 'Doomed' } },
		]);

		const { native, replica, skills } = openLocal(
			join(root, 'replica.sqlite3'),
			authorityTransport(authority),
		);
		await replica.synchronize();
		expect(rawPayload(native, 'doomed')).toEqual({ title: 'Doomed' });

		// The authority deletes, snapshots, and compacts past the tombstone.
		writerRound(authority, 'writer', 1, [
			{ kind: 'deleteRow', table: 'skills', rowId: 'doomed' },
		]);
		const manifest = await authority.publishSnapshot({
			maxChunkBytes: 512 * 1024,
		});
		if (!manifest) throw new Error('Expected snapshot publication');
		authority.compactDeletionsThrough(manifest.head);
		expect(authority.inspect().deletions).toEqual([]);

		// The stale replica edits offline, then synchronizes below the floor.
		expectOk(skills.patch('kept', { category: 'offline' }));
		await replica.synchronize();
		expect(authority.inspect().rows).toMatchObject([
			{ rowId: 'kept', value: { title: 'Kept', category: 'offline' } },
		]);
		expect(rawPayload(native, 'kept')).toEqual({
			title: 'Kept',
			category: 'offline',
		});
		expect(() => rawPayload(native, 'doomed')).toThrow('Missing canonical row');
		native.close();
	} finally {
		authorityNative.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test('an interrupted snapshot install resumes by chunk index after reopen', async () => {
	const root = mkdtempSync(join(tmpdir(), 'canonical-replica-'));
	const path = join(root, 'replica.sqlite3');
	const authorityNative = new Database(':memory:');
	try {
		const authority = openRecordAuthority({
			database: createBunSqliteAdapter(authorityNative),
			sha256,
		});
		// Wide rows force multiple snapshot chunks.
		const wide = 'x'.repeat(200 * 1024);
		writerRound(authority, 'writer', 0, [
			{ kind: 'createRow', table: 'skills', rowId: 'row-a', value: { title: wide } },
			{ kind: 'createRow', table: 'skills', rowId: 'row-b', value: { title: wide } },
			{ kind: 'createRow', table: 'skills', rowId: 'row-c', value: { title: wide } },
			{ kind: 'deleteRow', table: 'skills', rowId: 'row-c' },
		]);
		const manifest = await authority.publishSnapshot({
			maxChunkBytes: 256 * 1024,
		});
		if (!manifest) throw new Error('Expected snapshot publication');
		authority.compactDeletionsThrough(manifest.head);
		expect(manifest.chunkChecksums.length).toBeGreaterThan(1);

		const fetches: number[] = [];
		let failuresLeft = 1;
		const flaky: CanonicalReplicaTransport = {
			async sync(request) {
				return authority.sync(request);
			},
			async snapshotChunk(request) {
				fetches.push(request.index);
				if (request.index === 1 && failuresLeft > 0) {
					failuresLeft -= 1;
					throw new Error('network died mid-snapshot');
				}
				return authority.snapshotChunk(request);
			},
		};
		const first = openLocal(path, flaky);
		await expect(first.replica.synchronize()).rejects.toThrow(
			'network died mid-snapshot',
		);
		first.native.close();

		const reopened = openLocal(path, flaky);
		await reopened.replica.synchronize();
		expect(fetches.filter((index) => index === 0)).toHaveLength(1);
		expect(rawPayload(reopened.native, 'row-a')).toEqual({ title: wide });
		expect(rawPayload(reopened.native, 'row-b')).toEqual({ title: wide });
		expect(() => rawPayload(reopened.native, 'row-c')).toThrow(
			'Missing canonical row',
		);
		reopened.native.close();
	} finally {
		authorityNative.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test('a capacity loser mirrors the authority no-op and surfaces a diagnostic', async () => {
	const root = mkdtempSync(join(tmpdir(), 'canonical-replica-'));
	const authorityNative = new Database(':memory:');
	try {
		const authority = openRecordAuthority({
			database: createBunSqliteAdapter(authorityNative),
			sha256,
		});
		// Seed the reserved KV aggregate near its cap.
		writerRound(authority, 'writer', 0, [
			{
				kind: 'patchRow',
				table: RESERVED_KV_TABLE,
				rowId: RESERVED_KV_ROW_ID,
				set: { big: 'x'.repeat(63 * 1024) },
				unset: [],
			},
		]);

		const diagnostics: CanonicalReplicaDiagnostic[] = [];
		const { native, replica } = openLocal(
			join(root, 'replica.sqlite3'),
			authorityTransport(authority),
			{ onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) },
		);

		// The loser writes BEFORE pulling the winner's near-cap image: fits
		// against its local base, folds to a no-op under authority order. The
		// replay over the freshly installed image mirrors that no-op.
		replica.admit({
			kind: 'patchRow',
			table: RESERVED_KV_TABLE,
			rowId: RESERVED_KV_ROW_ID,
			set: { more: 'y'.repeat(2 * 1024) },
			unset: [],
		});
		await replica.synchronize();

		const map = rawPayload(native, RESERVED_KV_ROW_ID, RESERVED_KV_TABLE);
		expect(Object.keys(map)).toEqual(['big']);
		expect(
			diagnostics.some((diagnostic) => diagnostic.reason === 'folded-to-noop'),
		).toBeTrue();
		expect(authority.inspect().rows[0]?.value).toEqual(map);
		native.close();
	} finally {
		authorityNative.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test('pulled schema-opaque state never creates local outbox commands', async () => {
	const root = mkdtempSync(join(tmpdir(), 'canonical-replica-'));
	const authorityNative = new Database(':memory:');
	try {
		const authority = openRecordAuthority({
			database: createBunSqliteAdapter(authorityNative),
			sha256,
		});
		writerRound(authority, 'writer', 0, [
			{
				kind: 'createRow',
				table: 'skills',
				rowId: 'remote',
				value: { title: 'Remote', futureField: { unknown: true } },
			},
		]);
		const { native, replica } = openLocal(
			join(root, 'replica.sqlite3'),
			authorityTransport(authority),
		);
		await replica.synchronize();
		expect(rawPayload(native, 'remote')).toEqual({
			title: 'Remote',
			futureField: { unknown: true },
		});
		expect(replica.status()).toMatchObject({
			pendingCommands: 0,
			hasInflightRound: false,
		});
		native.close();
	} finally {
		authorityNative.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test('open refuses legacy replica storage instead of migrating it', () => {
	const root = mkdtempSync(join(tmpdir(), 'canonical-replica-'));
	try {
		const native = new Database(join(root, 'legacy.sqlite3'), { create: true });
		native.run(`
			CREATE TABLE __epicenter_replica_quarantine (
				actor_id TEXT NOT NULL,
				actor_sequence INTEGER NOT NULL,
				reason TEXT NOT NULL,
				command_json TEXT NOT NULL
			)
		`);
		expect(() =>
			createCanonicalReplica({
				sqlite: createBunSqliteAdapter(native),
				transport: {
					async sync() {
						throw new Error('unused');
					},
					async snapshotChunk() {
						throw new Error('unused');
					},
				},
				sha256,
			}),
		).toThrow('Incompatible canonical replica storage');
		native.close();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
