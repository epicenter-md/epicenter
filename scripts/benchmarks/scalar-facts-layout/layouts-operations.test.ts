/**
 * The bounded owner-operation scaffold exercises replica overlays, authority
 * resume/retry reads, failure-atomic row-document cleanup, and fact-shaped
 * settlement inputs. It does not claim the final settlement contract's sealed V1
 * work consumption, which remains an explicit README gap.
 */

import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';

import { makeAuxiliaryTraces } from './auxiliary-traces.js';
import {
	CANDIDATES,
	type Candidate,
	configureNewDatabase,
	createLayoutStore,
	ddlFor,
} from './layouts.js';
import { makeTrace, type Trace } from './trace.js';
import { pilotLimits } from './v1-binding.js';

const open: Database[] = [];
afterEach(() => {
	for (const db of open.splice(0)) db.close();
});

function trace(): Trace {
	return makeTrace({
		facts: 2000,
		namespaceCount: 12,
		tableCount: 100,
		valueRatio: 0.08,
		dataSeed: 5,
		targetLogicalStateBytes: 2000 * 140,
		maxEncodedFactBytes: 4096,
	});
}

function at<T>(values: readonly T[], index: number): T {
	const value = values[index];
	if (value === undefined) throw new Error(`missing fixture at index ${index}`);
	return value;
}

function build(candidate: Candidate, t: Trace, owner: 'replica' | 'authority') {
	const db = new Database(':memory:');
	open.push(db);
	configureNewDatabase(db);
	db.exec(ddlFor(candidate));
	const store = createLayoutStore(db, candidate);
	store.installFacts(
		Array.from({ length: t.options.facts }, (_, i) => t.finalFactAt(i)),
	);
	const aux = makeAuxiliaryTraces(t, pilotLimits());
	if (owner === 'replica') store.populateReplicaAuxiliary(aux);
	else store.populateAuthorityAuxiliary(aux);
	return { db, store, aux };
}

describe('replica overlay read sees pending state', () => {
	for (const candidate of CANDIDATES) {
		test(candidate.id, () => {
			const t = trace();
			const { store, aux } = build(candidate, t, 'replica');
			// A pending intent's address must read back a pending overlay.
			const pendingAddress = at(aux.pending.entries, 0).address;
			expect(store.overlayRead(pendingAddress).pending).toBe(1);
		});
	}
});

describe('authority resume feed count and retry-state read', () => {
	for (const candidate of CANDIDATES) {
		test(candidate.id, () => {
			const t = trace();
			const { store, aux } = build(candidate, t, 'authority');
			// The public operation exposes the bounded result count, not row order.
			expect(store.resumeFeed(0, 100)).toBe(100);
			// The retry ledger the authority owns is readable per replica.
			const retry = at(aux.retry.entries, 0);
			const replicaId = retry.replicaId;
			const read = store.retrySettlementRead(replicaId);
			expect(read.found).toBe(1);
			expect(read.parked).toBe(retry.parked.length);
		});
	}
});

describe('traverse matches the witness count', () => {
	test('unified-inline traversal count equals the oracle current count', () => {
		const t = trace();
		const { store } = build(at(CANDIDATES, 0), t, 'replica');
		expect(store.traverse(0, Number.MAX_SAFE_INTEGER)).toBe(
			t.measure().currentCount,
		);
	});
	for (const candidate of CANDIDATES) {
		test(`${candidate.id} traverses only the declared sequence page`, () => {
			const t = trace();
			const { store } = build(candidate, t, 'replica');
			const afterSequence = 500;
			const throughSequence = 900;
			const expected = Array.from({ length: t.options.facts }, (_, index) =>
				t.finalFactAt(index),
			).filter(
				(fact) =>
					fact.sequence > afterSequence && fact.sequence <= throughSequence,
			).length;
			expect(store.traverse(afterSequence, throughSequence)).toBe(expected);
			const adjacent = Array.from({ length: t.options.facts }, (_, index) =>
				t.finalFactAt(index),
			).filter(
				(fact) =>
					fact.sequence > throughSequence &&
					fact.sequence <= throughSequence + 1,
			).length;
			expect(store.traverse(throughSequence, throughSequence + 1)).toBe(
				adjacent,
			);
			expect(() => store.traverse(-1, 10)).toThrow();
			expect(() => store.traverse(1.5, 10)).toThrow();
			expect(() => store.traverse(11, 10)).toThrow();
			expect(() => store.traverse(10, 10)).toThrow();
		});
	}
});

describe('row tombstone plus document cleanup is one transaction', () => {
	for (const candidate of CANDIDATES) {
		test(candidate.id, () => {
			const t = trace();
			const { db, store } = build(candidate, t, 'replica');
			// Choose a present row that owns a document.
			const docRow = db
				.prepare(
					candidate.coordinates === 'normalized'
						? 'SELECT c.namespace AS ns, c.local_key AS tk, d.row_id AS rid FROM row_documents d JOIN coordinates c USING(coordinate_id) LIMIT 1'
						: 'SELECT namespace AS ns, table_key AS tk, row_id AS rid FROM row_documents LIMIT 1',
				)
				.get() as { ns: string; tk: string; rid: string } | null;
			expect(docRow).not.toBeNull();
			if (docRow === null) throw new Error('document fixture missing');
			const address = {
				kind: 'row' as const,
				namespace: docRow.ns,
				table: docRow.tk,
				rowId: docRow.rid,
			};
			const documentCountStatement = db.prepare(
				candidate.coordinates === 'normalized'
					? 'SELECT COUNT(*) AS n FROM row_documents d JOIN coordinates c USING(coordinate_id) WHERE c.namespace=? AND c.local_key=? AND d.row_id=?'
					: 'SELECT COUNT(*) AS n FROM row_documents WHERE namespace=? AND table_key=? AND row_id=?',
			);
			const documentCount = (): number =>
				(
					documentCountStatement.get(
						address.namespace,
						address.table,
						address.rowId,
					) as {
						n: number;
					}
				).n;
			const maxSeq = (
				db
					.prepare(
						candidate.relation === 'unified'
							? 'SELECT COALESCE(MAX(sequence),0) AS m FROM facts'
							: 'SELECT MAX(m) AS m FROM (SELECT COALESCE(MAX(sequence),0) m FROM row_facts UNION ALL SELECT COALESCE(MAX(sequence),0) FROM value_facts)',
					)
					.get() as { m: number }
			).m;
			const beforeFact = store.pointRead(address);
			expect(beforeFact?.present).toBe(1);
			expect(documentCount()).toBe(1);

			// Force the second operation to fail after the tombstone write. Both the
			// confirmed fact and document must return to their pre-transaction state.
			db.exec(`CREATE TRIGGER refuse_document_delete BEFORE DELETE ON row_documents
				BEGIN SELECT RAISE(ABORT, 'injected document delete failure'); END;`);
			expect(() => store.deleteRowWithDocument(address, maxSeq + 1)).toThrow();
			expect(store.pointRead(address)).toEqual(beforeFact);
			expect(documentCount()).toBe(1);
			db.exec('DROP TRIGGER refuse_document_delete');

			store.deleteRowWithDocument(address, maxSeq + 1);
			// The row is now a terminal tombstone and its document bytes are gone.
			expect(store.pointRead(address)?.present).toBe(0);
			expect(documentCount()).toBe(0);
		});
	}
});

describe('authority settlement installs supplied facts at fresh sequences', () => {
	for (const candidate of CANDIDATES) {
		test(candidate.id, () => {
			const t = trace();
			const { db, store } = build(candidate, t, 'authority');
			const maxSeq = (
				db
					.prepare(
						candidate.relation === 'unified'
							? 'SELECT COALESCE(MAX(sequence),0) AS m FROM facts'
							: 'SELECT MAX(m) AS m FROM (SELECT COALESCE(MAX(sequence),0) m FROM row_facts UNION ALL SELECT COALESCE(MAX(sequence),0) FROM value_facts)',
					)
					.get() as { m: number }
			).m;
			// Three new-row intents settled at fresh sequences above the max.
			const intents = [0, 1, 2].map((k) => ({
				address: {
					kind: 'row' as const,
					namespace: 'so.epicenter.ns00',
					table: 'collection0001',
					rowId: (50_000_000 + k).toString(36).padStart(24, '0'),
				},
				sequence: 0,
				presence: 'present' as const,
				fields: { body: 'x'.repeat(32), k },
			}));
			const next = store.settleSubmission(
				'replica0000000000000000ab',
				intents,
				maxSeq + 1,
				'hash',
			);
			expect(next).toBe(maxSeq + 1 + 3);
			// Each settled intent is now a present confirmed fact.
			for (const [index, intent] of intents.entries()) {
				expect(store.pointRead(intent.address)).toEqual({
					present: 1,
					sequence: maxSeq + 1 + index,
				});
			}
			expect(store.retrySettlementRead('replica0000000000000000ab').found).toBe(
				1,
			);
		});
	}
});
