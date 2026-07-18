/**
 * Current-State Authority Adapter Conformance Tests
 *
 * Runs the new authority lifecycle against every supported SQLite adapter.
 * The same storage transactions must preserve receipts, current state, and
 * scalar rows in Bun, browser OO1, and Durable Object bindings.
 *
 * Key behaviors:
 * - Adapter transactions roll back atomically
 * - Accepted current state and receipts survive authority reopen
 * - Fixed pull and complete acquisition agree after compaction
 * - Bun and Durable Object adapters enforce document foreign keys and cascades
 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import {
	CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
	type CurrentStateWireRowIntent,
	rowRoundDigest,
} from '@epicenter/row-sync';
import type { SqliteDatabase, SqliteValue } from '@epicenter/sqlite';
import {
	type BrowserSqliteDatabase,
	createBrowserSqliteAdapter,
} from '@epicenter/sqlite/browser';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import {
	createDurableObjectSqliteAdapter,
	type DurableObjectSqliteStorage,
} from '@epicenter/sqlite/durable-object';
import * as Y from '@y/y';
import {
	type CurrentStateRowAuthority,
	openAccountRowAuthority,
} from './authority.js';

const ROW_ID = 'abc123def456ghi789jkl012';
const REPLICA_ID = 'rrrrrrrrrrrrrrrrrrrrrrrr';

type OpenDatabase = () => {
	database: SqliteDatabase;
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

for (const [name, open] of adapters) {
	test(`${name}: current state and receipt survive reopen and compaction`, () => {
		const { database, close } = open();
		try {
			database.run('CREATE TABLE transaction_probe(value TEXT NOT NULL)');
			expect(() =>
				database.transaction(() => {
					database.run("INSERT INTO transaction_probe VALUES ('rollback')");
					throw new Error('rollback');
				}),
			).toThrow('rollback');
			expect(
				database.all<{ count: number }>(
					'SELECT COUNT(*) AS count FROM transaction_probe',
				)[0]?.count,
			).toBe(0);

			const authority = openAccountRowAuthority({ database }).workspace(
				'workspace',
			);
			const intents: CurrentStateWireRowIntent[] = [
				{
					kind: 'create',
					table: 'notes',
					rowId: ROW_ID,
					fields: { title: 'one' },
				},
				{
					kind: 'update',
					table: 'notes',
					rowId: ROW_ID,
					fields: { set: { title: 'two' }, unset: [] },
				},
			];
			const requestDigest = rowRoundDigest(intents);
			expect(
				authority.push({
					protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
					kind: 'push',
					replicaId: REPLICA_ID,
					round: 1,
					requestDigest,
					intents,
				}),
			).toEqual({
				result: 'accepted',
				receipt: {
					acceptedRound: 1,
					requestDigest,
					appliedThrough: 2,
				},
			});

			const reopened = openAccountRowAuthority({ database }).workspace(
				'workspace',
			);
			const page = reopened.pull({
				protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
				kind: 'pull',
				replicaId: REPLICA_ID,
				after: 0,
			});
			expect(page).toMatchObject({
				result: 'page',
				through: 2,
				checkpoint: 2,
				receipt: { acceptedRound: 1, appliedThrough: 2 },
			});
			if (page.result !== 'page') throw new Error('Expected a pull page');
			expect(page.entries.filter(({ kind }) => kind === 'row')).toEqual([
				{
					kind: 'row',
					table: 'notes',
					rowId: ROW_ID,
					changedSequence: 2,
					fields: { title: 'two' },
				},
			]);

			expect(reopened.compactThrough(2)).toBe(2);
			const acquired = reopened.acquire({
				protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
				kind: 'acquire',
				replicaId: REPLICA_ID,
			});
			expect(acquired).toMatchObject({
				result: 'page',
				head: 2,
				retentionFloor: 2,
				receipt: {
					acceptedRound: 1,
					requestDigest,
					appliedThrough: 2,
				},
				rows: [
					{
						table: 'notes',
						rowId: ROW_ID,
						fields: { title: 'two' },
						changedSequence: 2,
					},
				],
			});
		} finally {
			close();
		}
	});
}

for (const [name, open] of adapters.filter(
	([name]) => name !== 'browser SQLite OO1',
)) {
	test(`${name}: document writes, deletion cascade, rollback, and schema reset are atomic`, () => {
		const { database, close } = open();
		try {
			const authority = openAccountRowAuthority({ database }).workspace(
				'workspace',
			);
			expect(
				database.all<{ foreign_keys: number }>('PRAGMA foreign_keys'),
			).toEqual([{ foreign_keys: 1 }]);
			const address = { table: 'notes', rowId: ROW_ID };
			expect(authority.documents.openIfLive(address)).toBeUndefined();

			push(authority, 1, [
				{
					kind: 'create',
					table: address.table,
					rowId: address.rowId,
					fields: { title: 'live' },
				},
			]);
			expect(authority.documents.openIfLive(address)).toEqual([]);
			const update = documentUpdate('persisted');
			expect(authority.documents.appendIfLive(address, update)).toBe(
				'appended',
			);
			expect(authority.documents.openIfLive(address)).toEqual([update]);
			database.run(
				`INSERT INTO row_authority_document_snapshots(
					workspace_id, table_name, row_id, snapshot
				) VALUES (?, ?, ?, ?)`,
				['workspace', address.table, address.rowId, update],
			);

			expect(() =>
				database.run(
					`INSERT INTO row_authority_document_updates(
							workspace_id, table_name, row_id, update_sequence,
							update_bytes
						) VALUES ('workspace', 'notes', 'missing', 1, ?)`,
					[update],
				),
			).toThrow();
			expect(() =>
				database.run(
					`INSERT INTO row_authority_document_snapshots(
							workspace_id, table_name, row_id, snapshot
						) VALUES ('workspace', 'notes', 'missing', ?)`,
					[update],
				),
			).toThrow();

			database.run(`
				CREATE TRIGGER fail_delete_commit
				BEFORE INSERT ON row_authority_row_changes
				WHEN NEW.sequence = 2
				BEGIN
					SELECT RAISE(ABORT, 'injected delete commit failure');
				END
			`);
			expect(() =>
				push(authority, 2, [
					{ kind: 'delete', table: address.table, rowId: address.rowId },
				]),
			).toThrow('injected delete commit failure');
			expect(authority.documents.openIfLive(address)).toEqual([update, update]);
			expect(
				database.all<{ count: number }>(
					`SELECT COUNT(*) AS count FROM row_authority_row_changes
					 WHERE deleted = 1`,
				)[0]?.count,
			).toBe(0);

			database.run('DROP TRIGGER fail_delete_commit');
			push(authority, 2, [
				{ kind: 'delete', table: address.table, rowId: address.rowId },
			]);
			expect(authority.documents.openIfLive(address)).toBeUndefined();
			expect(
				database.all<{ count: number }>(
					'SELECT COUNT(*) AS count FROM row_authority_document_updates',
				)[0]?.count,
			).toBe(0);
			expect(
				database.all<{ count: number }>(
					'SELECT COUNT(*) AS count FROM row_authority_document_snapshots',
				)[0]?.count,
			).toBe(0);

			push(authority, 3, [
				{
					kind: 'create',
					table: address.table,
					rowId: address.rowId,
					fields: { title: 'must not return' },
				},
			]);
			expect(authority.documents.openIfLive(address)).toBeUndefined();
			expect(
				database.all<{ count: number }>(
					'SELECT COUNT(*) AS count FROM row_authority_rows',
				)[0]?.count,
			).toBe(0);

			authority.compactThrough(3);
			push(authority, 4, [
				{
					kind: 'create',
					table: address.table,
					rowId: address.rowId,
					fields: { title: 'fresh after compaction' },
				},
			]);
			expect(authority.documents.openIfLive(address)).toEqual([]);
			expect(
				database.all<{ fields_json: string }>(
					`SELECT fields_json FROM row_authority_rows
					 WHERE workspace_id = 'workspace' AND table_name = 'notes'
					   AND row_id = ?`,
					[address.rowId],
				)[0]?.fields_json,
			).toBe('{"title":"fresh after compaction"}');

			database.run('DROP TABLE row_authority_document_updates');
			const reset = openAccountRowAuthority({ database }).workspace(
				'workspace',
			);
			expect(reset.documents.openIfLive(address)).toBeUndefined();
			expect(
				database.all<{ count: number }>(
					'SELECT COUNT(*) AS count FROM row_authority_replicas',
				)[0]?.count,
			).toBe(0);
			expect(
				database.all<{ name: string }>(
					`SELECT name FROM sqlite_master
				 WHERE type = 'table'
				   AND name IN (
					'row_authority_document_snapshots',
					'row_authority_document_updates'
				   ) ORDER BY name`,
				),
			).toEqual([
				{ name: 'row_authority_document_snapshots' },
				{ name: 'row_authority_document_updates' },
			]);
		} finally {
			close();
		}
	});
}

function push(
	authority: CurrentStateRowAuthority,
	round: number,
	intents: CurrentStateWireRowIntent[],
): void {
	const requestDigest = rowRoundDigest(intents);
	const response = authority.push({
		protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
		kind: 'push',
		replicaId: REPLICA_ID,
		round,
		requestDigest,
		intents,
	});
	expect(response).toMatchObject({
		result: 'accepted',
		receipt: { acceptedRound: round, requestDigest },
	});
}

function documentUpdate(value: string): Uint8Array {
	const document = new Y.Doc();
	try {
		let update: Uint8Array | undefined;
		document.on('updateV2', (candidate: Uint8Array) => {
			update = Uint8Array.from(candidate);
		});
		document.get('editor').insert(0, value);
		if (!update) throw new Error('Expected one Yjs 14 update');
		return update;
	} finally {
		document.destroy();
	}
}
