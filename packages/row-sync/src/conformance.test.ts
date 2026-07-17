/**
 * Row Authority Adapter Conformance Tests
 *
 * Runs the schema-blind RowIntent contract against every supported SQLite
 * adapter: enrollment, atomic sealed-round folds, composite outcome paging,
 * and transaction rollback.
 */

import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import {
	type BrowserSqliteDatabase,
	createBrowserSqliteAdapter,
} from './adapters/browser.js';
import { createBunSqliteAdapter } from './adapters/bun.js';
import {
	createDurableObjectSqliteAdapter,
	type DurableObjectSqliteStorage,
} from './adapters/durable-object.js';
import { type DocumentCodec, openRowAuthority } from './authority.js';
import {
	encodeBase64,
	ROW_SYNC_PROTOCOL_MAJOR,
	type WireRowIntent,
} from './protocol.js';
import { rowRoundDigest } from './round-digest.js';
import type { RowSyncSqlite, SqliteValue } from './sqlite.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const codec: DocumentCodec = {
	mergedCompactState(parts) {
		const tokens = new Set<string>();
		for (const part of parts) {
			for (const token of JSON.parse(decoder.decode(part)) as string[]) {
				tokens.add(token);
			}
		}
		return encoder.encode(JSON.stringify([...tokens].sort()));
	},
};

type OpenDatabase = () => {
	database: RowSyncSqlite;
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

const ROW_ID = 'abc123def456ghi789jkl012';

const intents: WireRowIntent[] = [
	{
		kind: 'create',
		table: 'skills',
		rowId: ROW_ID,
		fields: { title: 'Initial', unknown: { preserved: true } },
		documentUpdate: encodeBase64(encoder.encode(JSON.stringify(['seed']))),
	},
	{
		kind: 'update',
		table: 'skills',
		rowId: ROW_ID,
		fields: { set: { title: 'Updated', nullable: null }, unset: [] },
	},
];

for (const [name, open] of adapters) {
	test(`${name}: composite outcomes persist across authority reopen`, () => {
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

			const authority = openRowAuthority({ database, codec });
			const enrolled = authority.enroll({
				protocolMajor: ROW_SYNC_PROTOCOL_MAJOR,
				kind: 'enroll',
			});
			if (!enrolled.ok) throw new Error('Enrollment failed');

			const accepted = authority.sync({
				protocolMajor: ROW_SYNC_PROTOCOL_MAJOR,
				kind: 'sync',
				token: {
					replicaId: enrolled.replicaId,
					acceptedRound: 0,
					checkpoint: 0,
				},
				sealedRound: {
					round: 1,
					requestDigest: rowRoundDigest(intents),
					submission: 1,
					intents,
				},
			});
			expect(accepted).toMatchObject({
				kind: 'sync',
				ok: true,
				result: 'page',
				token: {
					replicaId: enrolled.replicaId,
					acceptedRound: 1,
					checkpoint: 2,
				},
			});

			const reopened = openRowAuthority({ database, codec });
			expect(
				reopened.sync({
					protocolMajor: ROW_SYNC_PROTOCOL_MAJOR,
					kind: 'sync',
					token: {
						replicaId: enrolled.replicaId,
						acceptedRound: 1,
						checkpoint: 0,
					},
					pageLimit: 1,
				}),
			).toEqual({
				kind: 'sync',
				ok: true,
				result: 'page',
				token: {
					replicaId: enrolled.replicaId,
					acceptedRound: 1,
					checkpoint: 1,
				},
				outcomes: [
					{
						kind: 'row',
						table: 'skills',
						rowId: ROW_ID,
						fields: { title: 'Initial', unknown: { preserved: true } },
						documentUpdate: encodeBase64(
							encoder.encode(JSON.stringify(['seed'])),
						),
						sequence: 1,
					},
				],
				hasMore: true,
				retentionFloor: 0,
			});

			const reopenedAgain = openRowAuthority({ database, codec });
			expect(
				reopenedAgain.sync({
					protocolMajor: ROW_SYNC_PROTOCOL_MAJOR,
					kind: 'sync',
					token: {
						replicaId: enrolled.replicaId,
						acceptedRound: 1,
						checkpoint: 1,
					},
					pageLimit: 1,
				}),
			).toEqual({
				kind: 'sync',
				ok: true,
				result: 'page',
				token: {
					replicaId: enrolled.replicaId,
					acceptedRound: 1,
					checkpoint: 2,
				},
				outcomes: [
					{
						kind: 'row',
						table: 'skills',
						rowId: ROW_ID,
						fields: {
							title: 'Updated',
							unknown: { preserved: true },
							nullable: null,
						},
						sequence: 2,
					},
				],
				hasMore: false,
				retentionFloor: 0,
			});
		} finally {
			close();
		}
	});
}
