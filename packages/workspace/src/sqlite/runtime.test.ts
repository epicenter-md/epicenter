/**
 * Workspace Runtime Tests
 *
 * Verifies the async release-lens surface assembled over one local canonical
 * SQLite owner.
 *
 * Key behaviors:
 * - table CRUD exposes create/update/delete/get/list
 * - every table exposes the singular row document capability
 * - KV and validated read-only SQL remain available
 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { field } from '@epicenter/field';
import { ROW_SYNC_ADMISSION_LIMITS } from '@epicenter/row-sync';
import { createBunSqliteAdapter } from '@epicenter/row-sync/bun';
import { Type } from 'typebox';
import { expectOk } from 'wellcrafted/testing';
import { defineTable } from './lens-definition.js';
import { createWorkspaceRuntime } from './runtime.js';
import { defineWorkspace } from './runtime-definition.js';

const definition = defineWorkspace({
	id: 'runtime-test',
	tables: {
		notes: defineTable({
			fields: { title: field.string(), archived: field.boolean() },
			optional: ['archived'],
		}),
	},
	kv: { theme: field.select(['light', 'dark']) },
});

test('runtime composes row, document, KV, and SQL capabilities', async () => {
	const database = new Database(':memory:');
	const runtime = createWorkspaceRuntime({
		async openRecordOwner() {
			return {
				sqlite: createBunSqliteAdapter(database),
				async [Symbol.asyncDispose]() {
					database.close();
				},
			};
		},
	});
	try {
		const workspace = await runtime.open(definition);
		const created = await workspace.tables.notes.create({ title: 'Draft' });
		expect(
			expectOk(
				await workspace.tables.notes.update(created.id, { archived: true }),
			),
		).toEqual({ id: created.id, title: 'Draft', archived: true });
		expect((await workspace.tables.notes.list()).rows).toHaveLength(1);

		using document = await workspace.tables.notes.document.open(created.id);
		document.get('editor').insert(0, 'hello');
		await document.whenDurable();
		expect(document.get('editor').toString()).toBe('hello');

		expectOk(await workspace.kv.set('theme', 'dark'));
		expect(expectOk(await workspace.kv.get('theme'))).toBe('dark');
		const rows = await workspace.records.sql(
			'SELECT id, title FROM notes',
			[],
			Type.Object({ id: Type.String(), title: Type.String() }),
		);
		expect(rows).toEqual([{ id: created.id, title: 'Draft' }]);

		await workspace.tables.notes.delete(created.id);
		expect(
			expectOk(await workspace.tables.notes.get(created.id)),
		).toBeUndefined();
	} finally {
		await runtime[Symbol.asyncDispose]();
	}
});

test('runtime binds one definition identity per workspace id', async () => {
	const database = new Database(':memory:');
	const runtime = createWorkspaceRuntime({
		async openRecordOwner() {
			return {
				sqlite: createBunSqliteAdapter(database),
				async [Symbol.asyncDispose]() {
					database.close();
				},
			};
		},
	});
	try {
		await runtime.open(definition);
		await expect(
			runtime.open(
				defineWorkspace({
					id: 'runtime-test',
					tables: definition.tables,
					kv: definition.kv,
				}),
			),
		).rejects.toThrow('already bound to another definition');
	} finally {
		await runtime[Symbol.asyncDispose]();
	}
});

test('local documents compact history and poison oversized live state', async () => {
	const database = new Database(':memory:');
	const runtime = createWorkspaceRuntime({
		async openRecordOwner() {
			return {
				sqlite: createBunSqliteAdapter(database),
				async [Symbol.asyncDispose]() {
					database.close();
				},
			};
		},
	});
	try {
		const workspace = await runtime.open(definition);
		const row = await workspace.tables.notes.create({ title: 'Bounded' });
		using document = await workspace.tables.notes.document.open(row.id);
		const editor = document.get('editor');
		editor.insert(0, 'a'.repeat(200 * 1024));
		await document.whenDurable();
		const before = database
			.query<{ bytes: number }, []>(
				'SELECT length(yjs_state) AS bytes FROM documents',
			)
			.get()?.bytes;
		editor.delete(0, 190 * 1024);
		await document.whenDurable();
		const after = database
			.query<{ bytes: number }, []>(
				'SELECT length(yjs_state) AS bytes FROM documents',
			)
			.get()?.bytes;
		expect(after).toBeLessThan(before ?? Number.POSITIVE_INFINITY);

		editor.insert(editor.length, 'x'.repeat(300 * 1024));
		await expect(document.whenDurable()).rejects.toThrow(
			'Canonical row document exceeds its size limit',
		);
		expect(() => document.transact(() => undefined)).toThrow(
			'Canonical row document exceeds its size limit',
		);
		expect(after).toBeLessThanOrEqual(
			ROW_SYNC_ADMISSION_LIMITS.canonicalDocumentBytes,
		);
	} finally {
		await runtime[Symbol.asyncDispose]();
	}
});
