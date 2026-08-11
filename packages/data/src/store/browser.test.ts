/**
 * Browser Store Document Identity Tests
 *
 * A browser application keeps two durable local documents (ADR-0233): the
 * device-local private document and the workspace replica. These tests pin
 * the storage identity that keeps them structurally separate: distinct
 * IndexedDB databases, distinct open claims, a discard whose blast radius is
 * one document, and a clean-break fate for the pre-split single database.
 *
 * Key behaviors:
 * - Private and workspace open at once, into separate databases
 * - A second open of the same document is refused with AlreadyOpen
 * - Discarding the workspace deletes only the workspace database
 * - Each document's writes survive a close-and-reopen under its own name
 * - The legacy un-suffixed database is deleted at open, never read
 *
 * Runs under bun with `fake-indexeddb` supplying `indexedDB`; the durability
 * evidence in `evidence/browser/durable-store.ts` proves the same store in a
 * real Chromium across a real reload.
 */
import 'fake-indexeddb/auto';
import { describe, expect, test } from 'bun:test';
import { defineLens } from '@epicenter/lens';
import { expectErr, expectOk } from 'wellcrafted/testing';

import { open } from './browser.js';

/** One namespace per concern, so tests share no IndexedDB state. */
function lensFor(label: string) {
	return defineLens({
		namespace: `so.epicenter.browsertest.${label}`,
		tables: { notes: { title: 'string' } },
	});
}

function titles(app: {
	tables: {
		notes: { list(): { data: { rows: { title: string }[] } | null } };
	};
}): string[] {
	return (app.tables.notes.list().data?.rows ?? [])
		.map((row) => row.title)
		.sort();
}

async function databaseNames(): Promise<string[]> {
	const databases = await indexedDB.databases();
	return databases
		.map((database) => database.name)
		.filter((name): name is string => name !== undefined)
		.sort();
}

describe('two documents of one application', () => {
	test('private and workspace open at once into separate databases', async () => {
		const lens = lensFor('pair');
		const priv = expectOk(await open(lens, { document: 'private' }));
		const workspace = expectOk(await open(lens, { document: 'workspace' }));

		expectOk(priv.tables.notes.create({ title: 'mine alone' }));
		expectOk(workspace.tables.notes.create({ title: 'shared' }));
		expect(titles(priv)).toEqual(['mine alone']);
		expect(titles(workspace)).toEqual(['shared']);

		const names = await databaseNames();
		expect(names).toContain(`epicenter-store-${lens.namespace}#private`);
		expect(names).toContain(`epicenter-store-${lens.namespace}#workspace`);

		await priv[Symbol.asyncDispose]();
		await workspace[Symbol.asyncDispose]();
	});

	test('a second open of the same document is refused with AlreadyOpen', async () => {
		const lens = lensFor('claim');
		const first = expectOk(await open(lens, { document: 'private' }));
		const again = expectErr(await open(lens, { document: 'private' }));
		expect(again.name).toBe('AlreadyOpen');
		await first[Symbol.asyncDispose]();
		// Disposal releases the claim, so the same document opens again.
		const reopened = expectOk(await open(lens, { document: 'private' }));
		await reopened[Symbol.asyncDispose]();
	});

	test('discarding the workspace deletes only the workspace database', async () => {
		const lens = lensFor('discard');
		const priv = expectOk(await open(lens, { document: 'private' }));
		expectOk(priv.tables.notes.create({ title: 'anonymous work' }));
		await priv[Symbol.asyncDispose]();

		const workspace = expectOk(await open(lens, { document: 'workspace' }));
		expectOk(workspace.tables.notes.create({ title: 'doomed replica' }));
		expectOk(await workspace.store.discard());

		const names = await databaseNames();
		expect(names).not.toContain(`epicenter-store-${lens.namespace}#workspace`);
		expect(names).toContain(`epicenter-store-${lens.namespace}#private`);

		// The workspace rejoins at zero; the private document is untouched.
		const freshWorkspace = expectOk(
			await open(lens, { document: 'workspace' }),
		);
		expect(titles(freshWorkspace)).toEqual([]);
		await freshWorkspace[Symbol.asyncDispose]();
		const reopenedPrivate = expectOk(await open(lens, { document: 'private' }));
		expect(titles(reopenedPrivate)).toEqual(['anonymous work']);
		await reopenedPrivate[Symbol.asyncDispose]();
	});

	test('each document survives a close-and-reopen under its own name', async () => {
		const lens = lensFor('reopen');
		{
			const priv = expectOk(await open(lens, { document: 'private' }));
			expectOk(priv.tables.notes.create({ title: 'kept private' }));
			await priv[Symbol.asyncDispose]();
		}
		{
			const workspace = expectOk(await open(lens, { document: 'workspace' }));
			expectOk(workspace.tables.notes.create({ title: 'kept workspace' }));
			await workspace[Symbol.asyncDispose]();
		}
		const priv = expectOk(await open(lens, { document: 'private' }));
		const workspace = expectOk(await open(lens, { document: 'workspace' }));
		expect(titles(priv)).toEqual(['kept private']);
		expect(titles(workspace)).toEqual(['kept workspace']);
		await priv[Symbol.asyncDispose]();
		await workspace[Symbol.asyncDispose]();
	});
});

describe('the clean break: the pre-split single database', () => {
	/** Fabricate `epicenter-store-<namespace>`, the pre-ADR-0233 artifact. */
	function seedLegacyDatabase(namespace: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const request = indexedDB.open(`epicenter-store-${namespace}`, 1);
			request.onupgradeneeded = () => {
				request.result.createObjectStore('state');
			};
			request.onsuccess = () => {
				const database = request.result;
				const transaction = database.transaction('state', 'readwrite');
				transaction
					.objectStore('state')
					.put({ updates: [], outbox: [], cursor: 7 }, 'durable');
				transaction.oncomplete = () => {
					database.close();
					resolve();
				};
				transaction.onerror = () => reject(transaction.error);
			};
			request.onerror = () => reject(request.error);
		});
	}

	test('opening either document deletes the legacy database and reads nothing from it', async () => {
		const lens = lensFor('legacy');
		await seedLegacyDatabase(lens.namespace);
		expect(await databaseNames()).toContain(
			`epicenter-store-${lens.namespace}`,
		);

		const priv = expectOk(await open(lens, { document: 'private' }));
		expect(titles(priv)).toEqual([]);
		expect(await databaseNames()).not.toContain(
			`epicenter-store-${lens.namespace}`,
		);
		await priv[Symbol.asyncDispose]();

		// The deletion repeats at every open, so a legacy database reappearing
		// (an old tab writing after this one deleted) dies at the next boot too.
		await seedLegacyDatabase(lens.namespace);
		const workspace = expectOk(await open(lens, { document: 'workspace' }));
		expect(titles(workspace)).toEqual([]);
		expect(await databaseNames()).not.toContain(
			`epicenter-store-${lens.namespace}`,
		);
		await workspace[Symbol.asyncDispose]();
	});
});
