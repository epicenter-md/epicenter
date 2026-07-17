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
import { createBunSqliteAdapter } from '@epicenter/row-sync/bun';
import { expectOk } from 'wellcrafted/testing';
import { mergeDocumentUpdates } from './canonical-documents.js';
import { createCanonicalRows } from './canonical-rows.js';
import { createCanonicalReplica } from './canonical-replica.js';
import { defineTable } from './lens-definition.js';
import {
	createTestTransport,
	openTestAuthority,
} from './row-sync-test-utils.js';

const definitions = {
	notes: defineTable({
		fields: { title: field.string(), archived: field.boolean() },
		optional: ['archived'],
	}),
};

test('local-only create, update, delete, and reopen preserve canonical state', () => {
	const root = mkdtempSync(join(tmpdir(), 'epicenter-canonical-rows-'));
	const path = join(root, 'workspace.sqlite3');
	try {
		let database = new Database(path, { create: true });
		let records = createCanonicalRows(
			createBunSqliteAdapter(database),
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
		records = createCanonicalRows(
			createBunSqliteAdapter(database),
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
		records = createCanonicalRows(
			createBunSqliteAdapter(database),
			definitions,
		);
		expect(expectOk(records.tables.notes.get(created.id))).toBeUndefined();
		expect(records.tables.notes.list().rows).toEqual([]);
		database.close();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('synchronized create, update, and delete project before authority round trips', async () => {
	const authorityState = openTestAuthority();
	const transport = createTestTransport(authorityState.authority);
	const database = new Database(':memory:');
	try {
		const sqlite = createBunSqliteAdapter(database);
		const replica = createCanonicalReplica({
			sqlite,
			transport,
			codec: { mergeUpdates: mergeDocumentUpdates },
		});
		const records = createCanonicalRows(sqlite, definitions, {
			admitIntent: replica.admit,
		});
		const created = records.tables.notes.create({ title: 'Local' });
		expect(expectOk(records.tables.notes.get(created.id))?.title).toBe('Local');
		await replica.synchronize();
		expect(authorityState.authority.inspect().rows[0]?.fields).toEqual({
			title: 'Local',
		});

		expectOk(records.tables.notes.update(created.id, { title: 'Accepted' }));
		await replica.synchronize();
		expect(authorityState.authority.inspect().rows[0]?.fields).toEqual({
			title: 'Accepted',
		});

		records.tables.notes.delete(created.id);
		expect(expectOk(records.tables.notes.get(created.id))).toBeUndefined();
		await replica.synchronize();
		expect(authorityState.authority.inspect().rows).toEqual([]);
	} finally {
		database.close();
		authorityState.database.close();
	}
});
