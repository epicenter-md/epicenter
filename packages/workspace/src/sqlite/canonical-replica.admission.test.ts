/**
 * Canonical Replica Admission Tests
 *
 * Verifies that local create admission mirrors first-create-wins while still
 * preserving the current local row lifetime and sealed-round ordering.
 *
 * Key behaviors:
 * - create on a live projection is an idempotent no-op
 * - create replaces a pending update whose projection remains absent
 * - an open or sealed delete refuses local row resurrection
 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createBunSqliteAdapter } from '@epicenter/row-sync/bun';
import { mergeDocumentUpdates } from './canonical-documents.js';
import { createCanonicalReplica } from './canonical-replica.js';
import {
	createTestTransport,
	openTestAuthority,
} from './row-sync-test-utils.js';

const ROW_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';

function setup() {
	const database = new Database(':memory:');
	const authorityState = openTestAuthority();
	const sqlite = createBunSqliteAdapter(database);
	const replica = createCanonicalReplica({
		sqlite,
		transport: createTestTransport(authorityState.authority),
		codec: { mergeUpdates: mergeDocumentUpdates },
	});
	return {
		database,
		replica,
		seed(fields: object) {
			sqlite.run(
				'INSERT INTO rows(table_key, row_id, fields_json) VALUES (?, ?, ?)',
				['notes', ROW_ID, JSON.stringify(fields)],
			);
		},
		seal() {
			sqlite.run('UPDATE intents SET sealed = 1 WHERE sealed = 0');
		},
		dispose() {
			database.close();
			authorityState.database.close();
		},
	};
}

test('create on a confirmed row is a no-op', () => {
	const { database, replica, seed, dispose } = setup();
	try {
		seed({ title: 'account' });
		replica.admit({
			kind: 'create',
			table: 'notes',
			rowId: ROW_ID,
			fields: { title: 'device' },
		});
		expect(replica.readCurrentRow('notes', ROW_ID)).toEqual({
			title: 'account',
		});
		expect(database.query('SELECT * FROM intents').all()).toEqual([]);
	} finally {
		dispose();
	}
});

test('create on an open create is a no-op', () => {
	const { database, replica, dispose } = setup();
	try {
		replica.admit({
			kind: 'create',
			table: 'notes',
			rowId: ROW_ID,
			fields: { title: 'account' },
		});
		replica.admit({
			kind: 'create',
			table: 'notes',
			rowId: ROW_ID,
			fields: { title: 'device' },
		});
		expect(replica.readCurrentRow('notes', ROW_ID)).toEqual({
			title: 'account',
		});
		expect(
			database
				.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM intents')
				.get()?.count,
		).toBe(1);
	} finally {
		dispose();
	}
});

test('create on a sealed create is a no-op', () => {
	const { database, replica, seal, dispose } = setup();
	try {
		replica.admit({
			kind: 'create',
			table: 'notes',
			rowId: ROW_ID,
			fields: { title: 'account' },
		});
		seal();
		replica.admit({
			kind: 'create',
			table: 'notes',
			rowId: ROW_ID,
			fields: { title: 'device' },
		});
		expect(replica.readCurrentRow('notes', ROW_ID)).toEqual({
			title: 'account',
		});
		expect(
			database
				.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM intents')
				.get()?.count,
		).toBe(1);
	} finally {
		dispose();
	}
});

test('create replaces an open update whose projection is absent', () => {
	const { database, replica, dispose } = setup();
	try {
		replica.admit({
			kind: 'update',
			table: 'notes',
			rowId: ROW_ID,
			fields: { set: { stale: true }, unset: [] },
		});
		replica.admit({
			kind: 'create',
			table: 'notes',
			rowId: ROW_ID,
			fields: { title: 'device' },
		});
		expect(replica.readCurrentRow('notes', ROW_ID)).toEqual({
			title: 'device',
		});
		expect(
			database.query<{ kind: string }, []>('SELECT kind FROM intents').get()
				?.kind,
		).toBe('create');
	} finally {
		dispose();
	}
});

test('create follows a sealed update whose projection is absent', () => {
	const { database, replica, seal, dispose } = setup();
	try {
		replica.admit({
			kind: 'update',
			table: 'notes',
			rowId: ROW_ID,
			fields: { set: { stale: true }, unset: [] },
		});
		seal();
		replica.admit({
			kind: 'create',
			table: 'notes',
			rowId: ROW_ID,
			fields: { title: 'device' },
		});
		expect(replica.readCurrentRow('notes', ROW_ID)).toEqual({
			title: 'device',
		});
		expect(
			database
				.query<{ sealed: number; kind: string }, []>(
					'SELECT sealed, kind FROM intents ORDER BY sealed DESC',
				)
				.all(),
		).toEqual([
			{ sealed: 1, kind: 'update' },
			{ sealed: 0, kind: 'create' },
		]);
	} finally {
		dispose();
	}
});

test('create after an open delete is refused', () => {
	const { replica, seed, dispose } = setup();
	try {
		seed({ title: 'account' });
		replica.admit({ kind: 'delete', table: 'notes', rowId: ROW_ID });
		expect(() =>
			replica.admit({
				kind: 'create',
				table: 'notes',
				rowId: ROW_ID,
				fields: { title: 'device' },
			}),
		).toThrow('A locally deleted row accepts no further intent');
	} finally {
		dispose();
	}
});

test('create after a sealed delete is refused', () => {
	const { replica, seed, seal, dispose } = setup();
	try {
		seed({ title: 'account' });
		replica.admit({ kind: 'delete', table: 'notes', rowId: ROW_ID });
		seal();
		expect(() =>
			replica.admit({
				kind: 'create',
				table: 'notes',
				rowId: ROW_ID,
				fields: { title: 'device' },
			}),
		).toThrow('A locally deleted row accepts no further intent');
	} finally {
		dispose();
	}
});
