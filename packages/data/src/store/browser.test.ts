/**
 * Browser Store Address Tests
 *
 * A browser application keeps one device-owned private document and one
 * retained workspace replica per account (ADR-0233). These tests pin the
 * addresses that hold them apart: `epicenter/<namespace>/private` and
 * `epicenter/<namespace>/workspace/<principal id>`, one IndexedDB database and
 * one open claim each.
 *
 * Key behaviors:
 * - The private document and two accounts' workspaces open at once, into their
 *   own databases, seeing none of each other's rows
 * - A second open of one address is refused with AlreadyOpen, and another
 *   account's address is not that address
 * - Discarding one account's workspace deletes only that account's database
 * - Every address survives a close-and-reopen, which is the retention that
 *   makes the account scope necessary
 * - A workspace with no account id is refused, never addressed
 * - Both superseded storage shapes are deleted at open, never read
 *
 * Runs under bun with `fake-indexeddb` supplying `indexedDB`; the durability
 * evidence in `evidence/browser/durable-store.ts` proves the same store in a
 * real Chromium across a real reload.
 */
import 'fake-indexeddb/auto';
import { describe, expect, test } from 'bun:test';
import { asPrincipalId } from '@epicenter/identity';
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

const ALICE = asPrincipalId('alice');
const BOB = asPrincipalId('bob');

const privateAddress = (namespace: string) => `epicenter/${namespace}/private`;
const workspaceAddress = (namespace: string, principalId: string) =>
	`epicenter/${namespace}/workspace/${principalId}`;

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

describe('one private document and one workspace replica per account', () => {
	test('the private document and two accounts open at once, into their own databases', async () => {
		const lens = lensFor('pair');
		const priv = expectOk(await open(lens, { document: 'private' }));
		const alice = expectOk(
			await open(lens, { document: 'workspace', principalId: ALICE }),
		);
		const bob = expectOk(
			await open(lens, { document: 'workspace', principalId: BOB }),
		);

		expectOk(priv.tables.notes.create({ title: 'mine alone' }));
		expectOk(alice.tables.notes.create({ title: "alice's" }));
		expectOk(bob.tables.notes.create({ title: "bob's" }));
		expect(titles(priv)).toEqual(['mine alone']);
		expect(titles(alice)).toEqual(["alice's"]);
		expect(titles(bob)).toEqual(["bob's"]);

		const names = await databaseNames();
		expect(names).toContain(privateAddress(lens.namespace));
		expect(names).toContain(workspaceAddress(lens.namespace, ALICE));
		expect(names).toContain(workspaceAddress(lens.namespace, BOB));

		await priv[Symbol.asyncDispose]();
		await alice[Symbol.asyncDispose]();
		await bob[Symbol.asyncDispose]();
	});

	test('a second open of one address is refused, and another account is not that address', async () => {
		const lens = lensFor('claim');
		const alice = expectOk(
			await open(lens, { document: 'workspace', principalId: ALICE }),
		);
		const again = expectErr(
			await open(lens, { document: 'workspace', principalId: ALICE }),
		);
		expect(again.name).toBe('AlreadyOpen');

		// Another account's replica is a different document, so it opens.
		const bob = expectOk(
			await open(lens, { document: 'workspace', principalId: BOB }),
		);
		await bob[Symbol.asyncDispose]();
		await alice[Symbol.asyncDispose]();

		// Disposal releases the claim, so the same address opens again.
		const reopened = expectOk(
			await open(lens, { document: 'workspace', principalId: ALICE }),
		);
		await reopened[Symbol.asyncDispose]();
	});

	test('every address survives a close-and-reopen under its own name', async () => {
		const lens = lensFor('reopen');
		for (const [target, title] of [
			[{ document: 'private' }, 'kept private'],
			[{ document: 'workspace', principalId: ALICE }, "kept alice's"],
			[{ document: 'workspace', principalId: BOB }, "kept bob's"],
		] as const) {
			const opened = expectOk(await open(lens, target));
			expectOk(opened.tables.notes.create({ title }));
			await opened[Symbol.asyncDispose]();
		}

		// Retention is the whole reason the account is in the address: coming
		// back to an account finds that account's replica, not the last one to
		// have been open.
		const priv = expectOk(await open(lens, { document: 'private' }));
		const alice = expectOk(
			await open(lens, { document: 'workspace', principalId: ALICE }),
		);
		const bob = expectOk(
			await open(lens, { document: 'workspace', principalId: BOB }),
		);
		expect(titles(priv)).toEqual(['kept private']);
		expect(titles(alice)).toEqual(["kept alice's"]);
		expect(titles(bob)).toEqual(["kept bob's"]);
		await priv[Symbol.asyncDispose]();
		await alice[Symbol.asyncDispose]();
		await bob[Symbol.asyncDispose]();
	});

	test('discarding one account workspace deletes only that account database', async () => {
		const lens = lensFor('discard');
		{
			const priv = expectOk(await open(lens, { document: 'private' }));
			expectOk(priv.tables.notes.create({ title: 'private work' }));
			await priv[Symbol.asyncDispose]();

			const bob = expectOk(
				await open(lens, { document: 'workspace', principalId: BOB }),
			);
			expectOk(bob.tables.notes.create({ title: "bob's work" }));
			await bob[Symbol.asyncDispose]();
		}

		const alice = expectOk(
			await open(lens, { document: 'workspace', principalId: ALICE }),
		);
		expectOk(alice.tables.notes.create({ title: 'doomed replica' }));
		expectOk(await alice.store.discard());

		const names = await databaseNames();
		expect(names).not.toContain(workspaceAddress(lens.namespace, ALICE));
		expect(names).toContain(workspaceAddress(lens.namespace, BOB));
		expect(names).toContain(privateAddress(lens.namespace));

		// Alice rejoins at zero; nobody else moved.
		const rejoined = expectOk(
			await open(lens, { document: 'workspace', principalId: ALICE }),
		);
		expect(titles(rejoined)).toEqual([]);
		await rejoined[Symbol.asyncDispose]();
		const bob = expectOk(
			await open(lens, { document: 'workspace', principalId: BOB }),
		);
		expect(titles(bob)).toEqual(["bob's work"]);
		await bob[Symbol.asyncDispose]();
		const priv = expectOk(await open(lens, { document: 'private' }));
		expect(titles(priv)).toEqual(['private work']);
		await priv[Symbol.asyncDispose]();
	});

	test('a workspace with no account id is refused, and no database is made for it', async () => {
		const lens = lensFor('unaddressable');
		const before = await databaseNames();

		const refused = expectErr(
			await open(lens, {
				document: 'workspace',
				principalId: asPrincipalId('   '),
			}),
		);
		expect(refused.name).toBe('Unaddressable');
		expect(await databaseNames()).toEqual(before);

		// And the refusal held no claim, so a real account still opens.
		const alice = expectOk(
			await open(lens, { document: 'workspace', principalId: ALICE }),
		);
		await alice[Symbol.asyncDispose]();
	});
});

describe('the clean break: storage from before the account-scoped address', () => {
	/** Fabricate one superseded database with something inside it. */
	function seedSupersededDatabase(name: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const request = indexedDB.open(name, 1);
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

	function supersededNames(namespace: string): string[] {
		return [
			`epicenter-store-${namespace}`,
			`epicenter-store-${namespace}#private`,
			`epicenter-store-${namespace}#workspace`,
		];
	}

	test('opening any document deletes both superseded shapes and reads nothing from them', async () => {
		const lens = lensFor('superseded');
		for (const name of supersededNames(lens.namespace)) {
			await seedSupersededDatabase(name);
		}
		expect(await databaseNames()).toEqual(
			expect.arrayContaining(supersededNames(lens.namespace)),
		);

		const priv = expectOk(await open(lens, { document: 'private' }));
		expect(titles(priv)).toEqual([]);
		for (const name of supersededNames(lens.namespace)) {
			expect(await databaseNames()).not.toContain(name);
		}
		await priv[Symbol.asyncDispose]();

		// The deletion repeats at every open, so a superseded database
		// reappearing (an old tab writing after this one deleted) dies at the
		// next boot too.
		for (const name of supersededNames(lens.namespace)) {
			await seedSupersededDatabase(name);
		}
		const alice = expectOk(
			await open(lens, { document: 'workspace', principalId: ALICE }),
		);
		expect(titles(alice)).toEqual([]);
		for (const name of supersededNames(lens.namespace)) {
			expect(await databaseNames()).not.toContain(name);
		}
		await alice[Symbol.asyncDispose]();
	});
});
