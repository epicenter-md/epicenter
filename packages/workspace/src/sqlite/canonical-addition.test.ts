/**
 * Canonical Workspace Addition Tests
 *
 * Verifies schema-blind replay from a Device canonical store into Account
 * native intents without modifying the source or inspecting target conflicts.
 *
 * Key behaviors:
 * - preserved-ID creates keep existing scalar fields
 * - one KV update preserves account-only keys and overlays device keys
 * - interruption retries from source existence without duplicate intent state
 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { RESERVED_KV_ROW_ID, RESERVED_KV_TABLE } from '@epicenter/row-sync';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import {
	captureLocalWorkspace,
	logicalWorkspaceIntents,
} from './canonical-addition.js';
import { createCurrentStateReplica } from './current-state-replica.js';
import { initializeLocalWorkspaceStorage } from './local-workspace-storage.js';

const ROW_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const ROW_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const ROW_C = 'cccccccccccccccccccccccc';

function setup() {
	const sourceDatabase = new Database(':memory:');
	const targetDatabase = new Database(':memory:');
	const source = createBunSqliteAdapter(sourceDatabase);
	const targetSqlite = createBunSqliteAdapter(targetDatabase);
	initializeLocalWorkspaceStorage(source);
	const target = createCurrentStateReplica({
		sqlite: targetSqlite,
		transport: {
			push: unavailable,
			pull: unavailable,
			acquire: unavailable,
		},
	});
	return {
		source,
		target,
		targetDatabase,
		addSourceRow({ rowId, fields }: { rowId: string; fields: object }) {
			source.run(
				'INSERT INTO rows(table_key, row_id, fields_json) VALUES (?, ?, ?)',
				['notes', rowId, JSON.stringify(fields)],
			);
		},
		setSourceKv(value: object) {
			source.run(
				'INSERT INTO rows(table_key, row_id, fields_json) VALUES (?, ?, ?)',
				[RESERVED_KV_TABLE, RESERVED_KV_ROW_ID, JSON.stringify(value)],
			);
		},
		add() {
			target.admitMany(
				logicalWorkspaceIntents(
					captureLocalWorkspace(source, () => new Uint8Array()),
				),
			);
		},
		dispose() {
			sourceDatabase.close();
			targetDatabase.close();
		},
	};
}

async function unavailable(): Promise<never> {
	throw new Error('Transport is unavailable in logical addition tests');
}

test('addition preserves account rows and adds device scalar rows and KV', () => {
	const { source, target, addSourceRow, setSourceKv, add, dispose } = setup();
	try {
		addSourceRow({
			rowId: ROW_A,
			fields: { title: 'device collision' },
		});
		addSourceRow({
			rowId: ROW_B,
			fields: { title: 'device only' },
		});
		setSourceKv({ deviceOnly: 1, shared: 'device' });

		target.admit({
			kind: 'create',
			table: 'notes',
			rowId: ROW_A,
			fields: { title: 'account collision' },
		});
		target.admit({
			kind: 'create',
			table: 'notes',
			rowId: ROW_C,
			fields: { title: 'account only' },
		});
		target.admit({
			kind: 'update',
			table: RESERVED_KV_TABLE,
			rowId: RESERVED_KV_ROW_ID,
			fields: {
				set: { accountOnly: 2, shared: 'account' },
				unset: [],
			},
		});

		add();

		expect(target.readCurrentRow('notes', ROW_A)).toEqual({
			title: 'account collision',
		});
		expect(target.readCurrentRow('notes', ROW_B)).toEqual({
			title: 'device only',
		});
		expect(target.readCurrentRow('notes', ROW_C)).toEqual({
			title: 'account only',
		});
		expect(
			target.readCurrentRow(RESERVED_KV_TABLE, RESERVED_KV_ROW_ID),
		).toEqual({ accountOnly: 2, deviceOnly: 1, shared: 'device' });
		expect(source.all('SELECT * FROM rows')).not.toEqual([]);
	} finally {
		dispose();
	}
});

test('repeated addition compacts to one intent per address', () => {
	const { target, targetDatabase, addSourceRow, setSourceKv, add, dispose } =
		setup();
	try {
		addSourceRow({ rowId: ROW_A, fields: { title: 'first' } });
		addSourceRow({ rowId: ROW_B, fields: { title: 'second' } });
		setSourceKv({ theme: 'dark' });
		add();
		add();

		expect(target.readCurrentRow('notes', ROW_A)).toEqual({ title: 'first' });
		expect(target.readCurrentRow('notes', ROW_B)).toEqual({ title: 'second' });
		expect(
			target.readCurrentRow(RESERVED_KV_TABLE, RESERVED_KV_ROW_ID),
		).toEqual({ theme: 'dark' });
		expect(
			targetDatabase
				.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM intents')
				.get()?.count,
		).toBe(3);
	} finally {
		dispose();
	}
});

test('empty source admits no intents', () => {
	const { targetDatabase, add, dispose } = setup();
	try {
		add();
		expect(targetDatabase.query('SELECT * FROM intents').all()).toEqual([]);
	} finally {
		dispose();
	}
});
