/**
 * Canonical Row Document Tests
 *
 * Verifies cached Yjs row-document leases, automatic SQLite persistence,
 * durability barriers, poisoning, and row-lifecycle revocation.
 *
 * Key behaviors:
 * - open, edit, await durability, dispose, and reopen restore state
 * - runtime durability barriers capture one fixed cut across cached documents
 * - persistence failure poisons the handle
 * - local and remote deletion revoke outstanding handles
 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { field } from '@epicenter/field';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import * as Y from '@y/y';
import {
	createDocumentRuntime,
	createLocalDocumentPersistence,
	mergeDocumentUpdates,
} from './canonical-documents.js';
import { createCanonicalRows } from './canonical-rows.js';
import { defineTable } from './lens-definition.js';
import {
	initializeLocalWorkspaceStorage,
	readLocalDocumentParts,
	readLocalRow,
} from './local-workspace-storage.js';

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
		initializeLocalWorkspaceStorage(sqlite);
		let documents: ReturnType<typeof createDocumentRuntime>;
		const records = createCanonicalRows(sqlite, definitions, {
			onRowsDeleted(addresses) {
				documents.revoke(addresses);
			},
		});
		const row = records.tables.notes.create({ title: 'Document owner' });
		documents = createDocumentRuntime({
			persistUpdate: createLocalDocumentPersistence({
				sqlite,
				readCurrentRow: (table, rowId) => readLocalRow(sqlite, table, rowId),
			}),
			readParts: (table, rowId) => readLocalDocumentParts(sqlite, table, rowId),
			readCurrentRow: (table, rowId) => readLocalRow(sqlite, table, rowId),
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
		initializeLocalWorkspaceStorage(sqlite);
		const row = createCanonicalRows(sqlite, definitions).tables.notes.create({
			title: 'Poisoned',
		});
		const failure = new Error('disk write failed');
		const documents = createDocumentRuntime({
			persistUpdate() {
				throw failure;
			},
			readParts: () => [],
			readCurrentRow: (table, rowId) => readLocalRow(sqlite, table, rowId),
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

test('runtime durability barrier waits for every currently cached document', async () => {
	const firstGate = Promise.withResolvers<void>();
	const secondGate = Promise.withResolvers<void>();
	const documents = createDocumentRuntime({
		persistUpdate(_table, rowId) {
			return rowId === 'first' ? firstGate.promise : secondGate.promise;
		},
		readParts: () => [],
		readCurrentRow: () => ({}),
	});
	using first = await documents.open('notes', 'first');
	using second = await documents.open('notes', 'second');
	first.get('editor').insert(0, 'first update');
	second.get('editor').insert(0, 'second update');

	let settled = false;
	const barrier = documents.captureDurabilityBarrier().then(() => {
		settled = true;
	});
	first[Symbol.dispose]();
	second[Symbol.dispose]();
	firstGate.resolve();
	await Promise.resolve();
	await Promise.resolve();
	expect(settled).toBe(false);
	secondGate.resolve();
	await barrier;
	expect(settled).toBe(true);
});

test('later document edit does not extend an earlier runtime barrier', async () => {
	const firstGate = Promise.withResolvers<void>();
	const laterGate = Promise.withResolvers<void>();
	let admission = 0;
	const documents = createDocumentRuntime({
		persistUpdate() {
			admission += 1;
			return admission === 1 ? firstGate.promise : laterGate.promise;
		},
		readParts: () => [],
		readCurrentRow: () => ({}),
	});
	using document = await documents.open('notes', 'one');
	document.get('editor').insert(0, 'captured');
	const barrier = documents.captureDurabilityBarrier();
	document.get('editor').insert(document.get('editor').length, ' later');

	firstGate.resolve();
	await barrier;
	expect(admission).toBe(2);
	laterGate.resolve();
	await document.whenDurable();
});

test('runtime durability barrier rejects captured persistence poison', async () => {
	const failure = new Error('captured persistence failed');
	const documents = createDocumentRuntime({
		persistUpdate() {
			throw failure;
		},
		readParts: () => [],
		readCurrentRow: () => ({}),
	});
	using document = await documents.open('notes', 'poisoned');
	document.get('editor').insert(0, 'not durable');

	await expect(documents.captureDurabilityBarrier()).rejects.toThrow(
		'captured persistence failed',
	);
});

test('revocation after capture does not reject the runtime durability barrier', async () => {
	const gate = Promise.withResolvers<void>();
	const documents = createDocumentRuntime({
		persistUpdate: () => gate.promise,
		readParts: () => [],
		readCurrentRow: () => ({}),
	});
	using document = await documents.open('notes', 'revoked');
	document.get('editor').insert(0, 'captured before revocation');
	const barrier = documents.captureDurabilityBarrier();
	documents.revokeAll();

	gate.resolve();
	await expect(barrier).resolves.toBeUndefined();
	await expect(document.whenDurable()).rejects.toThrow('was revoked');
});

test('local deletion revokes handles and drops queued updates', async () => {
	const database = new Database(':memory:');
	try {
		const sqlite = createBunSqliteAdapter(database);
		initializeLocalWorkspaceStorage(sqlite);
		let documents: ReturnType<typeof createDocumentRuntime>;
		const records = createCanonicalRows(sqlite, definitions, {
			onRowsDeleted: (addresses) => documents.revoke(addresses),
		});
		const row = records.tables.notes.create({ title: 'Delete me' });
		documents = createDocumentRuntime({
			persistUpdate: createLocalDocumentPersistence({
				sqlite,
				readCurrentRow: (table, rowId) => readLocalRow(sqlite, table, rowId),
			}),
			readParts: (table, rowId) => readLocalDocumentParts(sqlite, table, rowId),
			readCurrentRow: (table, rowId) => readLocalRow(sqlite, table, rowId),
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
		initializeLocalWorkspaceStorage(sqlite);
		const records = createCanonicalRows(sqlite, definitions);
		const row = records.tables.notes.create({ title: 'Keep my edit' });
		const documents = createDocumentRuntime({
			persistUpdate: createLocalDocumentPersistence({
				sqlite,
				readCurrentRow: (table, rowId) => readLocalRow(sqlite, table, rowId),
			}),
			readParts: (table, rowId) => readLocalDocumentParts(sqlite, table, rowId),
			readCurrentRow: (table, rowId) => readLocalRow(sqlite, table, rowId),
		});
		using document = await documents.open('notes', row.id);
		document.get('editor').insert(0, 'captured before promotion');
		// Acquisition promotion revokes every handle while this update is still
		// queued; the revocation must not drop the captured edit (ADR-0142).
		documents.revokeAll();
		expect(() => document.transact(() => undefined)).toThrow('was revoked');
		await expect(document.whenDurable()).rejects.toThrow('was revoked');

		using reopened = await documents.open('notes', row.id);
		expect(reopened.get('editor').toString()).toBe('captured before promotion');
	} finally {
		database.close();
	}
});
