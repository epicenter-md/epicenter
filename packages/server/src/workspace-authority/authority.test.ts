/**
 * Current-State Row Authority Tests
 *
 * Verifies current-state folding, fixed-head pull pagination, compaction,
 * acquisition, retry safety, and the authorized reset-only storage cutover.
 *
 * Key behaviors:
 * - Every accepted intent advances the head while only successful effects mark rows
 * - Exact retries never refold and ambiguous lineage stops without mutation
 * - Fixed pages preserve moving rows and drain no-op gaps
 * - Acquisition and compaction preserve current state and permanent receipts
 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import {
	CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
	type CurrentStateWireRowIntent,
	rowRoundDigest,
} from '@epicenter/row-sync';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import * as Y from '@y/y';
import {
	ACCOUNT_AUTHORITY_WALL,
	type CurrentStateRowAuthority,
	openAccountRowAuthority,
} from './authority.js';

const ROW_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const ROW_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const ROW_C = 'cccccccccccccccccccccccc';
const ROW_BEHIND = '000000000000000000000000';
const REPLICA_ID = 'rrrrrrrrrrrrrrrrrrrrrrrr';

function setup() {
	const sqlite = new Database(':memory:');
	const database = createBunSqliteAdapter(sqlite);
	const authority = openAccountRowAuthority({ database }).workspace(
		'workspace',
	);
	return {
		authority,
		database,
		replicaId: REPLICA_ID,
		close: () => sqlite.close(),
	};
}

function push(
	authority: CurrentStateRowAuthority,
	replicaId: string,
	round: number,
	intents: CurrentStateWireRowIntent[],
) {
	return authority.push({
		protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
		kind: 'push',
		replicaId,
		round,
		requestDigest: rowRoundDigest(intents),
		intents,
	});
}

test('accepted no-op advances the receipt and final pull drains its gap', () => {
	const { authority, replicaId, close } = setup();
	try {
		const intents: CurrentStateWireRowIntent[] = [
			{
				kind: 'create',
				table: 'notes',
				rowId: ROW_A,
				fields: { title: 'one' },
			},
			{
				kind: 'update',
				table: 'notes',
				rowId: ROW_A,
				fields: { set: { title: 'two' }, unset: [] },
			},
			{
				kind: 'update',
				table: 'notes',
				rowId: ROW_B,
				fields: { set: { absent: true }, unset: [] },
			},
		];
		expect(push(authority, replicaId, 1, intents)).toEqual({
			result: 'accepted',
			receipt: {
				acceptedRound: 1,
				requestDigest: rowRoundDigest(intents),
				appliedThrough: 3,
			},
		});

		const first = authority.pull({
			protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
			kind: 'pull',
			replicaId,
			after: 0,
			pageLimit: 1,
		});
		expect(first).toMatchObject({
			result: 'page',
			through: 3,
			checkpoint: 1,
		});
		if (first.result !== 'page') throw new Error('Expected a pull page');
		expect(first.entries).toEqual([
			{
				kind: 'row',
				table: 'notes',
				rowId: ROW_A,
				changedSequence: 2,
				fields: { title: 'two' },
			},
		]);

		const final = authority.pull({
			protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
			kind: 'pull',
			replicaId,
			after: first.checkpoint,
			through: first.through,
			pageLimit: 1,
		});
		expect(final).toMatchObject({
			result: 'page',
			through: 3,
			checkpoint: 3,
		});
		if (final.result !== 'page') throw new Error('Expected a pull page');
		expect(final.entries).toEqual([
			{
				kind: 'row',
				table: 'notes',
				rowId: ROW_A,
				changedSequence: 2,
				fields: { title: 'two' },
			},
		]);
	} finally {
		close();
	}
});

test('updates, unsets, and deletes against absence write no marker', () => {
	const { authority, database, replicaId, close } = setup();
	try {
		push(authority, replicaId, 1, [
			{
				kind: 'update',
				table: 'notes',
				rowId: ROW_A,
				fields: { set: {}, unset: ['title'] },
			},
			{ kind: 'delete', table: 'notes', rowId: ROW_B },
		]);
		expect(
			database.all<{ count: number }>(
				'SELECT COUNT(*) AS count FROM row_authority_rows',
			)[0]?.count,
		).toBe(0);
		expect(
			database.all<{ count: number }>(
				'SELECT COUNT(*) AS count FROM row_authority_row_changes',
			)[0]?.count,
		).toBe(0);
	} finally {
		close();
	}
});

test('same first push retries one permanent receipt across reopen', () => {
	const sqlite = new Database(':memory:');
	const database = createBunSqliteAdapter(sqlite);
	try {
		const authority = openAccountRowAuthority({ database }).workspace(
			'workspace',
		);
		expect(authority.hasReplica(REPLICA_ID)).toBe(false);
		const intents: CurrentStateWireRowIntent[] = [
			{ kind: 'create', table: 'notes', rowId: ROW_A, fields: { n: 1 } },
		];
		const accepted = push(authority, REPLICA_ID, 1, intents);
		if (accepted.result !== 'accepted') throw new Error('Expected acceptance');
		expect(push(authority, REPLICA_ID, 1, intents)).toEqual(accepted);

		const reopened = openAccountRowAuthority({ database }).workspace(
			'workspace',
		);
		expect(reopened.hasReplica(REPLICA_ID)).toBe(true);
		expect(push(reopened, REPLICA_ID, 1, intents)).toEqual(accepted);
		expect(
			database.all<{ count: number }>(
				'SELECT COUNT(*) AS count FROM row_authority_replicas',
			)[0]?.count,
		).toBe(1);
	} finally {
		sqlite.close();
	}
});

test('row moving beyond a fixed head remains reachable through its old marker', () => {
	const { authority, replicaId, close } = setup();
	try {
		push(authority, replicaId, 1, [
			{ kind: 'create', table: 'notes', rowId: ROW_A, fields: { n: 1 } },
			{ kind: 'create', table: 'notes', rowId: ROW_B, fields: { n: 2 } },
		]);
		const first = authority.pull({
			protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
			kind: 'pull',
			replicaId,
			after: 0,
			pageLimit: 1,
		});
		if (first.result !== 'page') throw new Error('Expected a pull page');
		expect(first).toMatchObject({ through: 2, checkpoint: 1 });

		push(authority, replicaId, 2, [
			{
				kind: 'update',
				table: 'notes',
				rowId: ROW_B,
				fields: { set: { n: 3 }, unset: [] },
			},
		]);
		const second = authority.pull({
			protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
			kind: 'pull',
			replicaId,
			after: first.checkpoint,
			through: first.through,
			pageLimit: 1,
		});
		expect(second).toMatchObject({
			result: 'page',
			through: 2,
			checkpoint: 2,
			entries: [
				{
					kind: 'row',
					rowId: ROW_B,
					changedSequence: 3,
					fields: { n: 3 },
				},
			],
		});
	} finally {
		close();
	}
});

test('a pre-deletion marker emits nothing until the deletion marker enters the pull window', () => {
	const { authority, replicaId, close } = setup();
	try {
		push(authority, replicaId, 1, [
			{ kind: 'create', table: 'notes', rowId: ROW_A, fields: { n: 1 } },
			{
				kind: 'update',
				table: 'notes',
				rowId: ROW_A,
				fields: { set: { n: 2 }, unset: [] },
			},
			{ kind: 'delete', table: 'notes', rowId: ROW_A },
		]);

		const beforeDeletion = authority.pull({
			protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
			kind: 'pull',
			replicaId,
			after: 0,
			through: 2,
		});
		expect(beforeDeletion).toMatchObject({
			result: 'page',
			checkpoint: 2,
			entries: [],
		});

		const deletion = authority.pull({
			protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
			kind: 'pull',
			replicaId,
			after: 2,
			through: 3,
		});
		expect(deletion).toMatchObject({
			result: 'page',
			checkpoint: 3,
			entries: [
				{
					kind: 'deleted',
					table: 'notes',
					rowId: ROW_A,
					deletedSequence: 3,
				},
			],
		});
	} finally {
		close();
	}
});

test('one page deduplicates repeated row markers', () => {
	const { authority, replicaId, close } = setup();
	try {
		push(authority, replicaId, 1, [
			{
				kind: 'create',
				table: 'notes',
				rowId: ROW_A,
				fields: { title: 'one' },
			},
			{
				kind: 'update',
				table: 'notes',
				rowId: ROW_A,
				fields: { set: { title: 'two' }, unset: [] },
			},
		]);
		const page = authority.pull({
			protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
			kind: 'pull',
			replicaId,
			after: 0,
		});
		if (page.result !== 'page') throw new Error('Expected a pull page');
		expect(page.checkpoint).toBe(2);
		expect(page.entries.filter(({ kind }) => kind === 'row')).toHaveLength(1);
		expect(page.entries).toHaveLength(1);
	} finally {
		close();
	}
});

test('exact retry preserves its receipt and never refolds', () => {
	const { authority, database, replicaId, close } = setup();
	try {
		const intents: CurrentStateWireRowIntent[] = [
			{ kind: 'create', table: 'notes', rowId: ROW_A, fields: { n: 1 } },
		];
		const accepted = push(authority, replicaId, 1, intents);
		expect(push(authority, replicaId, 1, intents)).toEqual(accepted);
		expect(
			database.all<{ count: number }>(
				'SELECT COUNT(*) AS count FROM row_authority_row_changes',
			)[0]?.count,
		).toBe(1);
		expect(
			database.all<{ server_sequence: number }>(
				`SELECT server_sequence FROM row_authority_meta
				 WHERE workspace_id = 'workspace'`,
			)[0]?.server_sequence,
		).toBe(1);
	} finally {
		close();
	}
});

test('same-round different-content, stale rounds, and gaps halt without mutation', () => {
	const { authority, database, replicaId, close } = setup();
	try {
		push(authority, replicaId, 1, [
			{ kind: 'create', table: 'notes', rowId: ROW_A, fields: { n: 1 } },
		]);
		const different: CurrentStateWireRowIntent[] = [
			{ kind: 'create', table: 'notes', rowId: ROW_B, fields: { n: 2 } },
		];
		expect(push(authority, replicaId, 1, different)).toEqual({
			result: 'recovery-required',
		});
		expect(push(authority, replicaId, 3, different)).toEqual({
			result: 'recovery-required',
		});

		push(authority, replicaId, 2, [
			{
				kind: 'update',
				table: 'notes',
				rowId: ROW_A,
				fields: { set: { n: 2 }, unset: [] },
			},
		]);
		expect(push(authority, replicaId, 1, different)).toEqual({
			result: 'recovery-required',
		});
		expect(
			database.all<{ server_sequence: number }>(
				`SELECT server_sequence FROM row_authority_meta
				 WHERE workspace_id = 'workspace'`,
			)[0]?.server_sequence,
		).toBe(2);
		expect(
			database.all<{ count: number }>(
				'SELECT COUNT(*) AS count FROM row_authority_rows',
			)[0]?.count,
		).toBe(1);
	} finally {
		close();
	}
});

test('push commits row effects, markers, head, and receipt atomically', () => {
	const { authority, database, replicaId, close } = setup();
	try {
		database.run(`
			CREATE TRIGGER fail_row_marker
			BEFORE INSERT ON row_authority_row_changes
			BEGIN SELECT RAISE(ABORT, 'marker failed'); END
		`);
		expect(() =>
			push(authority, replicaId, 1, [
				{
					kind: 'create',
					table: 'notes',
					rowId: ROW_A,
					fields: { n: 1 },
				},
			]),
		).toThrow('marker failed');
		for (const table of ['row_authority_rows', 'row_authority_row_changes']) {
			expect(
				database.all<{ count: number }>(
					`SELECT COUNT(*) AS count FROM ${table}`,
				)[0]?.count,
			).toBe(0);
		}
		expect(authority.hasReplica(replicaId)).toBe(false);
	} finally {
		close();
	}
});

test('compaction removes deletion memory and permits non-conforming row-id reuse', () => {
	const { authority, database, replicaId, close } = setup();
	try {
		push(authority, replicaId, 1, [
			{
				kind: 'create',
				table: 'notes',
				rowId: ROW_A,
				fields: { title: 'kept' },
			},
			{ kind: 'create', table: 'notes', rowId: ROW_B, fields: { n: 2 } },
			{ kind: 'delete', table: 'notes', rowId: ROW_B },
		]);
		expect(authority.compactThrough(4)).toBe(3);
		expect(
			database.all<{ count: number }>(
				'SELECT COUNT(*) AS count FROM row_authority_row_changes',
			)[0]?.count,
		).toBe(0);
		expect(
			database.all<{ count: number }>(
				`SELECT COUNT(*) AS count FROM row_authority_row_changes
				 WHERE deleted = 1`,
			)[0]?.count,
		).toBe(0);
		expect(
			authority.pull({
				protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
				kind: 'pull',
				replicaId,
				after: 0,
			}),
		).toMatchObject({ result: 'acquisition-required', retentionFloor: 3 });

		push(authority, replicaId, 2, [
			{ kind: 'create', table: 'notes', rowId: ROW_B, fields: { n: 3 } },
		]);
		const afterRecreate = authority.acquire({
			protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
			kind: 'acquire',
			replicaId,
			pageLimit: 10,
		});
		if (afterRecreate.result !== 'page') {
			throw new Error('Expected acquire page');
		}
		expect(afterRecreate.rows.map(({ rowId }) => rowId)).toEqual([
			ROW_A,
			ROW_B,
		]);
		const acquired = authority.acquire({
			protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
			kind: 'acquire',
			replicaId,
		});
		expect(acquired).toMatchObject({
			result: 'page',
			head: 4,
			retentionFloor: 3,
			hasMore: false,
			rows: [
				{
					table: 'notes',
					rowId: ROW_A,
					fields: { title: 'kept' },
					changedSequence: 1,
				},
				{
					table: 'notes',
					rowId: ROW_B,
					fields: { n: 3 },
					changedSequence: 4,
				},
			],
		});
	} finally {
		close();
	}
});

test('acquisition pages complete current rows in stable address order', () => {
	const { authority, replicaId, close } = setup();
	try {
		push(authority, replicaId, 1, [
			{ kind: 'create', table: 'b', rowId: ROW_C, fields: { order: 3 } },
			{ kind: 'create', table: 'a', rowId: ROW_B, fields: { order: 2 } },
			{ kind: 'create', table: 'a', rowId: ROW_A, fields: { order: 1 } },
		]);
		const first = authority.acquire({
			protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
			kind: 'acquire',
			replicaId,
			pageLimit: 2,
		});
		if (first.result !== 'page') throw new Error('Expected acquire page');
		expect(first.rows.map(({ table, rowId }) => [table, rowId])).toEqual([
			['a', ROW_A],
			['a', ROW_B],
		]);
		expect(first.hasMore).toBe(true);

		const second = authority.acquire({
			protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
			kind: 'acquire',
			replicaId,
			afterAddress: { table: 'a', rowId: ROW_B },
			pageLimit: 2,
		});
		expect(second).toMatchObject({
			result: 'page',
			hasMore: false,
			rows: [{ table: 'b', rowId: ROW_C, fields: { order: 3 } }],
		});
	} finally {
		close();
	}
});

test('stateless acquisition catches every mutation behind its address cursor', () => {
	const { authority, replicaId, close } = setup();
	try {
		push(authority, replicaId, 1, [
			{ kind: 'create', table: 'notes', rowId: ROW_A, fields: { value: 'a' } },
			{ kind: 'create', table: 'notes', rowId: ROW_B, fields: { value: 'b' } },
			{ kind: 'create', table: 'notes', rowId: ROW_C, fields: { value: 'c' } },
		]);
		const first = authority.acquire({
			protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
			kind: 'acquire',
			replicaId,
			pageLimit: 2,
		});
		if (first.result !== 'page') throw new Error('Expected acquire page');
		expect(first.rows.map(({ rowId }) => rowId)).toEqual([ROW_A, ROW_B]);
		const anchor = first.head;
		expect(anchor).toBe(3);

		push(authority, replicaId, 2, [
			{ kind: 'delete', table: 'notes', rowId: ROW_A },
			{
				kind: 'create',
				table: 'notes',
				rowId: ROW_BEHIND,
				fields: { value: 'behind' },
			},
			{
				kind: 'update',
				table: 'notes',
				rowId: ROW_B,
				fields: { set: { value: 'updated' }, unset: [] },
			},
		]);

		const finalPage = authority.acquire({
			protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
			kind: 'acquire',
			replicaId,
			afterAddress: { table: 'notes', rowId: ROW_B },
			pageLimit: 2,
		});
		if (finalPage.result !== 'page') throw new Error('Expected acquire page');
		expect(finalPage.rows.map(({ rowId }) => rowId)).toEqual([ROW_C]);
		expect(finalPage.hasMore).toBe(false);
		const target = finalPage.head;
		expect(target).toBe(6);

		const corrections = authority.pull({
			protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
			kind: 'pull',
			replicaId,
			after: anchor,
			through: target,
		});
		if (corrections.result !== 'page') {
			throw new Error('Expected correction pull page');
		}
		expect(corrections.checkpoint).toBe(target);
		expect(corrections.entries).toEqual([
			{
				kind: 'deleted',
				table: 'notes',
				rowId: ROW_A,
				deletedSequence: 4,
			},
			{
				kind: 'row',
				table: 'notes',
				rowId: ROW_BEHIND,
				changedSequence: 5,
				fields: { value: 'behind' },
			},
			{
				kind: 'row',
				table: 'notes',
				rowId: ROW_B,
				changedSequence: 6,
				fields: { value: 'updated' },
			},
		]);

		const scratch = new Map(
			[...first.rows, ...finalPage.rows].map((row) => [
				`${row.table}\u0000${row.rowId}`,
				row,
			]),
		);
		for (const entry of corrections.entries) {
			const key = `${entry.table}\u0000${entry.rowId}`;
			if (entry.kind === 'deleted') scratch.delete(key);
			else if (entry.kind === 'row') {
				scratch.set(key, {
					table: entry.table,
					rowId: entry.rowId,
					fields: entry.fields,
					changedSequence: entry.changedSequence,
				});
			}
		}
		const complete = authority.acquire({
			protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
			kind: 'acquire',
			replicaId,
		});
		if (complete.result !== 'page') throw new Error('Expected acquire page');
		const sortRows = <TRow extends { table: string; rowId: string }>(
			rows: TRow[],
		) =>
			rows.toSorted((left, right) =>
				`${left.table}\u0000${left.rowId}`.localeCompare(
					`${right.table}\u0000${right.rowId}`,
				),
			);
		expect(sortRows([...scratch.values()])).toEqual(sortRows(complete.rows));

		authority.compactThrough(anchor + 1);
		expect(
			authority.pull({
				protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
				kind: 'pull',
				replicaId,
				after: anchor,
				through: target,
			}),
		).toMatchObject({
			result: 'acquisition-required',
			retentionFloor: anchor + 1,
		});
	} finally {
		close();
	}
});

test('opening current-state storage deletes old authority state', () => {
	const sqlite = new Database(':memory:');
	const database = createBunSqliteAdapter(sqlite);
	try {
		database.run('CREATE TABLE row_sync_replicas(replica_id TEXT PRIMARY KEY)');
		database.run(
			"INSERT INTO row_sync_replicas(replica_id) VALUES ('old-replica')",
		);
		database.run(
			'CREATE TABLE row_sync_rows(table_name TEXT, row_id TEXT, fields_json TEXT)',
		);
		database.run(
			`INSERT INTO row_sync_rows(table_name, row_id, fields_json)
			 VALUES ('notes', '${ROW_A}', '{"old":true}')`,
		);
		openAccountRowAuthority({ database });
		expect(
			database.all<{ count: number }>(
				`SELECT COUNT(*) AS count FROM sqlite_master
				 WHERE type = 'table' AND name LIKE 'row_sync_%'`,
			)[0]?.count,
		).toBe(0);
		expect(
			database.all<{ count: number }>(
				'SELECT COUNT(*) AS count FROM row_authority_replicas',
			)[0]?.count,
		).toBe(0);
		expect(
			database.all<{ count: number }>(
				'SELECT COUNT(*) AS count FROM row_authority_rows',
			)[0]?.count,
		).toBe(0);
	} finally {
		sqlite.close();
	}
});

test('incompatible current-state storage resets without migration', () => {
	const sqlite = new Database(':memory:');
	const database = createBunSqliteAdapter(sqlite);
	try {
		database.run(`
			CREATE TABLE row_authority_meta (
				id INTEGER PRIMARY KEY,
				storage_version INTEGER NOT NULL,
				protocol_major INTEGER NOT NULL,
				server_sequence INTEGER NOT NULL,
				retention_floor INTEGER NOT NULL
			)
		`);
		database.run(
			`INSERT INTO row_authority_meta
			 VALUES (1, 999, 999, 42, 40)`,
		);
		database.run('CREATE TABLE row_authority_rows(old_payload TEXT NOT NULL)');
		database.run("INSERT INTO row_authority_rows(old_payload) VALUES ('old')");

		openAccountRowAuthority({ database });
		expect(
			database.all<{ count: number }>(
				'SELECT COUNT(*) AS count FROM row_authority_meta',
			)[0]?.count,
		).toBe(0);
		expect(
			database.all<{ count: number }>(
				'SELECT COUNT(*) AS count FROM row_authority_rows',
			)[0]?.count,
		).toBe(0);
	} finally {
		sqlite.close();
	}
});

test('unreadable current-state meta schema resets without a migration reader', () => {
	const sqlite = new Database(':memory:');
	const database = createBunSqliteAdapter(sqlite);
	try {
		database.run(
			'CREATE TABLE row_authority_meta(id INTEGER PRIMARY KEY, old_version INTEGER)',
		);
		database.run('INSERT INTO row_authority_meta VALUES (1, 7)');
		database.run('CREATE TABLE row_authority_replicas(old_receipt TEXT)');
		database.run("INSERT INTO row_authority_replicas VALUES ('old-receipt')");

		openAccountRowAuthority({ database });
		expect(
			database.all<{ count: number }>(
				'SELECT COUNT(*) AS count FROM row_authority_replicas',
			)[0]?.count,
		).toBe(0);
		expect(
			database.all<{ count: number }>(
				'SELECT COUNT(*) AS count FROM row_authority_meta',
			)[0]?.count,
		).toBe(0);
	} finally {
		sqlite.close();
	}
});

test('current meta with a missing marker table resets the whole authority', () => {
	const { authority, database, replicaId, close } = setup();
	try {
		push(authority, replicaId, 1, [
			{ kind: 'create', table: 'notes', rowId: ROW_A, fields: { old: true } },
		]);
		database.run('DROP TABLE row_authority_row_changes');

		openAccountRowAuthority({ database });
		expect(
			database.all<{ count: number }>(
				'SELECT COUNT(*) AS count FROM row_authority_meta',
			)[0]?.count,
		).toBe(0);
		expect(
			database.all<{ count: number }>(
				'SELECT COUNT(*) AS count FROM row_authority_replicas',
			)[0]?.count,
		).toBe(0);
		expect(
			database.all<{ count: number }>(
				'SELECT COUNT(*) AS count FROM row_authority_rows',
			)[0]?.count,
		).toBe(0);
		expect(
			database.all<{ count: number }>(
				'SELECT COUNT(*) AS count FROM row_authority_row_changes',
			)[0]?.count,
		).toBe(0);
	} finally {
		close();
	}
});

test('current meta with malformed row storage resets the whole authority', () => {
	const { authority, database, replicaId, close } = setup();
	try {
		push(authority, replicaId, 1, [
			{ kind: 'create', table: 'notes', rowId: ROW_A, fields: { old: true } },
		]);
		database.run('DROP TABLE row_authority_rows');
		database.run(
			'CREATE TABLE row_authority_rows(table_name TEXT, old_payload TEXT)',
		);
		database.run(
			"INSERT INTO row_authority_rows VALUES ('notes', 'old-payload')",
		);

		openAccountRowAuthority({ database });
		expect(
			database.all<{ count: number }>(
				'SELECT COUNT(*) AS count FROM row_authority_meta',
			)[0]?.count,
		).toBe(0);
		expect(
			database.all<{ count: number }>(
				'SELECT COUNT(*) AS count FROM row_authority_replicas',
			)[0]?.count,
		).toBe(0);
		expect(
			database.all<{ name: string }>('PRAGMA table_info(row_authority_rows)'),
		).toEqual([
			expect.objectContaining({ name: 'workspace_id' }),
			expect.objectContaining({ name: 'table_name' }),
			expect.objectContaining({ name: 'row_id' }),
			expect.objectContaining({ name: 'fields_json' }),
			expect.objectContaining({ name: 'changed_sequence' }),
		]);
	} finally {
		close();
	}
});

test('current meta with a missing required index resets the whole authority', () => {
	const { authority, database, replicaId, close } = setup();
	try {
		push(authority, replicaId, 1, [
			{ kind: 'create', table: 'notes', rowId: ROW_A, fields: { old: true } },
		]);
		database.run('DROP INDEX row_authority_deletion_markers_address');

		openAccountRowAuthority({ database });
		expect(
			database.all<{ count: number }>(
				'SELECT COUNT(*) AS count FROM row_authority_replicas',
			)[0]?.count,
		).toBe(0);
		expect(
			database.all<{ count: number }>(
				`SELECT COUNT(*) AS count FROM sqlite_master
				 WHERE type = 'index'
				   AND name = 'row_authority_deletion_markers_address'`,
			)[0]?.count,
		).toBe(1);
	} finally {
		close();
	}
});

test('reads do not register replicas and stale first push does not mutate', () => {
	const { authority, database, close } = setup();
	const unknownReplicaId = 'uuuuuuuuuuuuuuuuuuuuuuuu';
	try {
		expect(
			authority.pull({
				protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
				kind: 'pull',
				replicaId: unknownReplicaId,
				after: 0,
			}),
		).toMatchObject({
			result: 'page',
			receipt: { acceptedRound: 0, requestDigest: null, appliedThrough: 0 },
		});
		expect(
			push(authority, unknownReplicaId, 2, [
				{ kind: 'create', table: 'notes', rowId: ROW_A, fields: {} },
			]),
		).toEqual({ result: 'recovery-required' });
		expect(authority.hasReplica(unknownReplicaId)).toBe(false);
		expect(
			authority.acquire({
				protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR - 1,
				kind: 'acquire',
				replicaId: unknownReplicaId,
			}),
		).toEqual({ result: 'protocol-mismatch' });
		expect(
			database.all<{ count: number }>(
				'SELECT COUNT(*) AS count FROM row_authority_meta',
			)[0]?.count,
		).toBe(0);
	} finally {
		close();
	}
});

test('one account isolates workspace rows, receipts, heads, and documents and deletes independently', () => {
	const sqlite = new Database(':memory:');
	const database = createBunSqliteAdapter(sqlite);
	const account = openAccountRowAuthority({ database });
	const alpha = account.workspace('alpha');
	const beta = account.workspace('beta');
	const address = { table: 'notes', rowId: ROW_A };
	const alphaDocument = new Y.Doc();
	const betaDocument = new Y.Doc();
	try {
		expect(
			push(alpha, REPLICA_ID, 1, [
				{ kind: 'create', ...address, fields: { workspace: 'alpha' } },
			]),
		).toMatchObject({
			result: 'accepted',
			receipt: { acceptedRound: 1, appliedThrough: 1 },
		});
		push(beta, REPLICA_ID, 1, [
			{ kind: 'create', ...address, fields: { workspace: 'beta' } },
		]);
		expect(
			push(beta, REPLICA_ID, 2, [
				{
					kind: 'update',
					...address,
					fields: { set: { version: 2 }, unset: [] },
				},
			]),
		).toMatchObject({
			result: 'accepted',
			receipt: { acceptedRound: 2, appliedThrough: 2 },
		});

		alphaDocument.get('editor').insert(0, 'alpha');
		betaDocument.get('editor').insert(0, 'beta');
		const alphaUpdate = Y.encodeStateAsUpdateV2(alphaDocument);
		const betaUpdate = Y.encodeStateAsUpdateV2(betaDocument);
		expect(alpha.documents.appendIfLive(address, alphaUpdate)).toBe('appended');
		expect(beta.documents.appendIfLive(address, betaUpdate)).toBe('appended');

		expect(
			alpha.acquire({
				protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
				kind: 'acquire',
				replicaId: REPLICA_ID,
			}),
		).toMatchObject({
			result: 'page',
			head: 1,
			receipt: { acceptedRound: 1 },
			rows: [{ fields: { workspace: 'alpha' } }],
		});
		expect(
			beta.acquire({
				protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
				kind: 'acquire',
				replicaId: REPLICA_ID,
			}),
		).toMatchObject({
			result: 'page',
			head: 2,
			receipt: { acceptedRound: 2 },
			rows: [{ fields: { workspace: 'beta', version: 2 } }],
		});
		expect(alpha.documents.openIfLive(address)).toEqual([alphaUpdate]);
		expect(beta.documents.openIfLive(address)).toEqual([betaUpdate]);

		account.deleteWorkspace('alpha');
		expect(alpha.hasReplica(REPLICA_ID)).toBe(false);
		expect(alpha.documents.openIfLive(address)).toBeUndefined();
		expect(
			alpha.acquire({
				protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
				kind: 'acquire',
				replicaId: REPLICA_ID,
			}),
		).toMatchObject({ result: 'page', head: 0, rows: [] });
		expect(beta.hasReplica(REPLICA_ID)).toBe(true);
		expect(beta.documents.openIfLive(address)).toEqual([betaUpdate]);
		expect(
			database.all<{ workspace_id: string }>(
				`SELECT workspace_id FROM row_authority_meta
				 ORDER BY workspace_id`,
			),
		).toEqual([{ workspace_id: 'beta' }]);
	} finally {
		alphaDocument.destroy();
		betaDocument.destroy();
		sqlite.close();
	}
});

test('physical wall refuses whole rounds and document appends but leaves reads and deletion available', () => {
	const sqlite = new Database(':memory:');
	const database = createBunSqliteAdapter(sqlite);
	let databaseSize = 0;
	const account = openAccountRowAuthority({
		database,
		readDatabaseSize: () => databaseSize,
	});
	const authority = account.workspace('workspace');
	const address = { table: 'notes', rowId: ROW_A };
	const document = new Y.Doc();
	try {
		push(authority, REPLICA_ID, 1, [
			{ kind: 'create', ...address, fields: { title: 'live' } },
		]);
		document.get('editor').insert(0, 'committed');
		const update = Y.encodeStateAsUpdateV2(document);
		expect(authority.documents.appendIfLive(address, update)).toBe('appended');

		const intents: CurrentStateWireRowIntent[] = [
			{
				kind: 'update',
				...address,
				fields: { set: { title: 'retry' }, unset: [] },
			},
		];
		databaseSize = ACCOUNT_AUTHORITY_WALL;
		expect(push(authority, REPLICA_ID, 2, intents)).toEqual({
			result: 'storage-limit',
		});
		expect(authority.documents.appendIfLive(address, update)).toBe('refused');
		expect(authority.documents.openIfLive(address)).toEqual([update]);
		expect(
			authority.pull({
				protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
				kind: 'pull',
				replicaId: REPLICA_ID,
				after: 0,
			}),
		).toMatchObject({ result: 'page', through: 1 });
		expect(
			authority.acquire({
				protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
				kind: 'acquire',
				replicaId: REPLICA_ID,
			}),
		).toMatchObject({ result: 'page', head: 1 });

		databaseSize = 0;
		expect(push(authority, REPLICA_ID, 2, intents)).toMatchObject({
			result: 'accepted',
			receipt: { acceptedRound: 2, appliedThrough: 2 },
		});
		databaseSize = ACCOUNT_AUTHORITY_WALL;
		account.deleteWorkspace('workspace');
		expect(authority.hasReplica(REPLICA_ID)).toBe(false);
		expect(authority.documents.openIfLive(address)).toBeUndefined();
	} finally {
		document.destroy();
		sqlite.close();
	}
});
