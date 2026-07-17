/**
 * Canonical Replica Tests
 *
 * Exercises durable RowIntent compaction, exact retry, crash recovery,
 * capacity-refusal resealing, and multi-replica scalar/document convergence.
 *
 * Key behaviors:
 * - open intents compact without crossing the sealed boundary
 * - lost responses and restart retry the exact durable image
 * - delete-only capacity recovery preserves queued growth
 * - authority order and Yjs merge converge two replicas
 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeBase64, type SyncRequest } from '@epicenter/row-sync';
import { createBunSqliteAdapter } from '@epicenter/row-sync/bun';
import * as Y from '@y/y';
import { mergeDocumentUpdates } from './canonical-documents.js';
import {
	type CanonicalReplicaTransport,
	createCanonicalReplica,
	initializeCanonicalSchema,
} from './canonical-replica.js';
import {
	captureUpdate,
	createTestTransport,
	openTestAuthority,
	readText,
} from './row-sync-test-utils.js';

const ROW_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const ROW_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const ROW_C = 'cccccccccccccccccccccccc';

function openReplica(database: Database, transport: CanonicalReplicaTransport) {
	return createCanonicalReplica({
		sqlite: createBunSqliteAdapter(database),
		transport,
		codec: { mergeUpdates: mergeDocumentUpdates },
	});
}

test('same-address open intents compact create/update/delete combinations', () => {
	const database = new Database(':memory:');
	try {
		const sqlite = createBunSqliteAdapter(database);
		initializeCanonicalSchema(sqlite);
		const authorityState = openTestAuthority();
		try {
			const replica = openReplica(
				database,
				createTestTransport(authorityState.authority),
			);
			replica.admit({
				kind: 'create',
				table: 'notes',
				rowId: ROW_A,
				fields: { title: 'one', removed: true },
			});
			replica.admit({
				kind: 'update',
				table: 'notes',
				rowId: ROW_A,
				fields: { set: { title: 'two' }, unset: ['removed'] },
			});
			expect(replica.readCurrentRow('notes', ROW_A)).toEqual({ title: 'two' });
			expect(
				database
					.query<{ kind: string; fields_json: string }, []>(
						'SELECT kind, fields_json FROM intents',
					)
					.get(),
			).toMatchObject({ kind: 'create' });

			replica.admit({ kind: 'delete', table: 'notes', rowId: ROW_A });
			expect(database.query('SELECT * FROM intents').all()).toEqual([]);

			sqlite.run(
				'INSERT INTO rows(table_key, row_id, fields_json) VALUES (?, ?, ?)',
				['notes', ROW_B, JSON.stringify({ count: 0, keep: true })],
			);
			replica.admit({
				kind: 'update',
				table: 'notes',
				rowId: ROW_B,
				fields: { set: { count: 1 }, unset: [] },
			});
			replica.admit({
				kind: 'update',
				table: 'notes',
				rowId: ROW_B,
				fields: { set: { count: 2 }, unset: ['keep'] },
			});
			expect(replica.readCurrentRow('notes', ROW_B)).toEqual({ count: 2 });
			replica.admit({ kind: 'delete', table: 'notes', rowId: ROW_B });
			expect(
				database
					.query<{ kind: string }, [string]>(
						'SELECT kind FROM intents WHERE row_id = ?',
					)
					.get(ROW_B)?.kind,
			).toBe('delete');
		} finally {
			authorityState.database.close();
		}
	} finally {
		database.close();
	}
});

test('merged scalar intent bounds fail atomically and preserve the older open intent', () => {
	const authorityState = openTestAuthority();
	const database = new Database(':memory:');
	try {
		const replica = openReplica(
			database,
			createTestTransport(authorityState.authority),
		);
		const olderUnset = Array.from({ length: 80 }, (_, index) => `old${index}`);
		const newerUnset = Array.from({ length: 80 }, (_, index) => `new${index}`);
		replica.admit({
			kind: 'update',
			table: 'notes',
			rowId: ROW_A,
			fields: { set: {}, unset: olderUnset },
		});
		expect(() =>
			replica.admit({
				kind: 'update',
				table: 'notes',
				rowId: ROW_A,
				fields: { set: {}, unset: newerUnset },
			}),
		).toThrow('Invalid row intent');
		const stored = database
			.query<{ fields_json: string }, []>(
				'SELECT fields_json FROM intents WHERE row_id = "aaaaaaaaaaaaaaaaaaaaaaaa"',
			)
			.get();
		expect(JSON.parse(stored?.fields_json ?? '{}').unset).toEqual(olderUnset);
	} finally {
		database.close();
		authorityState.database.close();
	}
});

test('field-change composition preserves prototype-named keys without pollution', () => {
	const authorityState = openTestAuthority();
	const database = new Database(':memory:');
	try {
		const replica = openReplica(
			database,
			createTestTransport(authorityState.authority),
		);
		replica.admit({
			kind: 'update',
			table: 'notes',
			rowId: ROW_A,
			fields: {
				set: JSON.parse('{"__proto__":{"polluted":true},"keep":1}'),
				unset: [],
			},
		});
		replica.admit({
			kind: 'update',
			table: 'notes',
			rowId: ROW_A,
			fields: {
				set: JSON.parse('{"constructor":"stored"}'),
				unset: [],
			},
		});
		const stored = database
			.query<{ fields_json: string }, []>(
				'SELECT fields_json FROM intents WHERE row_id = "aaaaaaaaaaaaaaaaaaaaaaaa"',
			)
			.get();
		const fields = JSON.parse(stored?.fields_json ?? '{}').set;
		expect(Object.hasOwn(fields, '__proto__')).toBe(true);
		expect(Object.hasOwn(fields, 'constructor')).toBe(true);
		expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
	} finally {
		database.close();
		authorityState.database.close();
	}
});

test('transient oversized updates compact before wire bounds are enforced', () => {
	const authorityState = openTestAuthority();
	const database = new Database(':memory:');
	try {
		const replica = openReplica(
			database,
			createTestTransport(authorityState.authority),
		);
		const source = new Y.Doc({ gc: false });
		let update: Uint8Array | undefined;
		source.on('update', (emitted) => {
			update = Uint8Array.from(emitted);
		});
		source.transact(() => {
			const editor = source.get('editor');
			editor.insert(0, 'x'.repeat(400 * 1024));
			editor.delete(0, 400 * 1024);
		});
		source.destroy();
		if (!update) throw new Error('Expected a transient document update');
		expect(update.byteLength).toBeGreaterThan(384 * 1024);
		replica.admit({
			kind: 'update',
			table: 'notes',
			rowId: ROW_A,
			documentUpdate: encodeBase64(update),
		});
		const stored = database
			.query<{ bytes: number }, []>(
				'SELECT length(document_update) AS bytes FROM intents',
			)
			.get()?.bytes;
		expect(stored).toBeLessThan(256 * 1024);
	} finally {
		database.close();
		authorityState.database.close();
	}
});

test('field-only, document-only, and combined updates fold in one replica', async () => {
	const authorityState = openTestAuthority();
	const transport = createTestTransport(authorityState.authority);
	const database = new Database(':memory:');
	try {
		const replica = openReplica(database, transport);
		replica.admit({
			kind: 'create',
			table: 'notes',
			rowId: ROW_A,
			fields: { title: 'created' },
		});
		await replica.synchronize();

		const firstUpdate = captureUpdate((doc) =>
			doc.get('editor').insert(0, 'A'),
		);
		replica.admit({
			kind: 'update',
			table: 'notes',
			rowId: ROW_A,
			documentUpdate: encodeBase64(firstUpdate),
		});
		await replica.synchronize();

		const current = new Y.Doc();
		for (const part of replica.readCurrentDocumentParts('notes', ROW_A)) {
			Y.applyUpdate(current, part);
		}
		let combined: Uint8Array | undefined;
		current.on('update', (update) => {
			combined = Uint8Array.from(update);
		});
		current.get('editor').insert(1, 'B');
		if (!combined) throw new Error('Expected combined document update');
		replica.admit({
			kind: 'update',
			table: 'notes',
			rowId: ROW_A,
			fields: { set: { title: 'combined' }, unset: [] },
			documentUpdate: encodeBase64(combined),
		});
		current.destroy();
		await replica.synchronize();

		expect(replica.readCurrentRow('notes', ROW_A)).toEqual({
			title: 'combined',
		});
		expect(readText(replica.readCurrentDocumentParts('notes', ROW_A))).toBe(
			'AB',
		);
		expect(authorityState.authority.inspect().documentUpdates).toHaveLength(2);
	} finally {
		database.close();
		authorityState.database.close();
	}
});

test('lost accepted response retries the exact round without refolding', async () => {
	const authorityState = openTestAuthority();
	const base = createTestTransport(authorityState.authority);
	let dropFirstAcceptedResponse = true;
	const requests: SyncRequest[] = [];
	const transport: CanonicalReplicaTransport = {
		enroll: base.enroll,
		baselineScan: base.baselineScan,
		async sync(request) {
			requests.push(structuredClone(request));
			const response = await base.sync(request);
			if (dropFirstAcceptedResponse && request.sealedRound) {
				dropFirstAcceptedResponse = false;
				throw new Error('accepted response was lost');
			}
			return response;
		},
	};
	const database = new Database(':memory:');
	try {
		const replica = openReplica(database, transport);
		replica.admit({
			kind: 'create',
			table: 'notes',
			rowId: ROW_A,
			fields: { title: 'once' },
		});
		await expect(replica.synchronize()).rejects.toThrow(
			'accepted response was lost',
		);
		await replica.synchronize();
		const sealed = requests.filter((request) => request.sealedRound);
		expect(sealed).toHaveLength(2);
		expect(sealed[0]?.sealedRound?.requestDigest).toBe(
			sealed[1]?.sealedRound?.requestDigest,
		);
		expect(sealed[0]?.sealedRound?.intents).toEqual(
			sealed[1]?.sealedRound?.intents,
		);
		expect(authorityState.authority.inspect().head).toBe(1);
	} finally {
		database.close();
		authorityState.database.close();
	}
});

test('restart after sealing retries the same digest from the SQLite file', async () => {
	const root = mkdtempSync(join(tmpdir(), 'epicenter-replica-crash-'));
	const path = join(root, 'workspace.sqlite3');
	const authorityState = openTestAuthority();
	try {
		const base = createTestTransport(authorityState.authority);
		let failBeforeSubmission = true;
		const transport: CanonicalReplicaTransport = {
			enroll: base.enroll,
			baselineScan: base.baselineScan,
			async sync(request) {
				if (failBeforeSubmission && request.sealedRound) {
					failBeforeSubmission = false;
					throw new Error('crashed before submission');
				}
				return base.sync(request);
			},
		};
		let database = new Database(path, { create: true });
		let replica = openReplica(database, transport);
		replica.admit({
			kind: 'create',
			table: 'notes',
			rowId: ROW_A,
			fields: { title: 'durable image' },
		});
		await expect(replica.synchronize()).rejects.toThrow(
			'crashed before submission',
		);
		const digest = database
			.query<{ in_flight_request_digest: string }, []>(
				'SELECT in_flight_request_digest FROM replica WHERE id = 1',
			)
			.get()?.in_flight_request_digest;
		database.close();

		database = new Database(path);
		const restartedTransport = createTestTransport(authorityState.authority);
		replica = openReplica(database, restartedTransport);
		await replica.synchronize();
		expect(
			restartedTransport.syncRequests.find((request) => request.sealedRound)
				?.sealedRound?.requestDigest,
		).toBe(digest);
		expect(authorityState.authority.inspect().rows[0]?.fields).toEqual({
			title: 'durable image',
		});
		database.close();
	} finally {
		authorityState.database.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test('capacity refusal reseals deletes first and keeps growth queued', async () => {
	const authorityState = openTestAuthority();
	const transport = createTestTransport(authorityState.authority);
	const database = new Database(':memory:');
	try {
		const replica = openReplica(database, transport);
		replica.admit({
			kind: 'create',
			table: 'notes',
			rowId: ROW_A,
			fields: { title: 'remove' },
		});
		await replica.synchronize();
		const before = transport.syncRequests.length;
		replica.admit({ kind: 'delete', table: 'notes', rowId: ROW_A });
		replica.admit({
			kind: 'create',
			table: 'notes',
			rowId: ROW_B,
			fields: { title: 'queued growth' },
		});
		transport.setGrowth('delete-only');
		const blocked = await replica.synchronize();
		const submitted = transport.syncRequests
			.slice(before)
			.filter((request) => request.sealedRound)
			.map((request) => request.sealedRound!);
		expect(submitted[0]?.round).toBe(submitted[1]?.round);
		expect(submitted[0]?.intents.map((intent) => intent.kind).sort()).toEqual([
			'create',
			'delete',
		]);
		expect(submitted[1]?.intents.map((intent) => intent.kind)).toEqual([
			'delete',
		]);
		expect(blocked.capacityBlocked).toBe(true);
		expect(blocked.pendingIntents).toBe(1);
		expect(authorityState.authority.inspect().rows).toEqual([]);

		transport.setGrowth('allow');
		await replica.synchronize();
		expect(authorityState.authority.inspect().rows[0]).toMatchObject({
			rowId: ROW_B,
			fields: { title: 'queued growth' },
		});
	} finally {
		database.close();
		authorityState.database.close();
	}
});

test('deletion notifications run after the installed page commits', async () => {
	const authorityState = openTestAuthority();
	const writerDatabase = new Database(':memory:');
	const readerDatabase = new Database(':memory:');
	try {
		const transport = createTestTransport(authorityState.authority);
		const writer = openReplica(writerDatabase, transport);
		writer.admit({
			kind: 'create',
			table: 'notes',
			rowId: ROW_A,
			fields: { title: 'remove' },
		});
		await writer.synchronize();

		const reader = createCanonicalReplica({
			sqlite: createBunSqliteAdapter(readerDatabase),
			transport: createTestTransport(authorityState.authority),
			codec: { mergeUpdates: mergeDocumentUpdates },
			onRowsDeleted() {
				throw new Error('deletion notification failed');
			},
		});
		await reader.synchronize();
		writer.admit({ kind: 'delete', table: 'notes', rowId: ROW_A });
		await writer.synchronize();

		await expect(reader.synchronize()).rejects.toThrow(
			'deletion notification failed',
		);
		expect(readerDatabase.query('SELECT * FROM rows').all()).toEqual([]);
		expect(
			readerDatabase
				.query<{ checkpoint: number }, []>(
					'SELECT checkpoint FROM replica WHERE id = 1',
				)
				.get()?.checkpoint,
		).toBe(authorityState.authority.inspect().head);
	} finally {
		writerDatabase.close();
		readerDatabase.close();
		authorityState.database.close();
	}
});

test('two replicas converge by scalar acceptance order and Yjs merge', async () => {
	const authorityState = openTestAuthority();
	const firstDatabase = new Database(':memory:');
	const secondDatabase = new Database(':memory:');
	try {
		const first = openReplica(
			firstDatabase,
			createTestTransport(authorityState.authority),
		);
		const second = openReplica(
			secondDatabase,
			createTestTransport(authorityState.authority),
		);
		first.admit({
			kind: 'create',
			table: 'notes',
			rowId: ROW_C,
			fields: { title: 'initial' },
		});
		await first.synchronize();
		await second.synchronize();

		first.admit({
			kind: 'update',
			table: 'notes',
			rowId: ROW_C,
			fields: { set: { title: 'first' }, unset: [] },
		});
		second.admit({
			kind: 'update',
			table: 'notes',
			rowId: ROW_C,
			fields: { set: { title: 'second' }, unset: [] },
		});
		first.admit({
			kind: 'update',
			table: 'notes',
			rowId: ROW_C,
			documentUpdate: encodeBase64(
				captureUpdate((doc) => doc.get('editor').insert(0, 'A')),
			),
		});
		second.admit({
			kind: 'update',
			table: 'notes',
			rowId: ROW_C,
			documentUpdate: encodeBase64(
				captureUpdate((doc) => doc.get('editor').insert(0, 'B')),
			),
		});
		await first.synchronize();
		await second.synchronize();
		await first.synchronize();

		expect(first.readCurrentRow('notes', ROW_C)?.title).toBe('second');
		expect(second.readCurrentRow('notes', ROW_C)?.title).toBe('second');
		const firstText = readText(first.readCurrentDocumentParts('notes', ROW_C));
		const secondText = readText(
			second.readCurrentDocumentParts('notes', ROW_C),
		);
		expect(firstText).toBe(secondText);
		expect([...firstText].sort().join('')).toBe('AB');
	} finally {
		firstDatabase.close();
		secondDatabase.close();
		authorityState.database.close();
	}
});
