/**
 * Canonical Replica Tests
 *
 * Exercises durable RowIntent compaction, exact retry, crash recovery, and
 * multi-replica scalar/document convergence.
 *
 * Key behaviors:
 * - open intents compact without crossing the sealed boundary
 * - lost responses and restart retry the exact durable image
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
		let failBeforeTransmission = true;
		const transport: CanonicalReplicaTransport = {
			enroll: base.enroll,
			baselineScan: base.baselineScan,
			async sync(request) {
				if (failBeforeTransmission && request.sealedRound) {
					failBeforeTransmission = false;
					throw new Error('crashed before transmission');
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
			'crashed before transmission',
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

test('a fresh replica below the retention floor acquires a baseline and resumes incrementally', async () => {
	const authorityState = openTestAuthority();
	const seederDatabase = new Database(':memory:');
	const freshDatabase = new Database(':memory:');
	try {
		const seeder = openReplica(
			seederDatabase,
			createTestTransport(authorityState.authority),
		);
		seeder.admit({
			kind: 'create',
			table: 'notes',
			rowId: ROW_A,
			fields: { title: 'kept' },
			documentUpdate: encodeBase64(
				captureUpdate((doc) => doc.get('editor').insert(0, 'seeded')),
			),
		});
		seeder.admit({
			kind: 'create',
			table: 'notes',
			rowId: ROW_B,
			fields: { title: 'doomed' },
		});
		await seeder.synchronize();
		seeder.admit({ kind: 'delete', table: 'notes', rowId: ROW_B });
		await seeder.synchronize();
		// Bound authority history so incremental catch-up cannot start from zero.
		authorityState.authority.compactOutcomesThrough(3);

		let promotions = 0;
		const transport = createTestTransport(authorityState.authority);
		const fresh = createCanonicalReplica({
			sqlite: createBunSqliteAdapter(freshDatabase),
			transport,
			codec: { mergeUpdates: mergeDocumentUpdates },
			onBaselinePromoted: () => {
				promotions += 1;
			},
		});
		await fresh.synchronize();

		expect(promotions).toBe(1);
		expect(transport.baselineRequests.length).toBeGreaterThan(0);
		expect(fresh.readCurrentRow('notes', ROW_A)).toEqual({ title: 'kept' });
		expect(fresh.readCurrentRow('notes', ROW_B)).toBeUndefined();
		expect(readText(fresh.readCurrentDocumentParts('notes', ROW_A))).toBe(
			'seeded',
		);
		expect(
			freshDatabase
				.query<{ name: string }, []>(
					`SELECT name FROM sqlite_master
					 WHERE type = 'table' AND name LIKE 'baseline_scratch%'`,
				)
				.all(),
		).toEqual([]);

		// Ordinary catch-up resumes above the promoted checkpoint.
		const scans = transport.baselineRequests.length;
		seeder.admit({
			kind: 'update',
			table: 'notes',
			rowId: ROW_A,
			fields: { set: { title: 'later' }, unset: [] },
		});
		await seeder.synchronize();
		await fresh.synchronize();
		expect(fresh.readCurrentRow('notes', ROW_A)).toEqual({ title: 'later' });
		expect(transport.baselineRequests.length).toBe(scans);
	} finally {
		seederDatabase.close();
		freshDatabase.close();
		authorityState.database.close();
	}
});

test('baseline acquisition preserves authored intent and exact retry across the promotion', async () => {
	const authorityState = openTestAuthority();
	const offlineDatabase = new Database(':memory:');
	const seederDatabase = new Database(':memory:');
	try {
		const offline = openReplica(
			offlineDatabase,
			createTestTransport(authorityState.authority),
		);
		offline.admit({
			kind: 'create',
			table: 'notes',
			rowId: ROW_A,
			fields: { title: 'offline-base' },
		});
		await offline.synchronize();

		// The workspace moves on while the replica sleeps; history compacts
		// past its checkpoint.
		const seeder = openReplica(
			seederDatabase,
			createTestTransport(authorityState.authority),
		);
		for (const rowId of [ROW_B, ROW_C]) {
			seeder.admit({
				kind: 'create',
				table: 'notes',
				rowId,
				fields: { title: `seeded-${rowId}` },
			});
			await seeder.synchronize();
		}
		authorityState.authority.compactOutcomesThrough(
			authorityState.authority.inspect().head,
		);

		// Durable local work authored before the gap surfaced: it must ride
		// through acquisition untouched and fold exactly once.
		offline.admit({
			kind: 'update',
			table: 'notes',
			rowId: ROW_A,
			fields: { set: { title: 'authored-offline' }, unset: [] },
		});
		await offline.synchronize();

		expect(offline.readCurrentRow('notes', ROW_A)).toEqual({
			title: 'authored-offline',
		});
		expect(offline.readCurrentRow('notes', ROW_B)).toEqual({
			title: `seeded-${ROW_B}`,
		});
		expect(offline.status()).toMatchObject({
			pendingIntents: 0,
			hasInflightRound: false,
		});
		expect(
			authorityState.authority.inspect().rows.find((row) => row.rowId === ROW_A)
				?.fields,
		).toEqual({ title: 'authored-offline' });
	} finally {
		offlineDatabase.close();
		seederDatabase.close();
		authorityState.database.close();
	}
});

test('a compaction floor overtaking the anchor restarts acquisition from scratch', async () => {
	const authorityState = openTestAuthority();
	const seederDatabase = new Database(':memory:');
	const freshDatabase = new Database(':memory:');
	try {
		const seeder = openReplica(
			seederDatabase,
			createTestTransport(authorityState.authority),
		);
		for (const rowId of [ROW_A, ROW_B, ROW_C]) {
			seeder.admit({
				kind: 'create',
				table: 'notes',
				rowId,
				fields: { title: rowId },
			});
			await seeder.synchronize();
		}
		authorityState.authority.compactOutcomesThrough(1);

		// Between the fresh replica's first scan page and the next, the
		// seeder keeps writing and the authority compacts past the anchor.
		const transport = createTestTransport(authorityState.authority);
		const rawBaselineScan = transport.baselineScan.bind(transport);
		let racedOnce = false;
		transport.baselineScan = async (request) => {
			const response = await rawBaselineScan(request);
			if (!racedOnce) {
				racedOnce = true;
				seeder.admit({
					kind: 'update',
					table: 'notes',
					rowId: ROW_A,
					fields: { set: { title: 'post-anchor' }, unset: [] },
				});
				await seeder.synchronize();
				authorityState.authority.compactOutcomesThrough(
					authorityState.authority.inspect().head,
				);
			}
			return response;
		};
		const fresh = openReplica(freshDatabase, transport);
		await fresh.synchronize();

		// Two anchor attempts: the raced one and the clean restart.
		const anchorScans = transport.baselineRequests.filter(
			(request) => request.after === undefined,
		);
		expect(anchorScans.length).toBeGreaterThanOrEqual(2);
		expect(fresh.readCurrentRow('notes', ROW_A)).toEqual({
			title: 'post-anchor',
		});
		expect(fresh.readCurrentRow('notes', ROW_C)).toEqual({ title: ROW_C });
	} finally {
		seederDatabase.close();
		freshDatabase.close();
		authorityState.database.close();
	}
});

test('stale scratch from a crashed acquisition is dropped on the next open', () => {
	const database = new Database(':memory:');
	try {
		const sqlite = createBunSqliteAdapter(database);
		initializeCanonicalSchema(sqlite);
		// A crash mid-acquisition leaves only disposable scratch behind.
		database.run(`
			CREATE TABLE baseline_scratch_rows (
				table_key TEXT NOT NULL, row_id TEXT NOT NULL,
				fields_json TEXT NOT NULL, PRIMARY KEY (table_key, row_id)
			);
		`);
		database.run(
			`INSERT INTO baseline_scratch_rows VALUES ('notes', ?, '{"stale":true}')`,
			[ROW_A],
		);
		const authorityState = openTestAuthority();
		try {
			openReplica(database, createTestTransport(authorityState.authority));
			expect(
				database
					.query<{ name: string }, []>(
						`SELECT name FROM sqlite_master
						 WHERE type = 'table' AND name LIKE 'baseline_scratch%'`,
					)
					.all(),
			).toEqual([]);
		} finally {
			authorityState.database.close();
		}
	} finally {
		database.close();
	}
});
