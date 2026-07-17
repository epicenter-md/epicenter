/**
 * Canonical Row Document Tests
 *
 * Verifies cached Yjs row-document leases, automatic SQLite persistence,
 * durability barriers, poisoning, and row-lifecycle revocation.
 *
 * Key behaviors:
 * - open, edit, await durability, dispose, and reopen restore state
 * - persistence failure poisons the handle
 * - local and remote deletion revoke outstanding handles
 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { field } from '@epicenter/field';
import { createBunSqliteAdapter } from '@epicenter/row-sync/bun';
import * as Y from '@y/y';
import {
	createDocumentRuntime,
	createLocalDocumentAdmission,
	mergeDocumentUpdates,
} from './canonical-documents.js';
import { createCanonicalRecords } from './canonical-records.js';
import {
	createCanonicalReplica,
	readCurrentDocumentParts,
	readCurrentRow,
} from './canonical-replica.js';
import { defineTable } from './lens-definition.js';
import {
	createTestTransport,
	openTestAuthority,
} from './row-sync-test-utils.js';

const definitions = {
	notes: defineTable({ fields: { title: field.string() } }),
};

test('compaction returns a small delta against a confirmed base', () => {
	const source = new Y.Doc();
	const editor = source.get('editor');
	editor.insert(0, 'a'.repeat(80 * 1024));
	const base = Y.encodeStateAsUpdate(source);
	let incremental: Uint8Array | undefined;
	source.on('update', (update) => {
		incremental = Uint8Array.from(update);
	});
	editor.insert(editor.length, 'tail');
	if (!incremental) throw new Error('Expected an incremental update');

	const compacted = mergeDocumentUpdates([base, incremental], 1);
	const full = mergeDocumentUpdates([base, incremental]);
	expect(compacted.byteLength).toBeLessThan(full.byteLength);

	const reconstructed = new Y.Doc();
	Y.applyUpdate(reconstructed, base);
	Y.applyUpdate(reconstructed, compacted);
	expect(reconstructed.get('editor').toString()).toBe(editor.toString());
	reconstructed.destroy();
	source.destroy();
});

test('open, edit, whenDurable, dispose, and reopen restore durable state', async () => {
	const database = new Database(':memory:');
	try {
		const sqlite = createBunSqliteAdapter(database);
		let documents: ReturnType<typeof createDocumentRuntime>;
		const records = createCanonicalRecords(sqlite, definitions, {
			onRowsDeleted(addresses) {
				documents.revoke(addresses);
			},
		});
		const row = records.tables.notes.create({ title: 'Document owner' });
		documents = createDocumentRuntime({
			admitIntent: createLocalDocumentAdmission({
				sqlite,
				readCurrentRow: (table, rowId) => readCurrentRow(sqlite, table, rowId),
			}),
			readParts: (table, rowId) =>
				readCurrentDocumentParts(sqlite, table, rowId),
			readCurrentRow: (table, rowId) => readCurrentRow(sqlite, table, rowId),
		});
		const first = await documents.open('notes', row.id);
		const second = await documents.open('notes', row.id);
		expect(first.get('editor')).toBe(second.get('editor'));
		first.get('editor').insert(0, 'hello');
		await first.whenDurable();
		first[Symbol.dispose]();
		second[Symbol.dispose]();
		await Promise.resolve();

		using reopened = await documents.open('notes', row.id);
		expect(reopened.get('editor').toString()).toBe('hello');
	} finally {
		database.close();
	}
});

test('persistence failure poisons durability and further transactions', async () => {
	const database = new Database(':memory:');
	try {
		const sqlite = createBunSqliteAdapter(database);
		const row = createCanonicalRecords(sqlite, definitions).tables.notes.create(
			{
				title: 'Poisoned',
			},
		);
		const failure = new Error('disk write failed');
		const documents = createDocumentRuntime({
			admitIntent() {
				throw failure;
			},
			readParts: () => [],
			readCurrentRow: (table, rowId) => readCurrentRow(sqlite, table, rowId),
		});
		using document = await documents.open('notes', row.id);
		document.get('editor').insert(0, 'memory only');
		await expect(document.whenDurable()).rejects.toThrow('disk write failed');
		expect(() => document.transact(() => undefined)).toThrow(
			'disk write failed',
		);
	} finally {
		database.close();
	}
});

test('local deletion revokes handles and drops queued updates', async () => {
	const database = new Database(':memory:');
	try {
		const sqlite = createBunSqliteAdapter(database);
		let documents: ReturnType<typeof createDocumentRuntime>;
		const records = createCanonicalRecords(sqlite, definitions, {
			onRowsDeleted: (addresses) => documents.revoke(addresses),
		});
		const row = records.tables.notes.create({ title: 'Delete me' });
		documents = createDocumentRuntime({
			admitIntent: createLocalDocumentAdmission({
				sqlite,
				readCurrentRow: (table, rowId) => readCurrentRow(sqlite, table, rowId),
			}),
			readParts: (table, rowId) =>
				readCurrentDocumentParts(sqlite, table, rowId),
			readCurrentRow: (table, rowId) => readCurrentRow(sqlite, table, rowId),
		});
		using document = await documents.open('notes', row.id);
		document.get('editor').insert(0, 'queued');
		records.tables.notes.delete(row.id);
		expect(() => document.transact(() => undefined)).toThrow('was revoked');
		await expect(document.whenDurable()).rejects.toThrow('was revoked');
		expect(database.query('SELECT * FROM documents').all()).toEqual([]);
	} finally {
		database.close();
	}
});

test('promotion-style revocation drains captured updates into durable intents', async () => {
	const database = new Database(':memory:');
	try {
		const sqlite = createBunSqliteAdapter(database);
		const records = createCanonicalRecords(sqlite, definitions);
		const row = records.tables.notes.create({ title: 'Keep my edit' });
		const documents = createDocumentRuntime({
			admitIntent: createLocalDocumentAdmission({
				sqlite,
				readCurrentRow: (table, rowId) => readCurrentRow(sqlite, table, rowId),
			}),
			readParts: (table, rowId) =>
				readCurrentDocumentParts(sqlite, table, rowId),
			readCurrentRow: (table, rowId) => readCurrentRow(sqlite, table, rowId),
		});
		using document = await documents.open('notes', row.id);
		document.get('editor').insert(0, 'captured before promotion');
		// Baseline promotion revokes every handle while this update is still
		// queued; the revocation must not drop the captured edit (ADR-0136).
		documents.revokeAll();
		expect(() => document.transact(() => undefined)).toThrow('was revoked');
		await expect(document.whenDurable()).rejects.toThrow('was revoked');

		using reopened = await documents.open('notes', row.id);
		expect(reopened.get('editor').toString()).toBe(
			'captured before promotion',
		);
	} finally {
		database.close();
	}
});

test('remote deletion revokes a synchronized row document handle', async () => {
	const authorityState = openTestAuthority();
	const firstTransport = createTestTransport(authorityState.authority);
	const secondTransport = createTestTransport(authorityState.authority);
	const firstDatabase = new Database(':memory:');
	const secondDatabase = new Database(':memory:');
	try {
		const firstSqlite = createBunSqliteAdapter(firstDatabase);
		let documents: ReturnType<typeof createDocumentRuntime>;
		const first = createCanonicalReplica({
			sqlite: firstSqlite,
			transport: firstTransport,
			codec: { mergeUpdates: mergeDocumentUpdates },
			onRowsDeleted: (addresses) => documents.revoke(addresses),
		});
		const firstRecords = createCanonicalRecords(firstSqlite, definitions, {
			admitIntent: first.admit,
		});
		const row = firstRecords.tables.notes.create({ title: 'Shared' });
		await first.synchronize();
		documents = createDocumentRuntime({
			admitIntent: first.admit,
			readParts: first.readCurrentDocumentParts,
			readCurrentRow: first.readCurrentRow,
		});
		using document = await documents.open('notes', row.id);

		const secondSqlite = createBunSqliteAdapter(secondDatabase);
		const second = createCanonicalReplica({
			sqlite: secondSqlite,
			transport: secondTransport,
			codec: { mergeUpdates: mergeDocumentUpdates },
		});
		await second.synchronize();
		second.admit({ kind: 'delete', table: 'notes', rowId: row.id });
		await second.synchronize();
		await first.synchronize();
		expect(() => document.transact(() => undefined)).toThrow('was revoked');
	} finally {
		firstDatabase.close();
		secondDatabase.close();
		authorityState.database.close();
	}
});
