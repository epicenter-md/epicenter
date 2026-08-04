/**
 * Typed Data API Tests
 *
 * Verifies inert definitions, Lens binding, classified scalar traversal,
 * committed observation, and local row-document persistence over Bun SQLite.
 *
 * Key behaviors:
 * - Invalid namespaces, invalid local names, and names colliding only by case
 *   fail when the Lens is declared, before any storage work
 * - Conforming rows and values round-trip while invalid stored data is classified
 * - Local and synchronized commits notify borrowed lenses
 * - Row documents persist locally and are revoked by row deletion through any
 *   lens, including one that never opened the document
 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';

import { field } from '@epicenter/field';
import {
	defineLens,
	defineTable,
	optional,
	serializeTableDefinition,
	type TableInvalidation,
} from '@epicenter/lens';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { Type } from 'typebox';
import { createLogger, type Logger, memorySink } from 'wellcrafted/logger';
import { expectErr, expectOk } from 'wellcrafted/testing';

import { openBunEpicenter } from './bun.js';
import {
	bindSerializedTable,
	createEpicenter,
	createTableReadMethods,
} from './epicenter.js';
import { openReplica } from './replica/index.js';

const TEST_NAMESPACE = 'so.epicenter.tests';
const REMOTE_ROW_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const REMOTE_ROW_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';

function rowAddress(rowId: string) {
	return {
		namespace: TEST_NAMESPACE,
		tableName: 'notes',
		rowId,
	} as const;
}

const notesDefinition = defineTable({
	fields: {
		title: field.string(),
		rank: field.integer(),
		note: optional(field.string()),
		label: optional(field.json(Type.Union([Type.String(), Type.Null()]))),
	},
});


function setup(log?: Logger) {
	const rawDatabase = new Database(':memory:');
	const database = createBunSqliteAdapter(rawDatabase);
	const replica = expectOk(openReplica({ database }));
	const epicenter = createEpicenter({ replica, database, log });
	return { rawDatabase, database, replica, epicenter };
}

test('definitions reject invalid lens coordinates and structural field names', () => {
	expect(() =>
		defineLens({
			namespace: 'test',
			tables: { notes: defineTable({ fields: { title: field.string() } }) },
		}),
	).toThrow("Invalid namespace 'test'");
	expect(() =>
		defineLens({
			namespace: TEST_NAMESPACE,
			tables: {
				'not-valid': defineTable({ fields: { title: field.string() } }),
			},
		}),
	).toThrow("Invalid table name 'not-valid'");
	expect(() =>
		defineLens({
			namespace: TEST_NAMESPACE,
			tables: {
				'settings..sound': defineTable({ fields: {} }),
			},
		}),
	).toThrow("Invalid table name 'settings..sound'");
	expect(() =>
		defineLens({
			namespace: TEST_NAMESPACE,
			tables: {
				Notes: defineTable({ fields: { title: field.string() } }),
				notes: defineTable({ fields: { title: field.string() } }),
			},
		}),
	).toThrow("Ambiguous table names 'Notes' and 'notes' differ only by case");
	expect(() =>
		defineTable({
			fields: {
				title: field.string(),
				Title: field.string(),
			},
		}),
	).toThrow("Ambiguous field names 'title' and 'Title' differ only by case");
	expect(() =>
		defineTable({
			// @ts-expect-error The runtime guard is exercised despite the type error.
			fields: { id: field.string() },
		}),
	).toThrow("structural 'id'");
});

test('Bun factory opens the public runtime over an in-memory path', async () => {
	await using epicenter = await openBunEpicenter({ path: ':memory:' });
	const notes = epicenter.bind(
		defineLens({
			namespace: TEST_NAMESPACE,
			tables: { notes: notesDefinition },
		}),
	).notes;
	const row = await notes.create({ title: 'factory', rank: 1 });
	expect(expectOk(await notes.get(row.id))).toEqual(row);
});

test('a table and value with the same local name do not collide', async () => {
	const { rawDatabase, epicenter } = setup();
	const bound = epicenter.bind(
		defineLens({
			namespace: TEST_NAMESPACE,
			tables: { notes: notesDefinition },
		}),
	);
	const row = await bound.notes.create({ title: 'row', rank: 1 });
	expect(expectOk(await bound.notes.get(row.id))).toEqual(row);
	await epicenter[Symbol.asyncDispose]();
	rawDatabase.close();
});

test('table CRUD lowers undefined and scan returns stable row-ID order', async () => {
	const { rawDatabase, epicenter } = setup();
	const notes = epicenter.bind(
		defineLens({
			namespace: TEST_NAMESPACE,
			tables: { notes: notesDefinition },
		}),
	).notes;
	const localNotifications: TableInvalidation[] = [];
	const unsubscribe = notes.subscribe((invalidation) =>
		localNotifications.push(invalidation),
	);
	const first = await notes.create({
		title: 'first',
		rank: 1,
		note: undefined,
	});
	const second = await notes.create({ title: 'second', rank: 1 });
	const third = await notes.create({ title: 'third', rank: 2, note: 'remove' });

	expect(first.id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
	expect(expectOk(await notes.get(first.id))).toEqual({
		id: first.id,
		title: 'first',
		rank: 1,
	});
	expect(expectOk(await notes.patch(third.id, { note: undefined }))).toEqual({
		id: third.id,
		title: 'third',
		rank: 2,
	});
	expect(
		expectOk(await notes.patch('zzzzzzzzzzzzzzzzzzzzzzzz', { rank: 3 })),
	).toBeUndefined();

	const nullLabel = await notes.create({
		title: 'null label',
		rank: 3,
		label: null,
	});
	const scanned = await notes.scan();
	expect(scanned.nonconforming).toEqual([]);
	expect(scanned.rows.map(({ id }) => id)).toEqual(
		[first.id, second.id, third.id, nullLabel.id].sort(),
	);

	expect(await notes.delete(first.id)).toBe(true);
	expect(await notes.delete(first.id)).toBe(false);
	expect(expectOk(await notes.get(first.id))).toBeUndefined();
	expect(localNotifications).toEqual([
		{ scope: 'rows', rowIds: [first.id] },
		{ scope: 'rows', rowIds: [second.id] },
		{ scope: 'rows', rowIds: [third.id] },
		{ scope: 'rows', rowIds: [third.id] },
		{ scope: 'rows', rowIds: [nullLabel.id] },
		{ scope: 'rows', rowIds: [first.id] },
	]);
	unsubscribe();
	await epicenter[Symbol.asyncDispose]();
	rawDatabase.close();
});

test('create at a supplied id is exact and terminal after deletion', async () => {
	const { rawDatabase, epicenter } = setup();
	const notes = epicenter.bind(
		defineLens({
			namespace: TEST_NAMESPACE,
			tables: { notes: notesDefinition },
		}),
	).notes;

	const row = await notes.create('app', { title: 'chosen', rank: 1 });
	expect(row.id).toBe('app');
	await expect(notes.create('app', { title: 'duplicate', rank: 2 })).rejects.toThrow();
	expect(await notes.delete('app')).toBe(true);
	await expect(notes.create('app', { title: 'resurrect', rank: 3 })).rejects.toThrow();
	await expect(notes.create('not valid', { title: 'bad', rank: 4 })).rejects.toThrow(
		"Invalid row id 'not valid'",
	);

	await epicenter[Symbol.asyncDispose]();
	rawDatabase.close();
});

test('row ids accept minted, foreign-shaped, and case-distinct names and reject malformed names', async () => {
	const { rawDatabase, epicenter } = setup();
	const notes = epicenter.bind(
		defineLens({
			namespace: TEST_NAMESPACE,
			tables: { notes: notesDefinition },
		}),
	).notes;
	const minted = await notes.create({ title: 'minted', rank: 1 });
	const ids = ['app', '1a2b3c.4d5e', 'App'];
	const chosen = await Promise.all(
		ids.map((id, index) => notes.create(id, { title: id, rank: index + 2 })),
	);
	expect(new Set([minted.id, ...chosen.map(({ id }) => id)]).size).toBe(4);
	for (const id of ['', '.', '-', '_', 'a'.repeat(129)]) {
		await expect(notes.create(id, { title: 'bad', rank: 9 })).rejects.toThrow();
	}

	await epicenter[Symbol.asyncDispose]();
	rawDatabase.close();
});

	test('stored nonconforming rows are reported without repair', async () => {
	const { rawDatabase, replica, epicenter } = setup();
	expectOk(
		replica.write({
			verb: 'patch',
			address: rowAddress(REMOTE_ROW_A),
			set: { title: 42, rank: 1 },
			unset: [],
		}),
	);
	const bound = epicenter.bind(
		defineLens({
			namespace: TEST_NAMESPACE,
			tables: { notes: notesDefinition },
		}),
	);

	const rowError = expectErr(await bound.notes.get(REMOTE_ROW_A));
	expect(rowError.name).toBe('NonconformingRow');
	expect(rowError).toMatchObject({
		id: REMOTE_ROW_A,
		issues: [{ field: 'title', kind: 'invalid' }],
	});
	const scanned = await bound.notes.scan();
	expect(scanned.rows).toEqual([]);
	expect(scanned.nonconforming).toHaveLength(1);
	const entries = [];
	for await (const entry of bound.notes.entries()) entries.push(entry);
	expect(entries).toHaveLength(1);
	const [entry] = entries;
	if (entry === undefined) throw new Error('Expected one table entry');
	expect(expectErr(entry)).toMatchObject({ id: REMOTE_ROW_A });
	expect(expectOk(replica.readRow(rowAddress(REMOTE_ROW_A)))).toEqual({
		title: 42,
		rank: 1,
	});

	await epicenter[Symbol.asyncDispose]();
	rawDatabase.close();
});

test('entries streams every classified row across internal batches', async () => {
	const { rawDatabase, replica, epicenter } = setup();
	const notes = epicenter.bind(
		defineLens({
			namespace: TEST_NAMESPACE,
			tables: { notes: notesDefinition },
		}),
	).notes;
	const ids = Array.from({ length: 105 }, (_, index) =>
		String(index).padStart(24, '0'),
	);
	for (const [rank, id] of ids.entries()) {
		expectOk(
			replica.write({
				verb: 'patch',
				address: rowAddress(id),
				set: { title: `Note ${rank}`, rank },
				unset: [],
			}),
		);
	}

	const streamed = [];
	for await (const entry of notes.entries()) streamed.push(expectOk(entry));
	expect(streamed.map(({ id }) => id)).toEqual(ids);

	await epicenter[Symbol.asyncDispose]();
	rawDatabase.close();
});

test('stopping entries early does not request another internal batch', async () => {
	let batchReads = 0;
	const methods = createTableReadMethods<typeof notesDefinition>(
		async (after) => {
			batchReads += 1;
			if (after !== undefined) throw new Error('Unexpected second batch');
			return {
				entries: [
					{
						data: { id: REMOTE_ROW_A, title: 'first', rank: 1 },
						error: null,
					},
				],
				nextAfter: REMOTE_ROW_A,
			};
		},
	);

	const iterator = methods.entries()[Symbol.asyncIterator]();
	expect((await iterator.next()).done).toBe(false);
	await iterator.return?.();
	expect(batchReads).toBe(1);
});

test('the current keyset batcher observes inserts ahead of its row-ID boundary, not behind it', async () => {
	// Adapter-mechanism coverage only: neither the batch size nor concurrent
	// insertion visibility is part of the public traversal contract.
	const { rawDatabase, replica, epicenter } = setup();
	const notes = epicenter.bind(
		defineLens({
			namespace: TEST_NAMESPACE,
			tables: { notes: notesDefinition },
		}),
	).notes;
	const initialIds = Array.from({ length: 101 }, (_, index) =>
		String(index + 100).padStart(24, '0'),
	);
	for (const [rank, id] of initialIds.entries()) {
		expectOk(
			replica.write({
				verb: 'patch',
				address: rowAddress(id),
				set: { title: `Initial ${rank}`, rank },
				unset: [],
			}),
		);
	}

	const iterator = notes.entries()[Symbol.asyncIterator]();
	const firstBatch = [];
	for (let index = 0; index < 100; index += 1) {
		const next = await iterator.next();
		if (next.done) throw new Error('Traversal ended before the batch boundary');
		firstBatch.push(expectOk(next.value));
	}

	const behindBoundary = '000000000000000000000050';
	const aheadOfBoundary = '000000000000000000000300';
	for (const [rowId, title] of [
		[behindBoundary, 'Behind'],
		[aheadOfBoundary, 'Ahead'],
	] as const) {
		expectOk(
			replica.write({
				verb: 'patch',
				address: rowAddress(rowId),
				set: { title, rank: 300 },
				unset: [],
			}),
		);
	}

	const remainder = [];
	while (true) {
		const next = await iterator.next();
		if (next.done) break;
		remainder.push(expectOk(next.value));
	}
	const lastInitialId = initialIds.at(-1);
	if (lastInitialId === undefined) throw new Error('Expected initial rows');

	expect(firstBatch.map(({ id }) => id)).toEqual(initialIds.slice(0, 100));
	expect(remainder.map(({ id }) => id)).toEqual([
		lastInitialId,
		aheadOfBoundary,
	]);

	await epicenter[Symbol.asyncDispose]();
	rawDatabase.close();
});


test('throwing subscribers are logged without changing committed write results', async () => {
	const { sink, events } = memorySink();
	const { rawDatabase, epicenter } = setup(createLogger('test/data', sink));
	const notes = epicenter.bind(
		defineLens({
			namespace: TEST_NAMESPACE,
			tables: { notes: notesDefinition },
		}),
	).notes;
	let laterSubscriberCalls = 0;
	notes.subscribe(() => {
		throw new Error('subscriber failed');
	});
	notes.subscribe(() => {
		laterSubscriberCalls += 1;
	});

	const row = await notes.create({ title: 'committed', rank: 1 });
	expect(expectOk(await notes.get(row.id))).toEqual(row);
	expect(laterSubscriberCalls).toBe(1);
	expect(events).toHaveLength(1);
	expect(events[0]).toMatchObject({ level: 'error', source: 'test/data' });

	await epicenter[Symbol.asyncDispose]();
	rawDatabase.close();
});

test('subscriptions fire once per installed synchronized transaction', async () => {
	const { rawDatabase, epicenter } = setup();
	const bound = epicenter.bind(
		defineLens({
			namespace: TEST_NAMESPACE,
			tables: { notes: notesDefinition },
		}),
	);
	const rowNotifications: TableInvalidation[] = [];
	bound.notes.subscribe((invalidation) =>
		rowNotifications.push(invalidation),
	);

	expectOk(
		await epicenter.attachSync({
			deploymentId: 'https://example.com/',
			principalId: 'principal-a',
			exchange: () => ({
				through: 2,
				facts: [
					{
						presence: 'present',
						address: rowAddress(REMOTE_ROW_A),
						authoritySequence: 1,
						fields: { title: 'A', rank: 1 },
					},
					{
						presence: 'present',
						address: rowAddress(REMOTE_ROW_B),
						authoritySequence: 2,
						fields: { title: 'B', rank: 2 },
					},
				],
				next: null,
			}),
		}),
	);
	// One batched authority install, one invalidation carrying both ids: law 3
	// is what stops a sixty-four row exchange from becoming sixty-four scans.
	expect(rowNotifications).toEqual([
		{ scope: 'rows', rowIds: [REMOTE_ROW_A, REMOTE_ROW_B] },
	]);

	await epicenter[Symbol.asyncDispose]();
	rawDatabase.close();
});

test('row documents persist across opens and deletion revokes live handles', async () => {
	const { rawDatabase, database, epicenter } = setup();
	const notes = epicenter.bind(
		defineLens({
			namespace: TEST_NAMESPACE,
			tables: { notes: notesDefinition },
		}),
	).notes;
	const row = await notes.create({ title: 'document', rank: 1 });
	const first = await notes.openDocument(row.id);
	first.get('content').insert(0, 'persisted');
	await first.whenDurable();
	await first[Symbol.asyncDispose]();

	const reopened = await notes.openDocument(row.id);
	expect(reopened.get('content').toString()).toBe('persisted');
	expect(
		database.all<{ count: number }>(
			`SELECT COUNT(*) AS count FROM document_updates
			 WHERE namespace = ? AND table_name = ? AND row_id = ?`,
			[TEST_NAMESPACE, 'notes', row.id],
		)[0]?.count,
	).toBe(1);
	expect(await notes.delete(row.id)).toBe(true);
	expect(() => reopened.get('content')).toThrow('no longer live');
	expect(
		database.all<{ count: number }>(
			`SELECT COUNT(*) AS count FROM document_updates
			 WHERE namespace = ? AND table_name = ? AND row_id = ?`,
			[TEST_NAMESPACE, 'notes', row.id],
		)[0]?.count,
	).toBe(0);
	await reopened[Symbol.asyncDispose]();
	await expect(notes.openDocument(row.id)).rejects.toThrow('absent row');

	await epicenter[Symbol.asyncDispose]();
	rawDatabase.close();
});

test('deletion through an independently authored lens removes document bytes and revokes the other lens', async () => {
	const { rawDatabase, database, epicenter } = setup();
	const authorA = defineTable({
		fields: { title: field.string(), rank: field.integer() },
	});
	const authorB = defineTable({
		fields: { title: field.string() },
	});
	const lensA = epicenter.bind(
		defineLens({
			namespace: TEST_NAMESPACE,
			tables: { notes: authorA },
		}),
	).notes;
	const lensB = epicenter.bind(
		defineLens({
			namespace: TEST_NAMESPACE,
			tables: { notes: authorB },
		}),
	).notes;

	const row = await lensA.create({ title: 'shared', rank: 1 });
	const document = await lensA.openDocument(row.id);
	document.get('content').insert(0, 'cross-lens');
	await document.whenDurable();

	expect(await lensB.delete(row.id)).toBe(true);
	expect(() => document.get('content')).toThrow('no longer live');
	expect(
		database.all<{ count: number }>(
			`SELECT COUNT(*) AS count FROM document_updates
			 WHERE namespace = ? AND table_name = ? AND row_id = ?`,
			[TEST_NAMESPACE, 'notes', row.id],
		)[0]?.count,
	).toBe(0);
	await expect(lensB.openDocument(row.id)).rejects.toThrow('absent row');
	await document[Symbol.asyncDispose]();
	await epicenter[Symbol.asyncDispose]();
	rawDatabase.close();
});

test('installed synchronized deletion removes document bytes and revokes handles', async () => {
	const { rawDatabase, database, epicenter } = setup();
	const notes = epicenter.bind(
		defineLens({
			namespace: TEST_NAMESPACE,
			tables: { notes: notesDefinition },
		}),
	).notes;
	const session = {
		deploymentId: 'https://example.com/',
		principalId: 'principal-a',
	};
	expectOk(
		await epicenter.attachSync({
			...session,
			// The local document edit below wakes an extra exchange cycle, so
			// the fixture honors the contract: it never re-serves a page the
			// replica already applied.
			exchange: (request) => ({
				through: 1,
				facts:
					request.after >= 1
						? []
						: [
								{
									presence: 'present',
									address: rowAddress(REMOTE_ROW_A),
									authoritySequence: 1,
									fields: { title: 'remote document', rank: 1 },
								},
							],
				next: null,
			}),
		}),
	);
	const document = await notes.openDocument(REMOTE_ROW_A);
	document.get('content').insert(0, 'remove me');
	expectOk(
		await epicenter.attachSync({
			...session,
			exchange: (request) => ({
				through: 2,
				facts:
					request.after >= 2
						? []
						: [
								{
									presence: 'absent',
									address: rowAddress(REMOTE_ROW_A),
									authoritySequence: 2,
								},
							],
				next: null,
			}),
		}),
	);

	expect(() => document.get('content')).toThrow('no longer live');
	expect(
		database.all<{ count: number }>(
			`SELECT COUNT(*) AS count FROM document_updates
			 WHERE namespace = ? AND table_name = ? AND row_id = ?`,
			[TEST_NAMESPACE, 'notes', REMOTE_ROW_A],
		)[0]?.count,
	).toBe(0);
	await document[Symbol.asyncDispose]();
	await epicenter[Symbol.asyncDispose]();
	rawDatabase.close();
});

test('two borrowed lenses over one definition address the same stored state', async () => {
	const { rawDatabase, epicenter } = setup();
	const first = epicenter.bind(
		defineLens({
			namespace: TEST_NAMESPACE,
			tables: { notes: notesDefinition },
		}),
	);
	const second = epicenter.bind(
		defineLens({
			namespace: TEST_NAMESPACE,
			tables: { notes: notesDefinition },
		}),
	);
	const row = await first.notes.create({ title: 'shared', rank: 1 });

	expect(expectOk(await second.notes.get(row.id))).toEqual(row);

	await epicenter[Symbol.asyncDispose]();
	rawDatabase.close();
});

test('lenses with different namespaces isolate the same table name', async () => {
	const { rawDatabase, epicenter } = setup();
	const first = epicenter.bind(
		defineLens({
			namespace: 'so.epicenter.first',
			tables: { notes: notesDefinition },
		}),
	);
	const second = epicenter.bind(
		defineLens({
			namespace: 'so.epicenter.second',
			tables: { notes: notesDefinition },
		}),
	);
	const row = await first.notes.create({ title: 'isolated', rank: 1 });

	expect(expectOk(await first.notes.get(row.id))).toEqual(row);
	expect(expectOk(await second.notes.get(row.id))).toBeUndefined();

	await epicenter[Symbol.asyncDispose]();
	rawDatabase.close();
});

/**
 * The wire-named handle both RPC hosts route through.
 *
 * A chosen id is how every proxied surface reaches its singleton at boot, so a
 * host that cannot forward one cannot start an app. This exercises the seam
 * rather than either host, because the browser worker and the desktop owner
 * differ only in how the operation arrived.
 */
test('a serialized table creates at a chosen id and refuses a second one', async () => {
	const { rawDatabase, epicenter } = setup();
	const untyped = bindSerializedTable(
		epicenter,
		serializeTableDefinition(TEST_NAMESPACE, 'notes', notesDefinition),
	);

	expect(await untyped.create('app', { title: 'named', rank: 1 })).toEqual({
		id: 'app',
		title: 'named',
		rank: 1,
	});
	expect(await untyped.get('app')).toMatchObject({ data: { title: 'named' } });

	// The minted door still works, and still mints rather than reusing.
	const minted = (await untyped.create({ title: 'minted', rank: 2 })) as {
		id: string;
	};
	expect(minted.id).not.toBe('app');

	// create means create on this path too, so a live row is refused instead of
	// being merged into by the patch a create lowers to.
	await expect(
		untyped.create('app', { title: 'second', rank: 3 }),
	).rejects.toThrow('already exists');

	await epicenter[Symbol.asyncDispose]();
	rawDatabase.close();
});
