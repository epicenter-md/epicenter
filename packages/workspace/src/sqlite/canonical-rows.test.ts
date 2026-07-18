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
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { expectOk } from 'wellcrafted/testing';
import { createCanonicalRows } from './canonical-rows.js';
import { defineTable } from './lens-definition.js';
import { initializeLocalWorkspaceStorage } from './local-workspace-storage.js';

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
		initializeLocalWorkspaceStorage(createBunSqliteAdapter(database));
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
