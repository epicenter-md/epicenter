/**
 * What a document is on this device: a chain of updates, folded when it grows.
 *
 * There are no Yjs imports in this file, and that is the design. A chain is
 * opaque bytes in an order; what they mean is the caller's business, and the
 * one place this file would have needed Yjs, encoding a fold, is a callback
 * the caller supplies instead. That keeps the rule below enforceable rather
 * than merely documented.
 *
 * ## The rule this shape exists to enforce
 *
 * An IndexedDB transaction goes inactive the moment it awaits anything that is
 * not an IDB request, and the failure is intermittent and load-dependent
 * rather than immediate. `fold` therefore takes an `encode` callback it calls
 * SYNCHRONOUSLY, before it opens the transaction. A caller cannot hand this
 * file a promise to wait on inside one, because there is nowhere to put it.
 *
 * ## Why appending is eager and folding is not
 *
 * Appending is O(update) and is what makes an edit durable, so it happens on
 * every update with no timer in front of it (ADR-0280). Folding is
 * O(document) and only shortens a replay, so it happens when the owner's idle
 * timer says work has stopped. Folding late costs a longer read; appending
 * late costs a person's work.
 *
 * ## One writer
 *
 * `claims.ts` holds an exclusive Web Lock on the store, so exactly one page
 * appends to a given record. That is what lets the sequence counter live in
 * memory instead of being read back, and it is the assumption to check first
 * if two tabs ever come to share one record.
 *
 * ## What is stored
 *
 * One object store, `updates`, keyed by `[doc, seq]`. A folded state is not a
 * second table: it is written as an ordinary record and the entries it covers
 * are deleted in the same transaction, so nothing can tell a fold from an
 * update by looking. Yjs updates are commutative and idempotent, so a reader
 * applies the whole range in key order and never has to know which is which.
 */

import { type DBSchema, type IDBPDatabase, openDB } from 'idb';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import type { Logger } from 'wellcrafted/logger';

import { shouldFold } from '../sync/fold.js';

export const DurableRecordError = defineErrors({
	/**
	 * Storage refused a write, so this device is no longer keeping edits.
	 *
	 * Thrown rather than returned, which is what `DurablePort` did and what the
	 * one caller is written for. The health bit below is the surface a person
	 * eventually sees; this is the throw a caller catches.
	 */
	WriteFailed: ({ name, cause }: { name: string; cause: unknown }) => ({
		message: `The durable record at ${name} rejected a write`,
		cause,
	}),
	/**
	 * Storage could not be read, which is a boot failure rather than a debt.
	 *
	 * Separate from `WriteFailed` because the two mean opposite things to a
	 * person: one says the edits you already made are not safe, the other says
	 * this store cannot be opened at all. The durability bit is about the
	 * first, so a read failure does not touch it.
	 */
	ReadFailed: ({ name, cause }: { name: string; cause: unknown }) => ({
		message: `The durable record at ${name} could not be read`,
		cause,
	}),
});
export type DurableRecordError = InferErrors<typeof DurableRecordError>;

/**
 * The slice of the platform this assumes, declared rather than imported.
 *
 * Same move as `claims.ts`: this module compiles under `types: ["bun"]`, where
 * the DOM library does not exist, and naming what it reaches for keeps the
 * assumption auditable.
 *
 * The range is OPAQUE and the bounds are not. An earlier version contributed
 * an empty `interface IDBKeyRange {}` to the global scope, which in a program
 * without the DOM library makes every non-nullish value a range:
 * `store.delete('a plain string')` typechecked, and `delete` is the only call
 * in this file that can destroy data. Typing `bound` precisely and casting
 * once per `idb` call confines the escape hatch to three sites rather than
 * leaking `{}` through the file.
 */
declare const keyRange: unique symbol;
type KeyRange = { readonly [keyRange]: true };

type KeyRanges = {
	bound(lower: readonly [string], upper: readonly [string, number]): KeyRange;
};

function keyRanges(): KeyRanges {
	const ranges = (globalThis as { IDBKeyRange?: KeyRanges }).IDBKeyRange;
	if (ranges === undefined) throw new Error('this runtime has no IndexedDB');
	return ranges;
}

/**
 * Which database names are open in this realm, so two records cannot share one.
 *
 * `claim` guards two handles inside one record; this guards two records over
 * one database, which is the level the collision actually happens at. Two
 * `openDurableRecord` calls on one name each seed their sequence from the same
 * disk and then hand out the same numbers, and before `add` replaced `put`
 * that overwrote live records in silence.
 *
 * Per realm, like the `Set` `claims.ts` replaced with a Web Lock, and for the
 * same reason it is not enough on its own: `claims.ts` holds the cross-tab
 * lock, and this catches the case inside one tab that a lock cannot see.
 */
const openNames = new Set<string>();

/** The one object store, and the one shape in it. */
interface RecordSchema extends DBSchema {
	updates: {
		key: [string, number];
		value: { doc: string; seq: number; bytes: Uint8Array };
	};
}

/**
 * Whether this device's writes are reaching disk.
 *
 * The whole of what survives ADR-0238's three-state debt machine. Under eager
 * appends there is no queue to observe and no window to report, so the only
 * fact left worth publishing is the one that used to be implied: a rejecting
 * IndexedDB (quota, eviction, a corrupt store) would otherwise fail every
 * append with nothing watching, which is silent local data loss.
 */
export type Durability = {
	readonly healthy: boolean;
	/** Called on every change. Returns its own removal. */
	subscribe(listener: (healthy: boolean) => void): () => void;
};

export type DurableRecord = {
	/**
	 * Everything stored for one document, in the order it must be applied.
	 *
	 * An unwritten document reads as an empty array rather than a failure: a
	 * replica that has never synced and one whose document is genuinely empty
	 * are the same replica.
	 */
	read(doc: string): Promise<Uint8Array[]>;
	/**
	 * One update, durably, now. Resolves when the transaction has committed.
	 *
	 * Committed is not `fsync`. IndexedDB's default durability is relaxed, so a
	 * power cut can still take a committed append. What this covers completely
	 * is the threat that motivated it: a tab that goes away between an edit and
	 * the next timer.
	 */
	append(doc: string, bytes: Uint8Array): Promise<void>;
	/** Whether this document's tail has outgrown its folded state. */
	shouldFold(doc: string): boolean;
	/**
	 * Replace what `encode` covers with one record.
	 *
	 * `encode` is called synchronously and must be synchronous. Everything it
	 * does not cover, because it arrived while this was running, is kept.
	 * Calling this when `shouldFold` is false is wasteful and, once the
	 * document has been read, never wrong.
	 */
	fold(doc: string, encode: () => Uint8Array): Promise<void>;
	/**
	 * Take this document, exclusively, until the returned release is called.
	 *
	 * `fold` assumes the document behind its `encode` dominates the chain, and
	 * two openers of one address break that assumption in the worst way: one
	 * folds a state encoded from a document that never saw the other's edits,
	 * and its delete range sweeps them. Nine edits in, one out, no error.
	 *
	 * `claims.ts` guards two tabs and cannot see two openers inside one. The
	 * refcounted map in `documents.ts` used to guard that, and this is the
	 * tripwire under it rather than a replacement for it: a manager should
	 * still hand out one handle per address, and this makes forgetting to
	 * throw rather than corrupt.
	 */
	claim(doc: string): () => void;
	/**
	 * Append to one document and forget another, atomically.
	 *
	 * The one composed verb, and it exists because deleting a row is two
	 * facts: the scalar row leaves the application document, and the row's own
	 * chain stops existing. Two transactions leave a window where a crash
	 * strands a document no row names, which is debris rather than divergence
	 * but is avoidable for free now that both live in one object store.
	 */
	appendAndRetire(
		doc: string,
		bytes: Uint8Array,
		retire: string,
	): Promise<void>;
	/** Forget a document. Idempotent. */
	retire(doc: string): Promise<void>;
	/**
	 * Every document with anything stored, in no particular order.
	 *
	 * Nothing needed this until export did, and every mint reads one now
	 * (ADR-0286). It cannot be faked from the application document, which
	 * names the rows that exist and not the chains that do.
	 */
	documents(): Promise<string[]>;
	readonly durability: Durability;
	close(): void;
};

/** What this file assumes about a document's chain, kept in memory. */
type Counters = {
	/** The last sequence handed out. Never reused, not even after a fold. */
	seq: number;
	/** Bytes in the most recent fold, or 0 if this chain has never been folded. */
	stateBytes: number;
	/** Bytes appended since that fold. */
	tailBytes: number;
	/**
	 * Whether this chain has any record at all, decided synchronously.
	 *
	 * It answers "is the record I am about to write this chain's state", and it
	 * has to be answered in the caller's synchronous prefix. `seq === 0` is
	 * wrong because a retire leaves the sequence climbing on purpose;
	 * `stateBytes === 0` is wrong because the byte totals are updated after the
	 * transaction resolves, so six appends issued in one tick would all see
	 * zero and every one of them would book itself as the state.
	 */
	hasRecord: boolean;
	/** Whether `read` has seeded the two above from storage. */
	seeded: boolean;
	/**
	 * Whether an append for this document was rejected and never landed.
	 *
	 * The repair, not just the record of it. A failed append does not increment
	 * `tailBytes`, so it makes a fold LESS likely, and a fold is the only thing
	 * that rewrites the whole document and puts the missing bytes back. So this
	 * forces one: the next idle settle encodes the live document, which still
	 * holds what the failed append carried, and the chain catches up.
	 */
	lost: boolean;
};

export async function openDurableRecord({
	name,
	logger,
	floorBytes,
}: {
	/** The IndexedDB database name, which is the generation (ADR-0281). */
	name: string;
	logger?: Logger;
	/** Injected so a test can reach a fold without a large document. */
	floorBytes?: number;
}): Promise<DurableRecord> {
	if (openNames.has(name)) {
		throw new Error(`${name} is already open in this realm`);
	}
	openNames.add(name);

	// Declared before `openDB` rather than closed over from its own
	// initialiser. `blocking` cannot fire before the connection exists, but a
	// `let` says so, where the optional chain it replaces looked like a guard
	// and would not have caught the hazard it appeared to guard.
	let database: IDBPDatabase<RecordSchema> | undefined;
	database = await openDB<RecordSchema>(name, 1, {
		upgrade(db, oldVersion) {
			// Unreachable while the version is pinned at 1, which is the point:
			// the refusal is the invariant rather than a handler (ADR-0280). A
			// shape change is an export and a re-import, never a migration.
			if (oldVersion !== 0) {
				throw new Error(
					`${name} was written by a newer shape and there is no migration path`,
				);
			}
			db.createObjectStore('updates', { keyPath: ['doc', 'seq'] });
		},
		blocking() {
			// A tab left open otherwise wedges every future `deleteDatabase`, and
			// deleting a generation is exactly the operation that blocks on it.
			database?.close();
		},
		terminated() {
			// Safari drops IndexedDB connections. Saying so beats appending into
			// a closed database forever and calling it healthy. Reported rather
			// than thrown: this is an event callback, and `fail`'s throw would
			// surface as an unhandled error having already done the useful half.
			setHealthy(false);
			logger?.error(
				DurableRecordError.WriteFailed({
					name,
					cause: new Error('the browser terminated this connection'),
				}),
			);
		},
	});

	const counters = new Map<string, Counters>();
	const claimed = new Set<string>();
	let healthy = true;
	const listeners = new Set<(healthy: boolean) => void>();

	function of(doc: string): Counters {
		const existing = counters.get(doc);
		if (existing !== undefined) return existing;
		const fresh: Counters = {
			seq: 0,
			stateBytes: 0,
			tailBytes: 0,
			hasRecord: false,
			seeded: false,
			lost: false,
		};
		counters.set(doc, fresh);
		return fresh;
	}

	/** The connection, which exists by the time any method below can run. */
	function open(): IDBPDatabase<RecordSchema> {
		if (database === undefined) throw new Error('the record is not open');
		return database;
	}

	function setHealthy(next: boolean): void {
		// Green means every document this record was asked to keep is kept, not
		// that the last write happened to work. Without this, one transient
		// rejection flips back to healthy on the very next keystroke while the
		// bytes it dropped stay dropped.
		if (next && [...counters.values()].some((counter) => counter.lost)) return;
		if (healthy === next) return;
		healthy = next;
		for (const listener of listeners) listener(next);
	}

	function fail(cause: unknown): never {
		setHealthy(false);
		const error = DurableRecordError.WriteFailed({ name, cause });
		logger?.error(error);
		throw error;
	}

	/**
	 * One document's keys, up to and including `upTo`.
	 *
	 * The lower bound is the one-element array rather than a sentinel number:
	 * IndexedDB compares array keys element by element and then by length, so
	 * `[doc]` sorts below every `[doc, seq]` and below nothing else. Prefix
	 * bleed is impossible for the same reason, because `app` and `apple` are
	 * different first elements rather than a shared string prefix.
	 */
	const range = (doc: string, upTo: number): KeyRange =>
		keyRanges().bound([doc], [doc, upTo]);

	const record: DurableRecord = Object.freeze({
		durability: {
			get healthy() {
				return healthy;
			},
			subscribe(listener) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		},

		async read(doc) {
			const rows = await open()
				.getAll('updates', range(doc, Number.POSITIVE_INFINITY) as never)
				.catch((cause: unknown) => {
					throw DurableRecordError.ReadFailed({ name, cause });
				});
			const counter = of(doc);
			// Seeded once, and never again. A second read is a snapshot of disk
			// that excludes any append whose transaction was created after it,
			// so assigning from it would roll the sequence back and the next
			// append would overwrite a live record. Hydration happens once per
			// open, and this makes a second call harmless rather than
			// destructive.
			if (counter.seeded) return rows.map((row) => row.bytes);
			counter.seeded = true;
			if (rows.length === 0) return [];
			counter.hasRecord = true;
			// Seeding the counters from what was read is why `read` is not
			// optional before a write: a fresh sequence would collide with a
			// surviving key, and a fold that ran out of a half-swept range would
			// name different bytes with the same name.
			// The first record is the state. Usually a fold put it there; on a
			// chain that has never been folded it is simply the oldest update,
			// and calling it the state is still right, because folding a chain
			// whose first record already dominates it buys nothing.
			const [first, ...rest] = rows as [
				(typeof rows)[number],
				...(typeof rows)[number][],
			];
			counter.seq = rest.at(-1)?.seq ?? first.seq;
			counter.stateBytes = first.bytes.byteLength;
			counter.tailBytes = rest.reduce(
				(total, row) => total + row.bytes.byteLength,
				0,
			);
			return rows.map((row) => row.bytes);
		},

		async append(doc, bytes) {
			const counter = of(doc);
			// Enforced rather than documented, because both things it protects
			// fail quietly: a fresh sequence would collide with a surviving key,
			// and the totals below would describe a chain this process has never
			// seen. The real caller hydrates before it can produce an update, so
			// this is unreachable outside a test that skipped a step.
			if (!counter.seeded) {
				throw new Error(`read('${doc}') must happen before a write to it`);
			}
			const empty = !counter.hasRecord;
			counter.hasRecord = true;
			counter.seq += 1;
			// `add`, never `put`. Every defect this file can have is an in-memory
			// counter disagreeing with disk, and `put` is an upsert: it would
			// overwrite a live record and say nothing. `add` throws
			// `ConstraintError` on an existing key, which turns the whole class
			// from silent loss into a loud failure with the health bit red.
			await open()
				.add('updates', { doc, seq: counter.seq, bytes })
				.catch((cause: unknown) => {
					counter.lost = true;
					return fail(cause);
				});
			// The first record of a chain is its state, whether or not a fold put
			// it there. Keeping that true here is what makes `shouldFold` give the
			// same answer before and after a reopen, since `read` cannot tell a
			// fold from an update by looking and neither can anything else.
			if (empty) counter.stateBytes = bytes.byteLength;
			else counter.tailBytes += bytes.byteLength;
			setHealthy(true);
		},

		shouldFold(doc) {
			const counter = of(doc);
			// A dropped append forces one, because folding is the repair.
			if (counter.lost) return true;
			return shouldFold(counter.stateBytes, counter.tailBytes, floorBytes);
		},

		async fold(doc, encode) {
			const counter = of(doc);
			// Captured BEFORE encoding, so anything that arrives while this runs
			// sits above the bound and survives. It may also already be inside
			// `state`, which costs one redundant apply and nothing else.
			if (!counter.seeded) {
				throw new Error(`read('${doc}') must happen before a write to it`);
			}
			const upTo = counter.seq;
			const foldedTail = counter.tailBytes;
			const state = encode();
			counter.hasRecord = true;
			counter.seq += 1;
			const seq = counter.seq;
			const transaction = open().transaction('updates', 'readwrite');
			const store = transaction.objectStore('updates');
			// Only IDB calls from here to `done`. Awaiting anything else would
			// close the transaction out from under the delete.
			await Promise.all([
				store.add({ doc, seq, bytes: state }),
				store.delete(range(doc, upTo) as never),
				transaction.done,
			]).catch(fail);
			counter.stateBytes = state.byteLength;
			// Subtracted rather than zeroed. An append that landed while the
			// transaction was open sits above the bound and is still on disk, so
			// its bytes are still tail, and zeroing would drop them from the
			// totals that decide the next fold.
			counter.tailBytes -= foldedTail;
			// The state just written came from the live document, so whatever a
			// failed append dropped is on disk again.
			counter.lost = false;
			setHealthy(true);
		},

		claim(doc) {
			if (claimed.has(doc)) {
				throw new Error(`${doc} is already open in this record`);
			}
			claimed.add(doc);
			return () => {
				claimed.delete(doc);
			};
		},

		async appendAndRetire(doc, bytes, retired) {
			if (doc === retired) {
				// The delete range would cover the `add` issued moments earlier in
				// the same transaction, and the counters would end up agreeing
				// with a disk that had quietly lost the append.
				throw new Error(`appendAndRetire cannot retire ${doc} into itself`);
			}
			const counter = of(doc);
			if (!counter.seeded) {
				throw new Error(`read('${doc}') must happen before a write to it`);
			}
			const empty = !counter.hasRecord;
			counter.hasRecord = true;
			counter.seq += 1;
			const seq = counter.seq;
			const transaction = open().transaction('updates', 'readwrite');
			const store = transaction.objectStore('updates');
			// Only IDB calls between here and `done`, the same rule the fold
			// keeps: awaiting anything else closes the transaction mid-flight.
			await Promise.all([
				store.add({ doc, seq, bytes }),
				store.delete(range(retired, Number.POSITIVE_INFINITY) as never),
				transaction.done,
			]).catch(fail);
			if (empty) counter.stateBytes = bytes.byteLength;
			else counter.tailBytes += bytes.byteLength;
			const gone = of(retired);
			gone.stateBytes = 0;
			gone.tailBytes = 0;
			gone.hasRecord = false;
			gone.seeded = true;
			setHealthy(true);
		},

		async documents() {
			const keys = await open()
				.getAllKeys('updates')
				.catch((cause: unknown) => {
					throw DurableRecordError.ReadFailed({ name, cause });
				});
			return [...new Set(keys.map(([doc]) => doc))];
		},

		async retire(doc) {
			await open()
				.delete('updates', range(doc, Number.POSITIVE_INFINITY) as never)
				.catch(fail);
			// Zeroed and left SEEDED rather than dropped. This process just
			// emptied the chain, so it knows what is there; dropping the counter
			// would make a recreate at the same address, which ADR-0279's copy
			// verb reaches, demand a read of a chain there is nothing to read.
			// The sequence keeps climbing, because never-reused outlives the
			// document it numbered.
			const counter = of(doc);
			counter.stateBytes = 0;
			counter.tailBytes = 0;
			counter.hasRecord = false;
			counter.seeded = true;
		},

		close() {
			openNames.delete(name);
			// Listeners are kept. A write attempted against a closed record still
			// has to be able to say it failed, and the caller drops this object
			// anyway; clearing here would silence the one report that matters.
			open().close();
		},
	});
	return record;
}
