/**
 * Canonical Workspace Addition Tests
 *
 * Verifies schema-blind replay from a Device canonical store into Account
 * native intents without modifying the source or inspecting target conflicts.
 *
 * Key behaviors:
 * - preserved-ID creates add rows and documents while existing account rows win
 * - one KV update preserves account-only keys and overlays device keys
 * - interruption retries from source existence without duplicate intent state
 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { RESERVED_KV_ROW_ID, RESERVED_KV_TABLE } from '@epicenter/row-sync';
import { createBunSqliteAdapter } from '@epicenter/row-sync/bun';
import { mergeDocumentUpdates } from './canonical-documents.js';
import {
	addCanonicalWorkspace,
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

function setup() {
	const sourceDatabase = new Database(':memory:');
	const targetDatabase = new Database(':memory:');
	const source = createBunSqliteAdapter(sourceDatabase);
	const targetSqlite = createBunSqliteAdapter(targetDatabase);
	const authorityState = openTestAuthority();
	initializeCanonicalSchema(source);
	const target = createCanonicalReplica({
		sqlite: targetSqlite,
		transport: createTestTransport(authorityState.authority),
		codec: { mergeUpdates: mergeDocumentUpdates },
	});
	return {
		authority: authorityState.authority,
		source,
		target,
		targetDatabase,
		addSourceRow({
			rowId,
			fields,
			text,
		}: {
			rowId: string;
			fields: object;
			text?: string;
		}) {
			source.run(
				'INSERT INTO rows(table_key, row_id, fields_json) VALUES (?, ?, ?)',
				['notes', rowId, JSON.stringify(fields)],
			);
			if (text === undefined) return;
			source.run(
				'INSERT INTO documents(table_key, row_id, yjs_state) VALUES (?, ?, ?)',
				[
					'notes',
					rowId,
					captureUpdate((doc) => doc.get('editor').insert(0, text)),
				],
			);
		},
		setSourceKv(value: object) {
			source.run(
				'INSERT INTO rows(table_key, row_id, fields_json) VALUES (?, ?, ?)',
				[RESERVED_KV_TABLE, RESERVED_KV_ROW_ID, JSON.stringify(value)],
			);
		},
		add() {
			addCanonicalWorkspace({
				source,
				admitIntent: target.admit,
				mergeUpdates: mergeDocumentUpdates,
			});
		},
		dispose() {
			sourceDatabase.close();
			targetDatabase.close();
			authorityState.database.close();
		},
	};
}

test('addition preserves account rows and adds device rows, documents, and KV', () => {
	const { source, target, addSourceRow, setSourceKv, add, dispose } = setup();
	try {
		addSourceRow({
			rowId: ROW_A,
			fields: { title: 'device collision' },
			text: 'device collision',
		});
		addSourceRow({
			rowId: ROW_B,
			fields: { title: 'device only' },
			text: 'device text',
		});
		setSourceKv({ deviceOnly: 1, shared: 'device' });

		target.admit({
			kind: 'create',
			table: 'notes',
			rowId: ROW_A,
			fields: { title: 'account collision' },
			documentUpdate: Buffer.from(
				captureUpdate((doc) => doc.get('editor').insert(0, 'account text')),
			).toString('base64'),
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
		expect(readText(target.readCurrentDocumentParts('notes', ROW_A))).toBe(
			'account text',
		);
		expect(target.readCurrentRow('notes', ROW_B)).toEqual({
			title: 'device only',
		});
		expect(readText(target.readCurrentDocumentParts('notes', ROW_B))).toBe(
			'device text',
		);
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

test('interrupted addition retries to one intent per address', () => {
	const {
		source,
		target,
		targetDatabase,
		addSourceRow,
		setSourceKv,
		add,
		dispose,
	} = setup();
	try {
		addSourceRow({ rowId: ROW_A, fields: { title: 'first' } });
		addSourceRow({ rowId: ROW_B, fields: { title: 'second' } });
		setSourceKv({ theme: 'dark' });
		let admitted = 0;
		expect(() =>
			addCanonicalWorkspace({
				source,
				admitIntent(intent) {
					admitted += 1;
					if (admitted === 2) throw new Error('interrupted');
					target.admit(intent);
				},
				mergeUpdates: mergeDocumentUpdates,
			}),
		).toThrow('interrupted');

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

test('over-capacity KV no-ops while ordinary rows still synchronize', async () => {
	const { authority, target, addSourceRow, setSourceKv, add, dispose } =
		setup();
	const writerDatabase = new Database(':memory:');
	try {
		const writer = createCanonicalReplica({
			sqlite: createBunSqliteAdapter(writerDatabase),
			transport: createTestTransport(authority),
			codec: { mergeUpdates: mergeDocumentUpdates },
		});
		writer.admit({
			kind: 'update',
			table: RESERVED_KV_TABLE,
			rowId: RESERVED_KV_ROW_ID,
			fields: {
				set: { accountOnly: 'a'.repeat(40 * 1024) },
				unset: [],
			},
		});
		await writer.synchronize();

		addSourceRow({ rowId: ROW_A, fields: { title: 'device row' } });
		setSourceKv({ deviceOnly: 'd'.repeat(40 * 1024) });
		add();
		await target.synchronize();

		expect(target.readCurrentRow('notes', ROW_A)).toEqual({
			title: 'device row',
		});
		expect(
			target.readCurrentRow(RESERVED_KV_TABLE, RESERVED_KV_ROW_ID),
		).toEqual({ accountOnly: 'a'.repeat(40 * 1024) });
	} finally {
		writerDatabase.close();
		dispose();
	}
});
