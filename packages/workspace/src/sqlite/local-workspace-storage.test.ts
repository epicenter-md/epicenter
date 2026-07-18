import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { RESERVED_KV_ROW_ID, RESERVED_KV_TABLE } from '@epicenter/row-sync';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import * as Y from '@y/y';
import {
	initializeLocalWorkspaceStorage,
	readLocalDocumentParts,
	readLocalRow,
} from './local-workspace-storage.js';

test('legacy local storage keeps rows, KV, and Yjs while dropping inert sync tables', () => {
	const database = new Database(':memory:');
	try {
		database.exec(`
			CREATE TABLE rows (
				table_key TEXT NOT NULL, row_id TEXT NOT NULL,
				fields_json TEXT NOT NULL CHECK(json_valid(fields_json)),
				PRIMARY KEY(table_key, row_id)
			) WITHOUT ROWID, STRICT;
			CREATE TABLE documents (
				table_key TEXT NOT NULL, row_id TEXT NOT NULL, yjs_state BLOB NOT NULL,
				PRIMARY KEY(table_key, row_id)
			) WITHOUT ROWID, STRICT;
			CREATE TABLE intents (
				table_key TEXT NOT NULL, row_id TEXT NOT NULL, sealed INTEGER NOT NULL,
				kind TEXT NOT NULL, fields_json TEXT, document_update BLOB,
				PRIMARY KEY(table_key, row_id, sealed)
			) WITHOUT ROWID, STRICT;
			CREATE TABLE replica (
				id INTEGER PRIMARY KEY, replica_id TEXT NOT NULL,
				accepted_round INTEGER NOT NULL, checkpoint INTEGER NOT NULL,
				in_flight_round INTEGER, in_flight_request_digest TEXT
			) STRICT;
			PRAGMA user_version = 1;
		`);
		const doc = new Y.Doc();
		doc.get('editor').insert(0, 'kept document');
		const update = Y.encodeStateAsUpdate(doc);
		doc.destroy();
		database
			.query('INSERT INTO rows VALUES (?, ?, ?)')
			.run('notes', 'note-1', '{"title":"kept row"}');
		database
			.query('INSERT INTO rows VALUES (?, ?, ?)')
			.run(RESERVED_KV_TABLE, RESERVED_KV_ROW_ID, '{"theme":"dark"}');
		database
			.query('INSERT INTO documents VALUES (?, ?, ?)')
			.run('notes', 'note-1', update);

		const sqlite = createBunSqliteAdapter(database);
		initializeLocalWorkspaceStorage(sqlite);

		expect(readLocalRow(sqlite, 'notes', 'note-1')).toEqual({
			title: 'kept row',
		});
		expect(readLocalRow(sqlite, RESERVED_KV_TABLE, RESERVED_KV_ROW_ID)).toEqual(
			{
				theme: 'dark',
			},
		);
		const restored = new Y.Doc();
		for (const part of readLocalDocumentParts(sqlite, 'notes', 'note-1')) {
			Y.applyUpdate(restored, part);
		}
		expect(restored.get('editor').toString()).toBe('kept document');
		restored.destroy();
		expect(
			database
				.query<{ name: string }, []>(
					`SELECT name FROM sqlite_master
					 WHERE type = 'table' AND name IN ('intents', 'replica')`,
				)
				.all(),
		).toEqual([]);
		expect(database.query('PRAGMA user_version').get()).toEqual({
			user_version: 2,
		});
	} finally {
		database.close();
	}
});
