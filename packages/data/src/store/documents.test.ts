import { field } from '@epicenter/data/definition';
/**
 * The independent row document (ADR-0248): derived addresses, asynchronous
 * fully hydrated opens, live reuse, restart round-trips, retirement composed
 * with row deletion, and synchronization through the one store connection.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { defineData, documentAddress } from '@epicenter/data/definition';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import * as Y from '@y/y';
import type { Result } from 'wellcrafted/result';
import { expectErr, expectOk as expectResult } from 'wellcrafted/testing';

import { openMemory } from './bun.js';
import { decodeEnvelope } from './envelope.js';
import { APP_DOCUMENT } from './log.js';
import { createAccountStore, syncEngineOf } from './store.js';

const database = defineData({
	id: 'so.epicenter.doctest',
	kv: {},
	tables: { notes: { title: field.string() } },
});

function expectOk<TValue, TError>(
	result: Result<TValue, TError> | TValue,
): TValue {
	if (
		typeof result === 'object' &&
		result !== null &&
		'data' in result &&
		'error' in result
	) {
		return expectResult(result as Result<TValue, TError>);
	}
	return result as TValue;
}

/** Two stores over one shared file, for restart tests. */
function overFile(file: Database) {
	return createAccountStore({
		definition: database,
		sqlite: createBunSqliteAdapter(file),
	});
}

function typeText(
	handle: { get(root: string, typeName?: string): Y.Type },
	root: string,
	words: string,
) {
	const text = handle.get(root, 'text');
	// SAFETY: `change` builds the delta shape `applyDelta`'s rc typing spells
	// as `never`.
	text.applyDelta(text.change.insert(words) as never);
}

describe('table.document.open (ADR-0248)', () => {
	test('opens the derived address, fully hydrated, and round-trips restart', async () => {
		const file = new Database(':memory:');
		{
			const db = overFile(file);
			await using _db = db;
			const note = expectOk(db.tables.notes.create({ title: 'groceries' }));
			const handle = expectOk(await db.tables.notes.document.open(note.id));
			if (handle === undefined) throw new Error('the row has no document');
			typeText(handle, 'body', 'buy milk');
			handle[Symbol.dispose]();
		}
		{
			const db = overFile(file);
			await using _db = db;
			const [id] = db.tables.notes.ids();
			if (id === undefined) throw new Error('the row did not survive');
			const handle = expectOk(await db.tables.notes.document.open(id));
			if (handle === undefined) throw new Error('the row has no document');
			expect(handle.get('body').toString()).toBe('buy milk');
			handle[Symbol.dispose]();
		}
	});

	test('an absent row has no document, which is a fact not a failure', async () => {
		const db = openMemory(database);
		await using _db = db;
		expect(expectOk(await db.tables.notes.document.open('nope'))).toBeUndefined();
	});

	test('two handles for one address share one live document', async () => {
		const db = openMemory(database);
		await using _db = db;
		const note = expectOk(db.tables.notes.create({ title: 'shared' }));
		const first = expectOk(await db.tables.notes.document.open(note.id));
		const second = expectOk(await db.tables.notes.document.open(note.id));
		if (first === undefined || second === undefined) {
			throw new Error('the row has no document');
		}
		typeText(first, 'body', 'through the first');
		expect(second.get('body').toString()).toContain('through the first');
		// Same live Y.Doc, not two converging copies.
		expect(first.get('body').doc).toBe(second.get('body').doc);
		first[Symbol.dispose]();
		// The second handle still holds the document open.
		expect(second.get('body').toString()).toContain('through the first');
		second[Symbol.dispose]();
	});

	test('opening one address never hydrates another', async () => {
		const db = openMemory(database);
		await using _db = db;
		const a = expectOk(db.tables.notes.create({ title: 'a' }));
		const b = expectOk(db.tables.notes.create({ title: 'b' }));
		const first = expectOk(await db.tables.notes.document.open(a.id));
		if (first === undefined) throw new Error('no document');
		typeText(first, 'body', 'a alone');
		first[Symbol.dispose]();

		const second = expectOk(await db.tables.notes.document.open(b.id));
		if (second === undefined) throw new Error('no document');
		expect(second.get('body').toString()).toBe('');
		expect([...second.get('body').doc?.share.keys() ?? []]).toEqual(['body']);
		second[Symbol.dispose]();
	});

	test('listing rows and reading scalars opens no rich documents', async () => {
		const file = new Database(':memory:');
		{
			const db = overFile(file);
			await using _db = db;
			const note = expectOk(db.tables.notes.create({ title: 'unopened' }));
			const handle = expectOk(await db.tables.notes.document.open(note.id));
			if (handle === undefined) throw new Error('no document');
			typeText(handle, 'body', 'heavy prose');
			handle[Symbol.dispose]();
		}
		{
			const db = overFile(file);
			await using _db = db;
			// Reads walk the application document alone; nothing here awaits, so
			// nothing here can hydrate a row document.
			const { rows } = db.tables.notes.list();
			expect(rows).toHaveLength(1);
			expect(db.tables.notes.ids()).toHaveLength(1);
		}
	});
});

describe('row deletion retires the document (ADR-0248)', () => {
	test('delete removes the row, refuses reopen, and drops the stored chain', async () => {
		const file = new Database(':memory:');
		const address = { databaseId: database.id, tableName: 'notes' };
		let derived: string;
		{
			const db = overFile(file);
			await using _db = db;
			const note = expectOk(db.tables.notes.create({ title: 'doomed' }));
			derived = documentAddress({ ...address, rowId: note.id });
			const handle = expectOk(await db.tables.notes.document.open(note.id));
			if (handle === undefined) throw new Error('no document');
			typeText(handle, 'body', 'gone soon');
			handle[Symbol.dispose]();

			expect(db.tables.notes.delete(note.id)).toBe(true);
			// The row is gone, so the table answers absence.
			expect(expectOk(await db.tables.notes.document.open(note.id))).toBeUndefined();
			// The manager refuses the raw address rather than resurrecting it.
			expect(expectErr(await db.store.documents.open(derived)).name).toBe(
				'DocumentRetired',
			);
		}
		{
			// Retirement is durable: a restart still refuses, and the chain is gone.
			const db = overFile(file);
			await using _db = db;
			expect(expectErr(await db.store.documents.open(derived)).name).toBe(
				'DocumentRetired',
			);
			const raw = createBunSqliteAdapter(file);
			expect(
				raw.all('SELECT seq FROM _updates WHERE document = ?', [derived]),
			).toHaveLength(0);
			expect(
				raw.all('SELECT document FROM _tombstones WHERE document = ?', [
					derived,
				]),
			).toHaveLength(1);
		}
	});

	test('a late remote update for a retired address is dropped whole', async () => {
		// Author a document on one store, deliver it to a peer AFTER the peer
		// deleted the row: nothing may come back.
		const author = openMemory(database);
		await using _author = author;
		const peer = openMemory(database);
		await using _peer = peer;
		const note = expectOk(author.tables.notes.create({ title: 'raced' }));

		// The peer converges on the row first.
		expectOk(
			syncEngineOf(peer.store).applyRemote(appState(author)),
		);
		const handle = expectOk(await author.tables.notes.document.open(note.id));
		if (handle === undefined) throw new Error('no document');
		typeText(handle, 'body', 'late words');
		handle[Symbol.dispose]();
		const late = syncEngineOf(author.store).coalesce();
		if (late === undefined) throw new Error('nothing to send');

		// The peer deletes the row, then the late document bytes arrive.
		expect(peer.tables.notes.delete(note.id)).toBe(true);
		expectOk(syncEngineOf(peer.store).applyRemote(late.bytes));

		const derived = documentAddress({
			databaseId: database.id,
			tableName: 'notes',
			rowId: note.id,
		});
		expect(expectErr(await peer.store.documents.open(derived)).name).toBe(
			'DocumentRetired',
		);
	});
});

describe('row documents ride the one store connection (ADR-0248)', () => {
	test('local document work coalesces into one envelope and syncs to a peer', async () => {
		const author = openMemory(database);
		await using _author = author;
		const reader = openMemory(database);
		await using _reader = reader;

		const note = expectOk(author.tables.notes.create({ title: 'synced' }));
		const handle = expectOk(await author.tables.notes.document.open(note.id));
		if (handle === undefined) throw new Error('no document');
		typeText(handle, 'body', 'travels once');
		handle[Symbol.dispose]();

		const owed = syncEngineOf(author.store).coalesce();
		if (owed === undefined) throw new Error('nothing owed');
		// One payload, sections per document: scalar row plus rich document.
		const sections = expectOk(decodeEnvelope(owed.bytes));
		expect(sections.map((section) => section.document).sort()).toEqual(
			[
				APP_DOCUMENT,
				documentAddress({
					databaseId: database.id,
					tableName: 'notes',
					rowId: note.id,
				}),
			].sort(),
		);

		expectOk(syncEngineOf(reader.store).applyRemote(owed.bytes));
		expect(reader.tables.notes.ids()).toEqual([note.id]);
		const received = expectOk(await reader.tables.notes.document.open(note.id));
		if (received === undefined) throw new Error('no document');
		expect(received.get('body').toString()).toBe('travels once');
		received[Symbol.dispose]();
	});

	test('accepted remote document bytes create no publication debt', async () => {
		const author = openMemory(database);
		await using _author = author;
		const reader = openMemory(database);
		await using _reader = reader;
		const note = expectOk(author.tables.notes.create({ title: 'quiet' }));
		const handle = expectOk(await author.tables.notes.document.open(note.id));
		if (handle === undefined) throw new Error('no document');
		typeText(handle, 'body', 'not re-owed');
		handle[Symbol.dispose]();
		const owed = syncEngineOf(author.store).coalesce();
		if (owed === undefined) throw new Error('nothing owed');

		expectOk(syncEngineOf(reader.store).applyRemote(owed.bytes));
		// The reader owes nothing back: the bytes came FROM the authority.
		expect(syncEngineOf(reader.store).coalesce()).toBeUndefined();
	});

	test('a remote update reaches a document that is already open, live', async () => {
		const author = openMemory(database);
		await using _author = author;
		const reader = openMemory(database);
		await using _reader = reader;
		const note = expectOk(author.tables.notes.create({ title: 'live' }));
		expectOk(syncEngineOf(reader.store).applyRemote(appState(author)));

		const watching = expectOk(await reader.tables.notes.document.open(note.id));
		if (watching === undefined) throw new Error('no document');
		expect(watching.get('body').toString()).toBe('');

		const handle = expectOk(await author.tables.notes.document.open(note.id));
		if (handle === undefined) throw new Error('no document');
		typeText(handle, 'body', 'arrives live');
		handle[Symbol.dispose]();
		const owed = syncEngineOf(author.store).coalesce();
		if (owed === undefined) throw new Error('nothing owed');
		expectOk(syncEngineOf(reader.store).applyRemote(owed.bytes));

		expect(watching.get('body').toString()).toBe('arrives live');
		watching[Symbol.dispose]();
	});

	test('the snapshot bundle carries every document and adopts whole', async () => {
		const author = openMemory(database);
		await using _author = author;
		const fresh = openMemory(database);
		await using _fresh = fresh;
		const note = expectOk(author.tables.notes.create({ title: 'bundled' }));
		const handle = expectOk(await author.tables.notes.document.open(note.id));
		if (handle === undefined) throw new Error('no document');
		typeText(handle, 'body', 'whole state');
		handle[Symbol.dispose]();

		const snapshot = await syncEngineOf(author.store).encodeSnapshot();
		expectOk(syncEngineOf(fresh.store).applyRemote(snapshot));

		expect(fresh.tables.notes.ids()).toEqual([note.id]);
		const adopted = expectOk(await fresh.tables.notes.document.open(note.id));
		if (adopted === undefined) throw new Error('no document');
		expect(adopted.get('body').toString()).toBe('whole state');
		adopted[Symbol.dispose]();
	});
});

/** The author's application document alone, as one envelope. */
function appState(author: {
	store: Parameters<typeof syncEngineOf>[0];
}): Uint8Array {
	const owed = syncEngineOf(author.store).coalesce();
	if (owed === undefined) throw new Error('nothing owed');
	return owed.bytes;
}
