/**
 * A durable record that is not durable, for a store with nowhere to put bytes.
 *
 * `openMemory` has real consumers (`packages/chat`, `packages/skills`, and
 * several artifact and application tests) and none of them want a filesystem
 * or a browser. What they want is the store's whole surface with a record
 * underneath that survives a close and reopen inside one process and nothing
 * further.
 *
 * ## Why this is a second implementation, and what stops it drifting
 *
 * `DurablePort` had two hand-written implementations and they silently
 * disagreed, which is why `port-conformance.test.ts` had to exist at 314
 * lines. The same hazard is here in miniature: the rules this has to keep are
 * not obvious from the interface, and they are exactly the ones three audits
 * found bugs in. A write's sequence comes from the chain rather than from
 * memory. The first record of a chain is its state. A fold deletes up to a
 * bound read before its callback runs. `read` seeds the byte totals once and
 * is an accessor after.
 *
 * So the answer is not a conformance suite beside the implementations: it is
 * that `record.test.ts` runs its whole suite over BOTH of them. One set of
 * assertions, two subjects, and a rule that only one implementation keeps
 * fails on the other.
 *
 * That instrument is only as good as the symmetry. This file kept an
 * in-memory sequence and pushed with no uniqueness check, so the loud failure
 * the IndexedDB record gets from `add` did not exist here at all: a duplicate
 * key would have been accepted in silence by the very subject meant to catch
 * it. `addRow` below is that missing constraint, and deriving the sequence
 * from the chain is what makes reaching it impossible.
 *
 * ## What it deliberately does not do
 *
 * Nothing here can fail, so `durability` is a constant `true` and no listener
 * is ever called. A caller that wants to exercise a rejecting store wants the
 * IndexedDB record with a value it cannot store, which is what
 * `record.test.ts` does.
 */

import { shouldFold } from '../sync/fold.js';
import type { Durability, DurableRecord } from './record.js';

/** Per-realm, and for the same reason the IndexedDB record keeps one. */
const openNames = new Set<string>();

/** Chains outlive the record that held them, which is what a reopen means. */
const stores = new Map<
	string,
	Map<string, { seq: number; bytes: Uint8Array }[]>
>();

const durability: Durability = {
	healthy: true,
	subscribe: () => () => undefined,
};

/**
 * Async, though nothing here awaits anything.
 *
 * Matching the IndexedDB record's shape rather than its needs. A caller that
 * switches between them must not have to know which one throws synchronously
 * and which one rejects, and the suite that runs over both found the
 * difference the first time it looked.
 */
export async function openMemoryRecord({
	name,
	floorBytes,
}: {
	name: string;
	floorBytes?: number;
}): Promise<DurableRecord> {
	if (openNames.has(name)) {
		throw new Error(`${name} is already open in this realm`);
	}
	openNames.add(name);

	let chains = stores.get(name);
	if (chains === undefined) {
		chains = new Map();
		stores.set(name, chains);
	}
	const held = chains;

	const counters = new Map<
		string,
		{ stateBytes: number; tailBytes: number; seeded: boolean }
	>();
	const claimed = new Set<string>();

	function of(doc: string) {
		const existing = counters.get(doc);
		if (existing !== undefined) return existing;
		const fresh = { stateBytes: 0, tailBytes: 0, seeded: false };
		counters.set(doc, fresh);
		return fresh;
	}

	function chain(doc: string) {
		const existing = held.get(doc);
		if (existing !== undefined) return existing;
		const fresh: { seq: number; bytes: Uint8Array }[] = [];
		held.set(doc, fresh);
		return fresh;
	}

	/** The IndexedDB record's `lastSeq`, over an array instead of a cursor. */
	function lastSeq(doc: string): number {
		return chain(doc).reduce((top, row) => (row.seq > top ? row.seq : top), 0);
	}

	/**
	 * `add`, not `push`.
	 *
	 * The IndexedDB record gets `ConstraintError` from the platform; this has
	 * to state it. Nothing should be able to reach it now that the sequence is
	 * derived, which is exactly why it has to be here: the twin that cannot
	 * fail loudly is the twin that normalises the pattern the suite exists to
	 * catch.
	 */
	function addRow(doc: string, seq: number, bytes: Uint8Array): void {
		const rows = chain(doc);
		if (rows.some((row) => row.seq === seq)) {
			throw new Error(`${doc} already has a record at ${seq}`);
		}
		rows.push({ seq, bytes });
	}

	const record: DurableRecord = Object.freeze({
		durability,

		async read(doc) {
			const rows = [...chain(doc)].sort((a, b) => a.seq - b.seq);
			const counter = of(doc);
			if (counter.seeded) return rows.map((row) => row.bytes);
			counter.seeded = true;
			if (rows.length === 0) return [];
			const [first, ...rest] = rows as [
				(typeof rows)[number],
				...(typeof rows)[number][],
			];
			counter.stateBytes = first.bytes.byteLength;
			counter.tailBytes = rest.reduce(
				(total, row) => total + row.bytes.byteLength,
				0,
			);
			return rows.map((row) => row.bytes);
		},

		async append(doc, bytes) {
			const counter = of(doc);
			const last = lastSeq(doc);
			addRow(doc, last + 1, bytes);
			if (last === 0) counter.stateBytes = bytes.byteLength;
			else counter.tailBytes += bytes.byteLength;
		},

		shouldFold(doc) {
			const counter = of(doc);
			return shouldFold(counter.stateBytes, counter.tailBytes, floorBytes);
		},

		async fold(doc, encode) {
			const counter = of(doc);
			if (!counter.seeded) {
				throw new Error(`read('${doc}') must happen before a fold of it`);
			}
			const upTo = lastSeq(doc);
			const foldedTail = counter.tailBytes;
			const state = encode();
			// Read again after `encode`, for the same reason the IndexedDB record
			// re-reads inside its writing transaction: the state goes above what
			// is there now, and the delete stops at the bound taken before.
			const seq = lastSeq(doc) + 1;
			held.set(
				doc,
				chain(doc).filter((row) => row.seq > upTo),
			);
			addRow(doc, seq, state);
			counter.stateBytes = state.byteLength;
			counter.tailBytes -= foldedTail;
		},

		async appendAndRetire(doc, bytes, retired) {
			if (doc === retired) {
				throw new Error(`appendAndRetire cannot retire ${doc} into itself`);
			}
			const counter = of(doc);
			const last = lastSeq(doc);
			addRow(doc, last + 1, bytes);
			held.set(retired, []);
			if (last === 0) counter.stateBytes = bytes.byteLength;
			else counter.tailBytes += bytes.byteLength;
			const gone = of(retired);
			gone.stateBytes = 0;
			gone.tailBytes = 0;
			gone.seeded = true;
		},

		async retire(doc) {
			held.set(doc, []);
			const counter = of(doc);
			counter.stateBytes = 0;
			counter.tailBytes = 0;
			counter.seeded = true;
		},

		async documents() {
			return [...held.entries()]
				.filter(([, rows]) => rows.length > 0)
				.map(([doc]) => doc);
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

		close() {
			openNames.delete(name);
		},
	});
	return record;
}
