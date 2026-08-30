import { field } from '@epicenter/data/definition';
import * as Y from '@y/y';
/**
 * The optimistic persistence boundary (ADR-0238): acceptance is live and
 * cannot fail for storage reasons; durability is an ordered queue flushed
 * whole; sync sends only what is durable; restart recovers exactly the
 * durable prefix.
 *
 * These tests reach the SQLite file directly, like `sync.test.ts`, because
 * the properties under test are properties of the durable record's shape.
 */

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { defineData, defineTable, parseData } from '@epicenter/data/definition';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import type { Logger } from 'wellcrafted/logger';
import { Ok, type Result } from 'wellcrafted/result';

import { createSqliteDurablePort } from './log.js';
import { createPersistenceController, type DurableOp } from './persistence.js';
import {
	createAccountStoreOverPort,
	type DataView,
	syncEngineOf,
} from './store.js';

/** Wrap one application-document update the way the wire carries it. */

const database = defineData({
	id: 'so.epicenter.honeycrisp',
	kv: { theme: field.select(['light', 'dark']) },
	tables: {
		notes: defineTable({
			fields: { title: field.string(), editor: field.type() },
			file: {
				serialize: (row) => ({
					data: { title: row.title },
					content: row.editor.toString(),
				}),
				deserialize: (file) => {
					const editor = new Y.Type();
					if (file.content !== '') editor.insert(0, [file.content]);
					return Ok({ editor, title: String(file.data.title ?? '') });
				},
			},
		}),
	},
});

/** The parsed form the over-port constructors take (ADR-0240). */
function parsed() {
	const { data, error } = parseData(database);
	if (error !== null) throw new Error(error.message);
	return data;
}

/** Failed flushes are the subject here, not noise worth printing. */
const silent: Logger = {
	error: () => undefined,
	warn: () => undefined,
	info: () => undefined,
	debug: () => undefined,
	trace: () => undefined,
};

function expectOk<TValue, TError>(
	result: Result<TValue, TError> | TValue,
): TValue {
	if (
		typeof result === 'object' &&
		result !== null &&
		'data' in result &&
		'error' in result
	) {
		const outcome = result as Result<TValue, TError>;
		if (outcome.error !== null) throw outcome.error;
		return outcome.data as TValue;
	}
	return result as TValue;
}

/**
 * A real SQLite durable engine behind a gate that can refuse whole batches,
 * which is exactly the failure shape the port contract promises: all or
 * nothing.
 */
function openFailable() {
	const raw = new Database(':memory:');
	const sqlite = createBunSqliteAdapter(raw);
	const inner = createSqliteDurablePort({ sqlite, syncs: true });
	const gate = { failing: false };
	/** Every batch the engine accepted, for tests that pin op ordering. */
	const batches: DurableOp[][] = [];
	const { store, view } = createAccountStoreOverPort({
		definition: parsed(),
		durable: {
			commit(ops) {
				if (gate.failing) throw new Error('durable storage refused');
				inner.commit(ops);
				batches.push([...ops]);
			},
		},
		loaded: inner.load(),
		log: silent,
	});
	return {
		store,
		db: view as unknown as DataView<typeof database>,
		sqlite,
		gate,
		batches,
		durableUpdateCount: () =>
			sqlite.all<{ count: number }>('SELECT COUNT(*) AS count FROM _updates')[0]
				?.count ?? 0,
		durableOutboxIds: () =>
			sqlite
				.all<{ id: number }>(
					'SELECT id FROM _updates WHERE authoritySeq IS NULL ORDER BY id',
				)
				.map((row) => row.id),
		durableCursor: () =>
			sqlite.all<{ seq: number | null }>(
				'SELECT MAX(authoritySeq) AS seq FROM _updates',
			)[0]?.seq ?? 0,
	};
}

/** Reopen over the same durable sqlite: the restart. */
function reopen(sqlite: ReturnType<typeof createBunSqliteAdapter>) {
	const port = createSqliteDurablePort({ sqlite, syncs: true });
	const { store, view } = createAccountStoreOverPort({
		definition: parsed(),
		durable: port,
		loaded: port.load(),
		log: silent,
	});
	return { store, db: view as unknown as DataView<typeof database> };
}

function titles(db: ReturnType<typeof openFailable>['db']): string[] {
	return db.tables.notes.rows.map((row) => row.title as string).sort();
}

describe('acceptance is live, durability is a visible debt', () => {
	test('a blocked store keeps accepting, and reads follow immediately', () => {
		const replica = openFailable();
		replica.gate.failing = true;

		expectOk(replica.db.tables.notes.create({ title: 'first' }));
		expectOk(replica.db.tables.notes.create({ title: 'second' }));

		expect(titles(replica.db)).toEqual(['first', 'second']);
		expect(replica.store.persistence.get()).toBe('blocked');
		// Nothing reached the durable engine.
		expect(replica.durableUpdateCount()).toBe(0);
		expect(replica.durableOutboxIds()).toEqual([]);
	});

	test('a later edit retries, and the retained work lands in order, once', () => {
		const replica = openFailable();
		replica.gate.failing = true;
		expectOk(replica.db.tables.notes.create({ title: 'a' }));
		expectOk(replica.db.tables.notes.create({ title: 'b' }));
		expect(replica.store.persistence.get()).toBe('blocked');

		replica.gate.failing = false;
		// The next accepted edit is the retry trigger; no autonomous loop.
		expectOk(replica.db.tables.notes.create({ title: 'c' }));

		expect(replica.store.persistence.get()).toBe('saved');
		// Exactly one outbox entry per authored transaction, in order.
		expect(replica.durableOutboxIds()).toEqual([1, 2, 3]);
		// The durable log replays to the same three rows: nothing dropped,
		// nothing duplicated.
		const restarted = reopen(replica.sqlite);
		expect(titles(restarted.db)).toEqual(['a', 'b', 'c']);
	});

	test('an explicit flush() retries without needing another edit', async () => {
		const replica = openFailable();
		replica.gate.failing = true;
		expectOk(replica.db.tables.notes.create({ title: 'retained' }));
		expect(replica.store.persistence.get()).toBe('blocked');

		replica.gate.failing = false;
		await replica.store.persistence.flush();

		expect(replica.store.persistence.get()).toBe('saved');
		expect(replica.durableOutboxIds()).toEqual([1]);
	});

	test('closing while blocked loses only the in-memory work, deliberately', async () => {
		const replica = openFailable();
		expectOk(replica.db.tables.notes.create({ title: 'durable before' }));
		replica.gate.failing = true;
		expectOk(replica.db.tables.notes.create({ title: 'accepted only' }));
		expect(replica.store.persistence.get()).toBe('blocked');

		// Disposal attempts one final flush and then lets go; it never hangs on
		// a blocked engine.
		await replica.store[Symbol.asyncDispose]();

		const restarted = reopen(replica.sqlite);
		expect(titles(restarted.db)).toEqual(['durable before']);
		expect(restarted.store.persistence.get()).toBe('saved');
	});

	test('kv and type-field edits are accepted while blocked, like table writes', () => {
		const replica = openFailable();
		const made = expectOk(replica.db.tables.notes.create({ title: 'holder' }));
		replica.gate.failing = true;

		// KV: accepted live, visible at once.
		expectOk(replica.db.kv.update({ theme: 'dark' }));
		expect(expectOk(replica.db.kv.get()).theme).toBe('dark');

		// A row's type field: an editor keeps writing prose while blocked. The
		// type is live on the document the store already holds, so a blocked
		// engine never blocks acceptance.
		const editor = replica.db.tables.notes.get(made.id)?.editor;
		if (editor === undefined) throw new Error('the row has no editor');
		editor.applyDelta(editor.change.insert('typed while blocked') as never);
		expect(editor.toString()).toContain('typed while blocked');

		expect(replica.store.persistence.get()).toBe('blocked');
		// Nothing reached the durable engine; everything above is the debt.
		expect(replica.durableUpdateCount()).toBe(1);

		replica.gate.failing = false;
		expectOk(replica.db.tables.notes.create({ title: 'retry trigger' }));
		expect(replica.store.persistence.get()).toBe('saved');
		const restarted = reopen(replica.sqlite);
		expect(expectOk(restarted.db.kv.get()).theme).toBe('dark');
		const survived = restarted.db.tables.notes.get(made.id)?.editor;
		expect(survived?.toString()).toContain('typed while blocked');
	});

	test('the status is subscribable, and transitions fire once per change', () => {
		const replica = openFailable();
		const seen: string[] = [];
		replica.store.persistence.subscribe(() =>
			seen.push(replica.store.persistence.get()),
		);

		replica.gate.failing = true;
		expectOk(replica.db.tables.notes.create({ title: 'x' }));
		expect(seen).toEqual(['blocked']);

		replica.gate.failing = false;
		expectOk(replica.db.tables.notes.create({ title: 'y' }));
		expect(seen).toEqual(['blocked', 'saved']);
	});

	test('an asynchronous engine reports pending, and mid-flight edits coalesce in order', async () => {
		// The browser shape: the port commits on its own schedule, and the
		// store never waits for it. Reads follow acceptance.
		const raw = new Database(':memory:');
		const sqlite = createBunSqliteAdapter(raw);
		const inner = createSqliteDurablePort({ sqlite, syncs: true });
		const release: (() => void)[] = [];
		const { store, view } = createAccountStoreOverPort({
			definition: parsed(),
			durable: {
				commit(ops) {
					const batch = [...ops];
					return new Promise<void>((resolve) => {
						release.push(() => {
							inner.commit(batch);
							resolve();
						});
					});
				},
			},
			loaded: inner.load(),
			log: silent,
		});
		const db = view as unknown as DataView<typeof database>;

		expectOk(db.tables.notes.create({ title: 'a' }));
		expect(store.persistence.get()).toBe('pending');
		// Acceptance is not waiting on the flight: live reads already hold the
		// row.
		expect(db.tables.notes.rows.map((row) => row.title)).toEqual(['a']);

		// Two more accepted mid-flight; they must ride the NEXT batch together.
		expectOk(db.tables.notes.create({ title: 'b' }));
		expectOk(db.tables.notes.create({ title: 'c' }));

		const settled = store.persistence.flush();
		release.shift()?.();
		await new Promise((resolve) => setTimeout(resolve, 0));
		release.shift()?.();
		await settled;

		expect(store.persistence.get()).toBe('saved');
		// Exactly one durable outbox entry per authored transaction, in order:
		// nothing dropped, nothing reordered, nothing duplicated.
		expect(
			sqlite
				.all<{ id: number }>(
					'SELECT id FROM _updates WHERE authoritySeq IS NULL ORDER BY id',
				)
				.map((row) => row.id),
		).toEqual([1, 2, 3]);
		const restarted = reopen(sqlite);
		expect(titles(restarted.db)).toEqual(['a', 'b', 'c']);
	});
});

describe('sync reads only durable facts', () => {
	test('coalesce offers nothing while the appends are still in memory', () => {
		const replica = openFailable();
		replica.gate.failing = true;
		expectOk(replica.db.tables.notes.create({ title: 'not yet durable' }));

		// The live document holds the edit; the sender must not see it.
		expect(syncEngineOf(replica.store).coalesce()).toBeUndefined();

		replica.gate.failing = false;
		expectOk(replica.db.tables.notes.create({ title: 'now everything lands' }));
		const merged = syncEngineOf(replica.store).coalesce();
		expect(merged).toBeDefined();
		expect(merged?.id).toBe(2);
	});

	test('onLocalWork fires when the outbox durably grows, not at acceptance', () => {
		const replica = openFailable();
		let nudges = 0;
		syncEngineOf(replica.store).onLocalWork(() => {
			nudges += 1;
		});

		replica.gate.failing = true;
		expectOk(replica.db.tables.notes.create({ title: 'accepted' }));
		expect(nudges).toBe(0);

		replica.gate.failing = false;
		expectOk(replica.db.tables.notes.create({ title: 'flushed' }));
		expect(nudges).toBe(1);
	});

	test('a remote update is live at once, and its cursor lands with its bytes', async () => {
		const author = openFailable();
		expectOk(author.db.tables.notes.create({ title: 'from the authority' }));
		const update = author.store.encodeStateSince();

		const replica = openFailable();
		replica.gate.failing = true;
		expectOk(syncEngineOf(replica.store).applyRemote(update, { advanceTo: 7 }));

		// Live: the rows and the LIVE cursor both advanced.
		expect(titles(replica.db)).toEqual(['from the authority']);
		expect(syncEngineOf(replica.store).cursor()).toBe(7);
		// Durable: neither the bytes nor the bookmark, because they commit
		// together or not at all (ADR-0231 via ADR-0238's whole-queue flush).
		expect(replica.durableUpdateCount()).toBe(0);
		expect(replica.durableCursor()).toBe(0);

		replica.gate.failing = false;
		await replica.store.persistence.flush();
		expect(replica.durableCursor()).toBe(7);
		const restarted = reopen(replica.sqlite);
		expect(titles(restarted.db)).toEqual(['from the authority']);
		expect(syncEngineOf(restarted.store).cursor()).toBe(7);
	});

	test('an acknowledged entry is not re-offered while its drop is retained', async () => {
		const replica = openFailable();
		expectOk(replica.db.tables.notes.create({ title: 'sent' }));
		const sent = syncEngineOf(replica.store).coalesce();
		if (sent === undefined) throw new Error('nothing to send');

		replica.gate.failing = true;
		syncEngineOf(replica.store).acknowledge(sent.id, 1);

		// The durable outbox still holds the entry (the drop is queued behind a
		// blocked flush), but the session overlay keeps it from being offered
		// twice.
		expect(syncEngineOf(replica.store).coalesce()).toBeUndefined();
		expect(replica.durableOutboxIds()).toEqual([sent.id]);

		replica.gate.failing = false;
		await replica.store.persistence.flush();
		expect(replica.durableOutboxIds()).toEqual([]);
	});

	test('a remote update lost with a blocked close is simply re-received', async () => {
		const author = openFailable();
		expectOk(author.db.tables.notes.create({ title: 'from the authority' }));
		const update = author.store.encodeStateSince();

		const replica = openFailable();
		replica.gate.failing = true;
		expectOk(syncEngineOf(replica.store).applyRemote(update, { advanceTo: 1 }));
		expect(titles(replica.db)).toEqual(['from the authority']);
		await replica.store[Symbol.asyncDispose]();

		// The restart honestly recovers only the durable prefix: no row, and a
		// cursor that never advanced, so the authority re-serves from zero.
		const restarted = reopen(replica.sqlite);
		expect(titles(restarted.db)).toEqual([]);
		expect(syncEngineOf(restarted.store).cursor()).toBe(0);

		// Re-receiving the same bytes is the designed recovery, and it is safe
		// because an update is idempotent.
		expectOk(
			syncEngineOf(restarted.store).applyRemote(update, { advanceTo: 1 }),
		);
		expect(titles(restarted.db)).toEqual(['from the authority']);
		expect(syncEngineOf(restarted.store).cursor()).toBe(1);
	});

	test('an acknowledgement drops only the work it names; queued work lands intact', async () => {
		const replica = openFailable();
		expectOk(replica.db.tables.notes.create({ title: 'sent' }));
		const sent = syncEngineOf(replica.store).coalesce();
		if (sent === undefined) throw new Error('nothing to send');

		replica.gate.failing = true;
		expectOk(
			replica.db.tables.notes.create({ title: 'authored while blocked' }),
		);
		syncEngineOf(replica.store).acknowledge(sent.id, 1);

		replica.gate.failing = false;
		await replica.store.persistence.flush();

		// One batch carried the retained append and the drop; the drop removed
		// only the entry the authority confirmed, never the newer work.
		expect(replica.durableOutboxIds()).toEqual([2]);
		const restarted = reopen(replica.sqlite);
		expect(titles(restarted.db)).toEqual(['authored while blocked', 'sent']);
	});
});

describe('the controller against an asynchronous engine', () => {
	function createManualPort() {
		const batches: DurableOp[][] = [];
		const waiting: { resolve: () => void; reject: (cause: unknown) => void }[] =
			[];
		return {
			batches,
			commit(ops: readonly DurableOp[]): Promise<void> {
				batches.push([...ops]);
				return new Promise((resolve, reject) => {
					waiting.push({ resolve, reject });
				});
			},
			readDocument: (): Uint8Array[] => [],
			listDocuments: (): string[] => [],
			settle(outcome: 'ok' | 'fail'): Promise<void> {
				const next = waiting.shift();
				if (next === undefined) throw new Error('no batch in flight');
				if (outcome === 'ok') next.resolve();
				else next.reject(new Error('async engine refused'));
				// Let the controller's continuation run.
				return new Promise((resolve) => setTimeout(resolve, 0));
			},
		};
	}

	const append = (id: number): DurableOp => ({
		kind: 'append',
		id,
		bytes: new Uint8Array([id]),
		authoritySeq: undefined,
	});

	test('ops accepted mid-flight coalesce into the next batch', async () => {
		const port = createManualPort();
		const controller = createPersistenceController({
			port,
			loaded: {
				updates: [],
				outbox: [],
				cursor: 0,
				lastId: 0,
			},
			log: silent,
		});

		controller.enqueue([append(1)]);
		expect(controller.persistence.get()).toBe('pending');
		controller.enqueue([append(2)]);
		controller.enqueue([append(3)]);

		await port.settle('ok');
		// The two accepted mid-flight went out together, in order.
		await port.settle('ok');
		expect(port.batches).toHaveLength(2);
		expect(port.batches[0]?.map((op) => op.kind)).toEqual(['append']);
		expect(
			port.batches[1]?.map((op) => (op.kind === 'append' ? op.id : 0)),
		).toEqual([2, 3]);
		expect(controller.persistence.get()).toBe('saved');
	});

	test('a rejected batch is retained whole, ahead of later work', async () => {
		const port = createManualPort();
		const controller = createPersistenceController({
			port,
			loaded: {
				updates: [],
				outbox: [],
				cursor: 0,
				lastId: 0,
			},
			log: silent,
		});

		controller.enqueue([append(1), append(2)]);
		await port.settle('fail');
		expect(controller.persistence.get()).toBe('blocked');

		controller.enqueue([append(3)]);
		await port.settle('ok');
		expect(controller.persistence.get()).toBe('saved');
		// One retry batch carrying everything, in the original order.
		expect(
			port.batches[1]?.map((op) => (op.kind === 'append' ? op.id : 0)),
		).toEqual([1, 2, 3]);
	});
});
