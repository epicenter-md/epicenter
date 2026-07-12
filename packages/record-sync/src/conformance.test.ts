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
import { createRecordAuthority } from './authority.js';
import type { Mutation } from './protocol.js';
import { isValidSnapshotChunk, isValidSnapshotManifest } from './snapshot.js';
import type { RecordSyncSqlite, SqliteValue } from './sqlite.js';

const envelope = {
	protocolMajor: 1,
	schemaEpochId: 'notes-v1',
	databaseIncarnationId: 'database-1',
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

		const authority = createRecordAuthority({ database, envelope, sha256 });
		const first: Mutation = {
			actorId: 'actor-a',
			actorSequence: 1,
			operations: [
				{
					kind: 'patchRow' as const,
					table: 'notes',
					rowId: 'n1',
					cells: { title: 'one', metadata: { tags: ['local-first'] } },
				},
				{
					kind: 'patchRow' as const,
					table: 'notes',
					rowId: 'n2',
					cells: { title: 'two' },
				},
			],
		};
		const second: Mutation = {
			actorId: 'actor-a',
			actorSequence: 2,
			operations: [{ kind: 'deleteRow' as const, table: 'notes', rowId: 'n1' }],
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
				schemaEpochId: 'wrong',
				mutations: [],
			}),
		).toEqual({ kind: 'push', ok: false, reason: 'schema-epoch-mismatch' });

		const pull = authority.pull({
			kind: 'pull',
			...envelope,
			cursor: 0,
			limit: 100,
		});
		expect(pull.ok && !pull.snapshotRequired && pull.mutations).toHaveLength(2);

		const manifest = await authority.publishSnapshot(1);
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
		expect(firstChunk.chunk.rows).toEqual([
			{ table: 'notes', rowId: 'n1', deleted: true, cells: {} },
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

		createRecordAuthority({ database, envelope, sha256 });
		expect(() =>
			createRecordAuthority({
				database,
				envelope: { ...envelope, databaseIncarnationId: 'wrong' },
				sha256,
			}),
		).toThrow('databaseIncarnationId');
	} finally {
		close();
	}
}

for (const [name, open] of adapters)
	test(`${name} passes record authority conformance`, async () => {
		await runConformance(open);
	});
