/**
 * One suite, both `DurablePort` implementations, identical batches.
 *
 * There are two hand-written implementations of one port: `log.ts` over SQL,
 * and `browser.ts` over IndexedDB. Until this file existed they were tested
 * separately, each against its own expectations, so both stayed green while
 * they disagreed. Every test here drives BOTH through the same
 * `DurableOp[]` and asserts the same observable result, which is the only
 * thing that can hold two implementations of one contract together.
 *
 * What "observable" means here is deliberately narrow: what a reopen loads,
 * and what `readDocument`/`listDocuments` answer. Row counts and storage
 * layout are not the contract; two ports may fold at different moments and
 * still be correct, so the fold test asserts REPLAYED STATE rather than
 * shape, and records the layout difference as evidence rather than failing on
 * it.
 *
 * A case that fails on only one side is not automatically that side's bug.
 * It is a question about which behavior the contract intends, and the answer
 * belongs in this file's expectations once it is decided.
 */
import 'fake-indexeddb/auto';
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import * as Y from '@y/y';

import { openIdbBacking } from './browser.js';
import { readRow, tableRoot, writeRow } from './document.js';
import { APP_DOCUMENT, createSqliteDurablePort, replay } from './log.js';
import type { DurableOp, DurablePort, DurableSnapshot } from './persistence.js';

/**
 * One durable record a test can commit to, close, and open again.
 *
 * Reopening is the whole point: a port's job is what survives, so every
 * assertion here reads a FRESH open rather than the handle that did the
 * writing. In-memory state that happens to be right proves nothing.
 */
type Record = {
	commit(ops: readonly DurableOp[]): Promise<void>;
	reopen(): Promise<{ loaded: DurableSnapshot; port: DurablePort }>;
};

type Engine = { name: string; create(label: string): Promise<Record> };

const sqliteEngine: Engine = {
	name: 'sqlite',
	async create(): Promise<Record> {
		// One database for the record's life, reopened through a new port, which
		// is the same shape `memory.ts` uses to model a close and a reopen.
		const sqlite = createBunSqliteAdapter(new Database(':memory:'));
		const open = () => createSqliteDurablePort({ sqlite });
		return {
			commit: async (ops) => {
				await open().commit(ops);
			},
			reopen: async () => {
				const port = open();
				return { loaded: port.load(), port };
			},
		};
	},
};

const indexedDbEngine: Engine = {
	name: 'indexeddb',
	async create(label: string): Promise<Record> {
		const address = `conformance/${label}`;
		const open = async () => {
			const opened = await openIdbBacking(address);
			if (opened.error !== null) throw opened.error;
			return opened.data;
		};
		return {
			commit: async (ops) => {
				const backing = await open();
				await backing.port.commit(ops);
				backing.close();
			},
			reopen: async () => {
				const backing = await open();
				return { loaded: backing.loaded, port: backing.port };
			},
		};
	},
};

const ENGINES = [sqliteEngine, indexedDbEngine];

/** A distinct label per test, so IndexedDB's process-global store is not shared. */
let counter = 0;
beforeEach(() => {
	counter += 1;
});

/**
 * One update that sets a marker attribute, written the way the store itself
 * writes: a root by name, a row as an attribute on it (`document.ts`).
 *
 * Built as a delta from an empty baseline rather than a whole-state encode, so
 * a chain of these is a chain of small updates and the fold has something to
 * fold.
 */
function update(text: string): Uint8Array {
	const doc = new Y.Doc({ gc: true });
	const before = Y.encodeStateVector(doc);
	writeRow(tableRoot(doc, 'marks'), 'only', { value: text });
	const bytes = Y.encodeStateAsUpdateV2(doc, before);
	doc.destroy();
	return new Uint8Array(bytes);
}

/**
 * Successive deltas from ONE writer, so the last one genuinely wins.
 *
 * Not `update()` in a loop: each of those mints its own `Y.Doc` with its own
 * client id, so N of them are N CONCURRENT writes to one attribute and the
 * winner is decided by client id rather than by order. That is correct CRDT
 * behavior and useless for asserting "the newest value survived the fold".
 */
function chain(count: number): Uint8Array[] {
	const doc = new Y.Doc({ gc: true });
	const root = tableRoot(doc, 'marks');
	const updates: Uint8Array[] = [];
	let since = Y.encodeStateVector(doc);
	for (let index = 0; index < count; index += 1) {
		writeRow(root, 'only', { value: `v${index}` });
		updates.push(new Uint8Array(Y.encodeStateAsUpdateV2(doc, since)));
		since = Y.encodeStateVector(doc);
	}
	doc.destroy();
	return updates;
}

/** What a chain says once replayed, which is the only thing a caller can see. */
function valueOf(chain: readonly Uint8Array[]): unknown {
	const doc = replay(chain.map((bytes) => ({ bytes })) as never);
	const value = readRow(tableRoot(doc, 'marks'), 'only')?.value;
	doc.destroy();
	return value;
}

for (const engine of ENGINES) {
	describe(`DurablePort conformance: ${engine.name}`, () => {
		test('an append survives a reopen, and listDocuments names it', async () => {
			const record = await engine.create(`append-${counter}`);
			await record.commit([
				{
					kind: 'append',
					document: APP_DOCUMENT,
					bytes: update('one'),
					outboxId: undefined,
				},
			]);

			const { loaded, port } = await record.reopen();
			expect(valueOf(loaded.updates)).toBe('one');
			expect(await port.listDocuments()).toContain(APP_DOCUMENT);
		});

		test('the identity stamp is first-write-wins', async () => {
			const record = await engine.create(`identity-${counter}`);
			await record.commit([{ kind: 'identity', id: 'first' }]);
			await record.commit([{ kind: 'identity', id: 'second' }]);

			const { loaded } = await record.reopen();
			// `log.ts` states this in words above `writeDocumentIdentity`:
			// "First write wins: membership never changes in place, only by
			// discarding the file whole." A port that overwrites lets a replica
			// full of one account's bytes claim to be another's.
			expect(loaded.identity).toBe('first');
		});

		test('the cursor advances and survives a reopen', async () => {
			const record = await engine.create(`cursor-${counter}`);
			await record.commit([{ kind: 'cursor', seq: 7 }]);

			const { loaded } = await record.reopen();
			expect(loaded.cursor).toBe(7);
		});

		test('an outbox entry survives a reopen, and an ack drops only what it names', async () => {
			const record = await engine.create(`outbox-${counter}`);
			await record.commit([
				{ kind: 'append', document: APP_DOCUMENT, bytes: update('a'), outboxId: 1 },
				{ kind: 'append', document: APP_DOCUMENT, bytes: update('b'), outboxId: 2 },
			]);

			const afterWrite = await record.reopen();
			expect(afterWrite.loaded.outbox.map((entry) => entry.id)).toEqual([1, 2]);

			await record.commit([{ kind: 'dropOutbox', throughId: 1 }]);
			const afterAck = await record.reopen();
			expect(afterAck.loaded.outbox.map((entry) => entry.id)).toEqual([2]);
		});

		test('replaceOutbox collapses one document to a single entry at the covered id', async () => {
			const record = await engine.create(`coalesce-${counter}`);
			await record.commit([
				{ kind: 'append', document: APP_DOCUMENT, bytes: update('a'), outboxId: 1 },
				{ kind: 'append', document: 'row', bytes: update('other'), outboxId: 2 },
				{ kind: 'append', document: APP_DOCUMENT, bytes: update('b'), outboxId: 3 },
			]);
			await record.commit([
				{
					kind: 'replaceOutbox',
					document: APP_DOCUMENT,
					throughId: 3,
					merged: update('merged'),
				},
			]);

			const { loaded } = await record.reopen();
			// The other document's entry keeps its place; the covered ones
			// collapse to one entry at the highest id they covered.
			expect(loaded.outbox.map((entry) => [entry.id, entry.document])).toEqual([
				[2, 'row'],
				[3, APP_DOCUMENT],
			]);
		});

		test('retire tombstones the address and drops its chain and its entries', async () => {
			const record = await engine.create(`retire-${counter}`);
			await record.commit([
				{ kind: 'append', document: 'row', bytes: update('doomed'), outboxId: 1 },
				{ kind: 'append', document: APP_DOCUMENT, bytes: update('kept'), outboxId: 2 },
			]);
			await record.commit([{ kind: 'retire', document: 'row' }]);

			const { loaded, port } = await record.reopen();
			expect(loaded.tombstones).toEqual(['row']);
			expect(await port.readDocument('row')).toEqual([]);
			expect(await port.listDocuments()).not.toContain('row');
			// The retired address takes its owed bytes with it; everything else
			// keeps its place.
			expect(loaded.outbox.map((entry) => entry.id)).toEqual([2]);
			expect(valueOf(loaded.updates)).toBe('kept');
		});

		test('a folded chain replays to the same value, whatever shape it is stored in', async () => {
			const record = await engine.create(`fold-${counter}`);
			// Past the fold threshold in one batch, which is where the two ports
			// were measured to disagree: one folds mid-batch and keeps appending,
			// the other folds once at the end. Both are correct; only the
			// replayed value is the contract.
			const ops: DurableOp[] = chain(70).map((bytes) => ({
				kind: 'append' as const,
				document: APP_DOCUMENT,
				bytes,
				outboxId: undefined,
			}));
			await record.commit(ops);

			const { loaded, port } = await record.reopen();
			expect(valueOf(loaded.updates)).toBe('v69');
			// Evidence, not a contract: the stored layouts differ between ports.
			const stored = await port.readDocument(APP_DOCUMENT);
			expect(stored.length).toBeGreaterThan(0);
			expect(stored.length).toBeLessThanOrEqual(70);
		});

		test('a batch is all or nothing', async () => {
			const record = await engine.create(`atomic-${counter}`);
			await record.commit([
				{ kind: 'append', document: APP_DOCUMENT, bytes: update('a'), outboxId: 1 },
				{ kind: 'cursor', seq: 5 },
				{ kind: 'identity', id: 'doc' },
			]);

			const { loaded } = await record.reopen();
			// The cursor and the bytes it accounts for land together or not at
			// all. A durable state holding one without the other is what
			// ADR-0238's single flush batch exists to make unreachable.
			expect(loaded.cursor).toBe(5);
			expect(loaded.identity).toBe('doc');
			expect(loaded.outbox.map((entry) => entry.id)).toEqual([1]);
			expect(valueOf(loaded.updates)).toBe('a');
		});
	});
}
