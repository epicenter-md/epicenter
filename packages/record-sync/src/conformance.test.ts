import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
	type BrowserSqliteDatabase,
	createBrowserSqliteAdapter,
} from './adapters/browser.js';
import { createBunSqliteAdapter } from './adapters/bun.js';
import {
	createDurableObjectSqliteAdapter,
	type DurableObjectSqliteStorage,
} from './adapters/durable-object.js';
import { RECORD_SYNC_ADMISSION_LIMITS } from './admission.js';
import { createRecordAuthority } from './authority.js';
import { type Mutation, RECORD_SYNC_PROTOCOL_MAJOR } from './protocol.js';
import { isValidSnapshotChunk, isValidSnapshotManifest } from './snapshot.js';
import type { RecordSyncSqlite, SqliteValue } from './sqlite.js';

const envelope = {
	protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
	recordsEpoch: 'epoch-1',
} as const;
const recordsDescriptor = 'notes descriptor v1';
const identity = {
	...envelope,
	recordsDescriptor,
	recordsSchemaHash: 'notes-v1',
} as const;

const sha256 = async (value: string) =>
	createHash('sha256').update(value).digest('hex');

type OpenDatabase = () => {
	database: RecordSyncSqlite;
	close(): void;
};

function execute(
	database: Database,
	sql: string,
	parameters: readonly SqliteValue[],
): void {
	database.run(sql, [...parameters]);
}

function query<TRow>(
	database: Database,
	sql: string,
	parameters: readonly SqliteValue[],
): TRow[] {
	return database.query<TRow, SqliteValue[]>(sql).all(...parameters);
}

const adapters: [name: string, open: OpenDatabase][] = [
	[
		'Bun SQLite',
		() => {
			const sqlite = new Database(':memory:');
			return {
				database: createBunSqliteAdapter(sqlite),
				close: () => sqlite.close(),
			};
		},
	],
	[
		'browser SQLite OO1',
		() => {
			const sqlite = new Database(':memory:');
			const browser = {
				exec(options) {
					if (options.resultRows) {
						options.resultRows.push(
							...query(sqlite, options.sql, options.bind ?? []),
						);
						return;
					}
					execute(sqlite, options.sql, options.bind ?? []);
				},
				transaction(_qualifier, run) {
					return sqlite.transaction(run).immediate();
				},
			} satisfies BrowserSqliteDatabase;
			return {
				database: createBrowserSqliteAdapter(browser),
				close: () => sqlite.close(),
			};
		},
	],
	[
		'Durable Object SQLite',
		() => {
			const sqlite = new Database(':memory:');
			const storage = {
				sql: {
					exec<TRow>(sql: string, ...bindings: SqliteValue[]) {
						let rows: TRow[] = [];
						if (/^\s*(SELECT|WITH|PRAGMA)/i.test(sql))
							rows = query<TRow>(sqlite, sql, bindings);
						else execute(sqlite, sql, bindings);
						return { toArray: () => rows };
					},
				},
				transactionSync(run) {
					return sqlite.transaction(run).immediate();
				},
			} satisfies DurableObjectSqliteStorage;
			return {
				database: createDurableObjectSqliteAdapter(storage),
				close: () => sqlite.close(),
			};
		},
	],
];

async function runConformance(open: OpenDatabase) {
	const { database, close } = open();
	try {
		database.run('CREATE TABLE transaction_probe(value TEXT NOT NULL)');
		expect(() =>
			database.transaction(() => {
				database.run('INSERT INTO transaction_probe VALUES (?)', [
					'rolled-back',
				]);
				throw new Error('rollback');
			}),
		).toThrow('rollback');
		expect(
			database.all<{ count: number }>(
				'SELECT COUNT(*) AS count FROM transaction_probe',
			)[0]?.count,
		).toBe(0);

		const authority = createRecordAuthority({
			database,
			identity,
			sha256,
		});
		const first: Mutation = {
			actorId: 'actor-a',
			actorSequence: 1,
			operations: [
				{
					kind: 'createRow' as const,
					table: 'notes',
					rowId: 'n1',
					cells: { title: 'one', metadata: { tags: ['local-first'] } },
				},
				{
					kind: 'createRow' as const,
					table: 'notes',
					rowId: 'n2',
					cells: { title: 'two' },
				},
			],
		};
		const second: Mutation = {
			actorId: 'actor-a',
			actorSequence: 2,
			operations: [
				{ kind: 'deleteRow' as const, table: 'notes', rowId: 'n1' },
				// A delayed edit after physical deletion folds to an accepted no-op.
				{
					kind: 'updateRow' as const,
					table: 'notes',
					rowId: 'n1',
					cells: { title: 'cannot resurrect' },
				},
			],
		};
		expect(
			authority.push({
				kind: 'push',
				...envelope,
				mutations: [first, second],
			}),
		).toEqual({ kind: 'push', ok: true });
		expect(
			authority.push({ kind: 'push', ...envelope, mutations: [first] }),
		).toEqual({ kind: 'push', ok: true });
		expect(
			authority.push({
				kind: 'push',
				...envelope,
				mutations: [{ ...second, actorSequence: 4 }],
			}),
		).toEqual({
			kind: 'push',
			ok: false,
			reason: 'actor-sequence-gap',
		});
		expect(
			authority.push({
				kind: 'push',
				...envelope,
				mutations: [
					{
						actorId: 'actor-gap',
						actorSequence: 1,
						operations: [
							{
								kind: 'createRow',
								table: 'notes',
								rowId: 'must-roll-back',
								cells: { title: 'uncommitted prefix' },
							},
						],
					},
					{
						actorId: 'actor-gap',
						actorSequence: 3,
						operations: [
							{
								kind: 'createRow',
								table: 'notes',
								rowId: 'gap',
								cells: { title: 'gap' },
							},
						],
					},
				],
			}),
		).toEqual({
			kind: 'push',
			ok: false,
			reason: 'actor-sequence-gap',
		});
		expect(
			database.all<{ count: number }>(
				`SELECT COUNT(*) AS count FROM record_sync_canonical_rows
				 WHERE row_id IN ('must-roll-back', 'gap')`,
			)[0]?.count,
		).toBe(0);
		expect(
			database.all<{ count: number }>(
				`SELECT COUNT(*) AS count FROM record_sync_actor_high_water
				 WHERE actor_id = 'actor-gap'`,
			)[0]?.count,
		).toBe(0);
		expect(
			database.all<{ value: string }>(
				`SELECT value FROM record_sync_meta WHERE key = 'serverSequence'`,
			)[0]?.value,
		).toBe('2');
		// A duplicate create with a NEW sequence is a replica invariant
		// violation: the whole push rolls back and the actor stays paused.
		expect(
			authority.push({
				kind: 'push',
				...envelope,
				mutations: [
					{
						actorId: 'actor-a',
						actorSequence: 3,
						operations: [
							{
								kind: 'createRow' as const,
								table: 'notes',
								rowId: 'n2',
								cells: { title: 'duplicate' },
							},
						],
					},
				],
			}),
		).toEqual({ kind: 'push', ok: false, reason: 'create-conflict' });
		expect(
			database.all<{ title: string }>(
				`SELECT json_extract(cells_json, '$.title') AS title
				 FROM record_sync_canonical_rows WHERE row_id = 'n2'`,
			)[0]?.title,
		).toBe('two');

		const pull = authority.pull({
			kind: 'pull',
			...envelope,
			cursor: 0,
			limit: 100,
		});
		expect(pull.ok && !pull.snapshotRequired && pull.mutations).toHaveLength(2);

		const manifest = await authority.publishSnapshot({
			maxChunkBytes: RECORD_SYNC_ADMISSION_LIMITS.encodedSnapshotChunkBytes,
		});
		expect(manifest.actorHighWater).toEqual({ 'actor-a': 2 });
		expect(await isValidSnapshotManifest(sha256, manifest)).toBeTrue();
		const firstChunk = authority.snapshotChunk({
			kind: 'snapshotChunk',
			...envelope,
			generation: manifest.generation,
			index: 0,
		});
		if (!firstChunk.ok) throw new Error(firstChunk.reason);
		expect(await isValidSnapshotChunk(sha256, firstChunk.chunk)).toBeTrue();
		// Deletion is physical absence: the snapshot carries live rows only.
		expect(firstChunk.chunk.rows).toEqual([
			{
				table: 'notes',
				rowId: 'n2',
				cells: { title: 'two' },
			},
		]);

		const stalePull = authority.pull({
			kind: 'pull',
			...envelope,
			cursor: 0,
			limit: 100,
		});
		expect(stalePull).toMatchObject({
			kind: 'pull',
			ok: true,
			snapshotRequired: true,
		});

		createRecordAuthority({ database, identity, sha256 });
		expect(() =>
			createRecordAuthority({
				database,
				identity: { ...identity, recordsEpoch: '' },
				sha256,
			}),
		).toThrow('Invalid records epoch');
		expect(() =>
			createRecordAuthority({
				database,
				identity: { ...identity, recordsEpoch: 'wrong' },
				sha256,
			}),
		).toThrow('recordsEpoch');
	} finally {
		close();
	}
}

for (const [name, open] of adapters)
	test(`${name} passes record authority conformance`, async () => {
		await runConformance(open);
	});
