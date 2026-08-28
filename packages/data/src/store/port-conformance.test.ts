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
import { installTestLocks } from './test-locks.js';

installTestLocks();
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

let nextId = 0;
const append = (
	document: string,
	text: string,
	authoritySeq?: number,
): DurableOp => {
	nextId += 1;
	return {
		kind: 'append',
		document,
		id: nextId,
		bytes: update(text),
		authoritySeq,
	};
};

for (const engine of ENGINES) {
	describe(`DurablePort conformance: ${engine.name}`, () => {
		test('an append survives a reopen, and listDocuments names it', async () => {
			const record = await engine.create(`append-${counter}`);
			await record.commit([append(APP_DOCUMENT, 'one')]);

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

		test('an append with no position is owed, and one with a position is not', async () => {
			const record = await engine.create(`owed-${counter}`);
			const owed = append(APP_DOCUMENT, 'mine');
			const received = append(APP_DOCUMENT, 'theirs', 9);
			await record.commit([owed, received]);

			const { loaded } = await record.reopen();
			// One column answers both questions. Owed is "the authority has no
			// position for this", and the cursor is the highest position any
			// append carries.
			expect(loaded.outbox.map((entry) => entry.id)).toEqual([owed.id]);
			expect(loaded.cursor).toBe(9);
		});

		test('an ack retires the work it names AND records where it landed', async () => {
			const record = await engine.create(`ack-${counter}`);
			const first = append(APP_DOCUMENT, 'a');
			const second = append(APP_DOCUMENT, 'b');
			await record.commit([first, second]);

			const afterWrite = await record.reopen();
			expect(afterWrite.loaded.outbox.map((entry) => entry.id)).toEqual([
				first.id,
				second.id,
			]);
			expect(afterWrite.loaded.cursor).toBe(0);

			await record.commit([
				{ kind: 'ack', throughId: first.id, authoritySeq: 4 },
			]);
			const afterAck = await record.reopen();
			// Both halves of one fact: the covered work stops being owed, and the
			// position it reached becomes the cursor.
			expect(afterAck.loaded.outbox.map((entry) => entry.id)).toEqual([
				second.id,
			]);
			expect(afterAck.loaded.cursor).toBe(4);
		});

		test('a repeated ack does not restamp work a later ack already took', async () => {
			const record = await engine.create(`reack-${counter}`);
			const only = append(APP_DOCUMENT, 'a');
			await record.commit([only]);
			await record.commit([{ kind: 'ack', throughId: only.id, authoritySeq: 3 }]);
			await record.commit([{ kind: 'ack', throughId: only.id, authoritySeq: 8 }]);

			const { loaded } = await record.reopen();
			expect(loaded.outbox).toEqual([]);
			// 3, not 8. A derived cursor can only report a position some bytes
			// actually carry, and the second ack covered nothing still owed, so
			// nothing took the 8. That is the honest behavior of deriving rather
			// than storing, and it fails in the safe direction: a cursor that
			// lags re-receives, and applying an update twice is free. A cursor
			// that ran ahead would skip entries forever.
			expect(loaded.cursor).toBe(3);
		});

		test('retire tombstones the address and drops its chain and its owed work', async () => {
			const record = await engine.create(`retire-${counter}`);
			const doomed = append('row', 'doomed');
			const kept = append(APP_DOCUMENT, 'kept');
			await record.commit([doomed, kept]);
			await record.commit([{ kind: 'retire', document: 'row' }]);

			const { loaded, port } = await record.reopen();
			expect(loaded.tombstones).toEqual(['row']);
			expect(await port.readDocument('row')).toEqual([]);
			expect(await port.listDocuments()).not.toContain('row');
			// The retired address takes its owed bytes with it, which is now one
			// deletion rather than a sweep of a second relation.
			expect(loaded.outbox.map((entry) => entry.id)).toEqual([kept.id]);
			expect(valueOf(loaded.updates)).toBe('kept');
		});

		test('a folded chain replays to the same value, and leaves owed work alone', async () => {
			const record = await engine.create(`fold-${counter}`);
			// Past the fold threshold, all acknowledged, so the whole prefix is
			// foldable. Then one owed append on top, which the fold must not
			// touch: it is a suffix by construction, because ids only go up.
			// One writer, so the last value genuinely wins. Building the owed
			// append from a fresh document instead would make it CONCURRENT with
			// the chain rather than after it, and the winner would be decided by
			// client id.
			const written = chain(71);
			const numbered = written.map((bytes, index) => {
				nextId += 1;
				return {
					kind: 'append' as const,
					document: APP_DOCUMENT,
					id: nextId,
					bytes,
					// Everything but the last is acknowledged, so the foldable
					// prefix is 70 and the owed suffix is 1.
					authoritySeq: index < 70 ? 1 : undefined,
				};
			});
			await record.commit(numbered.slice(0, 70));
			const owed = numbered[70] as DurableOp & { id: number };
			await record.commit([owed]);

			const { loaded, port } = await record.reopen();
			// Only the replayed state is the contract. The two ports may hold
			// different numbers of rows and both be right.
			expect(valueOf(loaded.updates)).toBe('v70');
			expect(loaded.outbox.map((entry) => entry.id)).toEqual([owed.id]);
			const stored = await port.readDocument(APP_DOCUMENT);
			// The point of the fold: fewer rows than were written.
			expect(stored.length).toBeLessThan(71);
		});

		test('a batch is all or nothing', async () => {
			const record = await engine.create(`atomic-${counter}`);
			const one = append(APP_DOCUMENT, 'a');
			await record.commit([one, { kind: 'identity', id: 'doc' }]);

			const { loaded } = await record.reopen();
			expect(loaded.identity).toBe('doc');
			expect(loaded.outbox.map((entry) => entry.id)).toEqual([one.id]);
			expect(valueOf(loaded.updates)).toBe('a');
			expect(loaded.lastId).toBe(one.id);
		});
	});
}
