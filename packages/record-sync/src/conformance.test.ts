/**
 * Record Authority Adapter Conformance Tests
 *
 * Runs the schema-blind current-state contract against every supported SQLite
 * adapter.
 *
 * Key behaviors:
 * - atomic pushes and server-ordered current-state pulls
 * - snapshot publication and validation
 * - transaction rollback in every adapter
 */

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
import { openRecordAuthority } from './authority.js';
import { type PushRequest, RECORD_SYNC_PROTOCOL_MAJOR } from './protocol.js';
import { isValidSnapshotChunk, isValidSnapshotManifest } from './snapshot.js';
import type { RecordSyncSqlite, SqliteValue } from './sqlite.js';

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
						if (/^\s*(SELECT|WITH|PRAGMA)/i.test(sql)) {
							rows = query<TRow>(sqlite, sql, bindings);
						} else {
							execute(sqlite, sql, bindings);
						}
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

function batch(): PushRequest {
	return {
		protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
		kind: 'push',
		actorId: 'actor-a',
		mutations: [
			{
				actorSequence: 1,
				command: {
					kind: 'createRow',
					table: 'skills',
					rowId: 'skill-1',
					value: { title: 'Initial', unknown: { preserved: true } },
				},
			},
			{
				actorSequence: 2,
				command: {
					kind: 'patchRow',
					table: 'skills',
					rowId: 'skill-1',
					set: { title: 'Updated', nullable: null },
					unset: [],
				},
			},
		],
	};
}

for (const [name, open] of adapters) {
	test(`${name}: atomic push publishes current state and snapshot`, async () => {
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

			const authority = openRecordAuthority({ database, sha256 });
			expect(authority.push(batch())).toMatchObject({
				ok: true,
				acceptance: 'accepted',
			});
			expect(
				authority.pull({
					protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
					kind: 'pull',
					cursor: 0,
					limit: 100,
				}),
			).toEqual({
				kind: 'pull',
				ok: true,
				snapshotRequired: false,
				fromCursor: 0,
				entries: [
					{
						kind: 'row',
						table: 'skills',
						rowId: 'skill-1',
						value: {
							title: 'Updated',
							unknown: { preserved: true },
							nullable: null,
						},
						lastServerSequence: 2,
					},
				],
				newCursor: 2,
				hasMore: false,
			});

			const manifest = await authority.publishSnapshot({
				maxChunkBytes: 512 * 1024,
			});
			if (!manifest) throw new Error('Expected stable snapshot publication');
			expect(await isValidSnapshotManifest(sha256, manifest)).toBeTrue();
			const response = authority.snapshotChunk({
				protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
				kind: 'snapshotChunk',
				generation: manifest.generation,
				index: 0,
			});
			if (!response.ok) throw new Error(response.reason);
			expect(await isValidSnapshotChunk(sha256, response.chunk)).toBeTrue();
		} finally {
			close();
		}
	});
}
