/**
 * Direct hostile-SQL invariant tests for every candidate layout, reproducing the
 * audit's data-corruption findings and proving they are now refused:
 *
 * - lower sequence must not overwrite higher (monotonic install);
 * - a terminal row tombstone must not be resurrected by a later present;
 * - a value unset is non-terminal and may be replaced;
 * - unified normalized must not hold multiple physical rows for one value address;
 * - split normalized must reject a fact referencing the wrong coordinate kind;
 * - every auxiliary table must reject malformed or mismatched addresses;
 * - coordinates are immutable, so no UPDATE/DELETE/REPLACE can reinterpret a fact.
 */

import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';

import {
	CANDIDATES,
	type Candidate,
	configureNewDatabase,
	createLayoutStore,
	ddlFor,
} from './layouts.js';
import type { Fact, RowAddress, ValueAddress } from './trace.js';

const open: Database[] = [];
afterEach(() => {
	for (const db of open.splice(0)) db.close();
});

function fresh(candidate: Candidate) {
	const db = new Database(':memory:');
	open.push(db);
	configureNewDatabase(db);
	db.exec(ddlFor(candidate));
	return { db, store: createLayoutStore(db, candidate) };
}

const rowAddr = (rowId: string): RowAddress => ({
	kind: 'row',
	namespace: 'so.epicenter.ns00',
	table: 'collection0001',
	rowId,
});
const valueAddr = (value: string): ValueAddress => ({
	kind: 'value',
	namespace: 'so.epicenter.ns00',
	value,
});
const ID_A = 'a'.repeat(24);

function rowPresent(rowId: string, sequence: number): Fact {
	return {
		address: rowAddr(rowId),
		sequence,
		presence: 'present',
		fields: { ok: 1 },
	};
}
function rowAbsent(rowId: string, sequence: number): Fact {
	return { address: rowAddr(rowId), sequence, presence: 'absent' };
}

describe('monotonic install: a lower sequence never overwrites a higher one', () => {
	for (const candidate of CANDIDATES) {
		test(candidate.id, () => {
			const { store } = fresh(candidate);
			store.installFacts([rowPresent(ID_A, 10)]);
			store.installFacts([rowPresent(ID_A, 5)]);
			expect(store.pointRead(rowAddr(ID_A))?.sequence).toBe(10);
		});
	}
});

describe('row tombstone dominance: a later present never resurrects a deleted row', () => {
	for (const candidate of CANDIDATES) {
		test(candidate.id, () => {
			const { store } = fresh(candidate);
			store.installFacts([rowAbsent(ID_A, 2)]);
			store.installFacts([rowPresent(ID_A, 3)]);
			expect(store.pointRead(rowAddr(ID_A))?.present).toBe(0);
		});
	}
});

describe('value absence is non-terminal: a later present replaces it', () => {
	for (const candidate of CANDIDATES) {
		test(candidate.id, () => {
			const { store } = fresh(candidate);
			const v = valueAddr('settingx');
			store.installFacts([{ address: v, sequence: 2, presence: 'absent' }]);
			store.installFacts([
				{ address: v, sequence: 3, presence: 'present', content: 'back' },
			]);
			expect(store.pointRead(v)?.present).toBe(1);
		});
	}
});

describe('coordinates are immutable (normalized candidates)', () => {
	const normalized = CANDIDATES.filter((c) => c.coordinates === 'normalized');
	for (const candidate of normalized) {
		test(`${candidate.id}: UPDATE/DELETE/REPLACE of a referenced coordinate is refused`, () => {
			const { db, store } = fresh(candidate);
			store.installFacts([rowPresent(ID_A, 1)]);
			const id = (
				db
					.prepare(
						"SELECT coordinate_id AS id FROM coordinates WHERE kind='row' AND namespace='so.epicenter.ns00' AND local_key='collection0001'",
					)
					.get() as { id: number }
			).id;
			expect(() =>
				db.run('UPDATE coordinates SET kind=? WHERE coordinate_id=?', [
					'value',
					id,
				]),
			).toThrow();
			expect(() =>
				db.run('DELETE FROM coordinates WHERE coordinate_id=?', [id]),
			).toThrow();
			expect(() =>
				db.run(
					'INSERT OR REPLACE INTO coordinates (coordinate_id,kind,namespace,local_key) VALUES (?,?,?,?)',
					[id, 'value', 'so.epicenter.ns00', 'settingz'],
				),
			).toThrow();
			// The fact still reads as a present row: nothing was reinterpreted.
			expect(store.pointRead(rowAddr(ID_A))?.present).toBe(1);
		});
	}
});

describe('auxiliary tables enforce structured address invariants', () => {
	for (const candidate of CANDIDATES) {
		test(`${candidate.id}: hostile inserts cannot bypass address shape`, () => {
			const { db } = fresh(candidate);
			if (candidate.coordinates === 'inline') {
				expect(() =>
					db.run(
						'INSERT INTO pending_intents (kind,namespace,local_key,row_id,present,payload) VALUES (?,?,?,?,?,?)',
						['other', 'ns', 'key', '', 0, null],
					),
				).toThrow();
				expect(() =>
					db.run(
						'INSERT INTO pending_intents (kind,namespace,local_key,row_id,present,payload) VALUES (?,?,?,?,?,?)',
						['value', 'ns', 'key', ID_A, 0, null],
					),
				).toThrow();
				expect(() =>
					db.run(
						'INSERT INTO parked_work (kind,namespace,local_key,row_id,code,measured_bytes,limit_bytes) VALUES (?,?,?,?,?,?,?)',
						['row', '', 'key', ID_A, 'code', 2, 1],
					),
				).toThrow();
				expect(() =>
					db.run(
						'INSERT INTO sealed_submissions (kind,namespace,local_key,row_id,submission_number,present,payload) VALUES (?,?,?,?,?,?,?)',
						['row', 'ns', '', ID_A, 1, 0, null],
					),
				).toThrow();
				expect(() =>
					db.run(
						'INSERT INTO retry_parked (replica_id,kind,namespace,local_key,row_id,code,measured_bytes,limit_bytes) VALUES (?,?,?,?,?,?,?,?)',
						['replica', 'row', 'ns', 'key', 'short', 'code', 2, 1],
					),
				).toThrow();
				expect(() =>
					db.run(
						'INSERT INTO row_documents (namespace,table_key,row_id,baseline,tail) VALUES (?,?,?,?,?)',
						['ns', 'table', 'short', new Uint8Array(), new Uint8Array()],
					),
				).toThrow();
				expect(() =>
					db.run(
						'INSERT INTO row_documents (namespace,table_key,row_id,baseline,tail) VALUES (?,?,?,?,?)',
						['ns', '', ID_A, new Uint8Array(), new Uint8Array()],
					),
				).toThrow();
				return;
			}

			for (const values of [
				['other', 'ns', 'key'],
				['row', '', 'key'],
				['row', 'ns', ''],
			] as const) {
				expect(() =>
					db.run(
						'INSERT INTO coordinates (kind,namespace,local_key) VALUES (?,?,?)',
						[...values],
					),
				).toThrow();
			}
			db.run(
				"INSERT INTO coordinates (kind,namespace,local_key) VALUES ('row','ns','table'),('value','ns','setting')",
			);
			const rowCoordinate = (
				db
					.prepare(
						"SELECT coordinate_id AS id FROM coordinates WHERE kind='row'",
					)
					.get() as { id: number }
			).id;
			const valueCoordinate = (
				db
					.prepare(
						"SELECT coordinate_id AS id FROM coordinates WHERE kind='value'",
					)
					.get() as { id: number }
			).id;

			expect(() =>
				db.run(
					'INSERT INTO pending_intents (coordinate_id,row_id,present,payload) VALUES (?,?,?,?)',
					[rowCoordinate, '', 0, null],
				),
			).toThrow();
			expect(() =>
				db.run(
					'INSERT INTO parked_work (coordinate_id,row_id,code,measured_bytes,limit_bytes) VALUES (?,?,?,?,?)',
					[valueCoordinate, ID_A, 'code', 2, 1],
				),
			).toThrow();
			expect(() =>
				db.run(
					'INSERT INTO sealed_submissions (coordinate_id,row_id,submission_number,present,payload) VALUES (?,?,?,?,?)',
					[rowCoordinate, 'short', 1, 0, null],
				),
			).toThrow();
			expect(() =>
				db.run(
					'INSERT INTO retry_parked (replica_id,coordinate_id,row_id,code,measured_bytes,limit_bytes) VALUES (?,?,?,?,?,?)',
					['replica', valueCoordinate, ID_A, 'code', 2, 1],
				),
			).toThrow();
			expect(() =>
				db.run(
					'INSERT INTO row_documents (coordinate_id,row_id,baseline,tail) VALUES (?,?,?,?)',
					[valueCoordinate, ID_A, new Uint8Array(), new Uint8Array()],
				),
			).toThrow();

			// UPDATE cannot bypass the same kind/row-id and row-document rules.
			db.run(
				'INSERT INTO pending_intents (coordinate_id,row_id,present,payload) VALUES (?,?,?,?)',
				[rowCoordinate, ID_A, 0, null],
			);
			expect(() =>
				db.run('UPDATE pending_intents SET coordinate_id=?', [valueCoordinate]),
			).toThrow();
			db.run(
				'INSERT INTO row_documents (coordinate_id,row_id,baseline,tail) VALUES (?,?,?,?)',
				[rowCoordinate, ID_A, new Uint8Array(), new Uint8Array()],
			);
			expect(() =>
				db.run('UPDATE row_documents SET coordinate_id=?', [valueCoordinate]),
			).toThrow();
		});
	}
});

describe('unified normalized: one value address holds at most one physical row', () => {
	test('a value fact with a non-empty row_id is refused', () => {
		const candidate = CANDIDATES.find(
			(c) => c.relation === 'unified' && c.coordinates === 'normalized',
		);
		expect(candidate).toBeDefined();
		if (!candidate) throw new Error('missing unified-normalized candidate');
		const { db, store } = fresh(candidate);
		store.installFacts([
			{
				address: valueAddr('settingx'),
				sequence: 1,
				presence: 'present',
				content: 1,
			},
		]);
		const id = (
			db
				.prepare(
					"SELECT coordinate_id AS id FROM coordinates WHERE kind='value' AND local_key='settingx'",
				)
				.get() as { id: number }
		).id;
		expect(() =>
			db.run(
				'INSERT INTO facts (coordinate_id,row_id,present,payload,sequence) VALUES (?,?,?,?,?)',
				[id, ID_A, 1, 'null', 999],
			),
		).toThrow();
		const count = (
			db
				.prepare('SELECT COUNT(*) AS n FROM facts WHERE coordinate_id=?')
				.get(id) as {
				n: number;
			}
		).n;
		expect(count).toBe(1);
	});
});

describe('candidate storage counts all btrees including autoindexes', () => {
	for (const candidate of CANDIDATES.filter(
		(c) => c.coordinates === 'normalized',
	)) {
		test(`${candidate.id}: candidateTableBytes includes sqlite_autoindex_* btrees`, () => {
			const { db, store } = fresh(candidate);
			// Enough rows to allocate index pages, including the UNIQUE autoindexes.
			const facts: Fact[] = [];
			for (let i = 0; i < 200; i += 1) {
				facts.push(rowPresent(i.toString(36).padStart(24, '0'), i + 1));
			}
			store.installFacts(facts);
			// The table-only accounting the audit flagged as undercounting.
			const tableOnly = (
				db
					.prepare(
						"SELECT COALESCE(SUM(pgsize),0) AS b FROM dbstat WHERE name IN ('facts','row_facts','value_facts','coordinates','pending_intents','parked_work','row_documents','retry_ledger')",
					)
					.get() as { b: number }
			).b;
			// The autoindex btrees that table-only accounting omits.
			const autoindexBytes = (
				db
					.prepare(
						"SELECT COALESCE(SUM(pgsize),0) AS b FROM dbstat WHERE name LIKE 'sqlite_autoindex_%'",
					)
					.get() as { b: number }
			).b;
			expect(autoindexBytes).toBeGreaterThan(0);
			// candidateTableBytes must include those autoindexes, so it exceeds the
			// table-only sum by at least the autoindex bytes.
			expect(store.candidateTableBytes()).toBeGreaterThanOrEqual(
				tableOnly + autoindexBytes,
			);
		});
	}
});

describe('split normalized: a fact table rejects the wrong coordinate kind', () => {
	test('row_facts referencing a value coordinate is refused', () => {
		const candidate = CANDIDATES.find(
			(c) => c.relation === 'split' && c.coordinates === 'normalized',
		);
		expect(candidate).toBeDefined();
		if (!candidate) throw new Error('missing split-normalized candidate');
		const { db, store } = fresh(candidate);
		store.installFacts([
			{
				address: valueAddr('settingx'),
				sequence: 1,
				presence: 'present',
				content: 1,
			},
		]);
		const valueCoord = (
			db
				.prepare(
					"SELECT coordinate_id AS id FROM coordinates WHERE kind='value' AND local_key='settingx'",
				)
				.get() as { id: number }
		).id;
		expect(() =>
			db.run(
				'INSERT INTO row_facts (coordinate_id,row_id,present,payload,sequence) VALUES (?,?,?,?,?)',
				[valueCoord, ID_A, 1, '{}', 999],
			),
		).toThrow();
	});
});
