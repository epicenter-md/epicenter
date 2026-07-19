/**
 * Canonical Rows Tests
 *
 * Verifies release-lens CRUD over both local-only canonical rows and a
 * synchronized RowIntent replica.
 *
 * Key behaviors:
 * - local-only rows survive SQLite close and reopen
 * - synchronized creates, updates, and deletes round-trip through authority
 * - optional undefined normalizes to an absolute unset
 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { field } from '@epicenter/field';
import { foldFields, type WireRowIntent } from '@epicenter/row-sync';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { Type } from 'typebox';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { createCanonicalRowsView } from './canonical-rows.js';
import {
	createCanonicalStore,
	isWorkspaceRowAbsentError,
} from './canonical-store.js';
import { defineTable, type JsonObject } from './lens-definition.js';
import { initializeLocalWorkspaceStorage } from './local-workspace-storage.js';

const definitions = {
	notes: defineTable({
		fields: { title: field.string(), archived: field.boolean() },
		optional: ['archived'],
	}),
};

function refusal(run: () => void): unknown {
	try {
		run();
		return undefined;
	} catch (cause) {
		return cause;
	}
}

test('updating or deleting an absent row refuses at the store admission boundary', () => {
	const database = new Database(':memory:');
	const sqlite = createBunSqliteAdapter(database);
	initializeLocalWorkspaceStorage(sqlite);
	const store = createCanonicalStore(sqlite);
	const records = createCanonicalRowsView(store, definitions);
	const absentId = 'a'.repeat(24);
	try {
		// A never-present row refuses: update through the renderer read, delete
		// through the owner guard (the view has no delete pre-check).
		expect(
			expectErr(records.tables.notes.update(absentId, { title: 'x' })).name,
		).toBe('MissingRow');
		expect(
			isWorkspaceRowAbsentError(
				refusal(() => records.tables.notes.delete(absentId)),
			),
		).toBeTrue();

		// A row that dies between an earlier read and admission still refuses:
		// the owner guard re-checks liveness atomically at admit time.
		const created = records.tables.notes.create({ title: 'A' });
		expect(store.read('notes', created.id)).toEqual({ title: 'A' });
		store.admit({ kind: 'delete', table: 'notes', rowId: created.id });
		expect(
			isWorkspaceRowAbsentError(
				refusal(() =>
					store.admit({
						kind: 'update',
						table: 'notes',
						rowId: created.id,
						fields: { set: { title: 'B' }, unset: [] },
					}),
				),
			),
		).toBeTrue();
		expect(
			isWorkspaceRowAbsentError(
				refusal(() =>
					store.admit({ kind: 'delete', table: 'notes', rowId: created.id }),
				),
			),
		).toBeTrue();
	} finally {
		database.close();
	}
});

test('local-only create, update, delete, and reopen preserve canonical state', () => {
	const root = mkdtempSync(join(tmpdir(), 'epicenter-canonical-rows-'));
	const path = join(root, 'workspace.sqlite3');
	try {
		let database = new Database(path, { create: true });
		initializeLocalWorkspaceStorage(createBunSqliteAdapter(database));
		let records = createCanonicalRowsView(
			createCanonicalStore(createBunSqliteAdapter(database)),
			definitions,
		);
		const created = records.tables.notes.create({
			title: 'Draft',
			archived: true,
		});
		expect(created.id).toMatch(/^[a-z0-9]{24}$/);
		expect(
			expectOk(
				records.tables.notes.update(created.id, { archived: undefined }),
			),
		).toEqual({ id: created.id, title: 'Draft' });
		database.close();

		database = new Database(path);
		records = createCanonicalRowsView(
			createCanonicalStore(createBunSqliteAdapter(database)),
			definitions,
		);
		expect(expectOk(records.tables.notes.get(created.id))).toEqual({
			id: created.id,
			title: 'Draft',
		});
		expect(records.tables.notes.list().rows).toHaveLength(1);
		records.tables.notes.delete(created.id);
		database.close();

		database = new Database(path);
		records = createCanonicalRowsView(
			createCanonicalStore(createBunSqliteAdapter(database)),
			definitions,
		);
		expect(expectOk(records.tables.notes.get(created.id))).toBeUndefined();
		expect(records.tables.notes.list().rows).toEqual([]);
		database.close();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('records exposes synchronized optimistic create, update, and delete state', () => {
	const database = new Database(':memory:');
	const sqlite = createBunSqliteAdapter(database);
	initializeLocalWorkspaceStorage(sqlite);
	sqlite.run(`CREATE TABLE intents (
		table_key TEXT NOT NULL,
		row_id TEXT NOT NULL,
		PRIMARY KEY(table_key, row_id)
	) WITHOUT ROWID, STRICT`);
	const optimistic = new Map<string, JsonObject>();
	const keyFor = (table: string, rowId: string) => `${table}:${rowId}`;
	const records = createCanonicalRowsView(
		createCanonicalStore(sqlite, {
			admitIntent(intent: WireRowIntent) {
				const key = keyFor(intent.table, intent.rowId);
				switch (intent.kind) {
					case 'create':
						optimistic.set(key, intent.fields);
						break;
					case 'update': {
						const folded = foldFields(optimistic.get(key), intent);
						if (folded.kind === 'fields') optimistic.set(key, folded.fields);
						break;
					}
					case 'delete':
						optimistic.delete(key);
						break;
					default:
						intent satisfies never;
				}
				sqlite.run(
					`INSERT OR IGNORE INTO intents(table_key, row_id) VALUES (?, ?)`,
					[intent.table, intent.rowId],
				);
			},
			readCurrentRow(table, rowId) {
				return optimistic.get(keyFor(table, rowId));
			},
		}),
		definitions,
	);
	try {
		const created = records.tables.notes.create({ title: 'Draft' });
		expectOk(records.tables.notes.update(created.id, { archived: true }));
		const resultSchema = Type.Object({
			id: Type.String(),
			archived: Type.Integer(),
		});
		const query = `SELECT row_id AS id,
			json_extract(fields_json, '$.archived') AS archived
			FROM records WHERE table_key = 'notes'`;
		expect(records.sql(query, [], resultSchema)).toEqual([
			{ id: created.id, archived: 1 },
		]);
		records.tables.notes.delete(created.id);
		expect(records.sql(query, [], resultSchema)).toEqual([]);
	} finally {
		database.close();
	}
});

test('raw local and synchronized stores share portable intent admission', () => {
	for (const synchronized of [false, true]) {
		const database = new Database(':memory:');
		const sqlite = createBunSqliteAdapter(database);
		initializeLocalWorkspaceStorage(sqlite);
		let forwarded = 0;
		const store = createCanonicalStore(sqlite, {
			...(synchronized
				? {
						admitIntent() {
							forwarded += 1;
						},
					}
				: {}),
		});
		try {
			expect(() =>
				store.admit({
					kind: 'update',
					table: 'notes',
					rowId: '../outside',
					fields: { set: { title: 'no' }, unset: [] },
				}),
			).toThrow('Invalid row intent');
			expect(() =>
				store.admit({
					kind: 'create',
					table: '__epicenter_private',
					rowId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
					fields: {},
				}),
			).toThrow('Invalid row intent');
			expect(() =>
				store.admit({
					kind: 'delete',
					table: '__epicenter_kv',
					rowId: 'workspace',
				}),
			).toThrow('Invalid row intent');
			expect(forwarded).toBe(0);
		} finally {
			database.close();
		}
	}
});
