/**
 * Epicenter Sync SQLite Authority Tests
 *
 * Verifies the authority's physical format, single-receipt discipline,
 * fixed-through paging, terminal deletion cleanup, and storage wall rollback.
 *
 * Key behaviors:
 * - Fresh stores initialize once and unknown formats are refused
 * - Exact retries reuse receipts while forks and gaps mutate nothing
 * - Pages retain one through boundary and row deletion removes documents
 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';

import { batchDigest, type Intent } from '@epicenter/data/protocol';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';

import {
	AUTHORITY_STORAGE_BYTE_CEILING,
	openEpicenterSyncAuthority,
} from './authority.js';

const REPLICA = 'rrrrrrrrrrrrrrrrrrrrrrrr';
const NAMESPACE = 'so.epicenter.tests';
const ROW_ADDRESS = {
	kind: 'row',
	namespace: NAMESPACE,
	tableName: 'rows',
	rowId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
} as const;
const VALUE_ADDRESS = {
	kind: 'value',
	namespace: NAMESPACE,
	valueName: 'value',
} as const;

function batch(seq: number, intents: Intent[]) {
	return { seq, digest: batchDigest(intents), intents };
}

function setup(options: { pageSize?: number; size?: () => number } = {}) {
	const raw = new Database(':memory:');
	const database = createBunSqliteAdapter(raw);
	const authority = openEpicenterSyncAuthority({
		database,
		pageSize: options.pageSize,
		readDatabaseSize: options.size,
	});
	return { raw, database, authority };
}

test('fresh schema reopens and an unknown format is refused without rewrite', () => {
	const { raw, database } = setup();
	expect(() => openEpicenterSyncAuthority({ database })).not.toThrow();
	raw.run(
		'UPDATE main._authority_metadata SET format_version = 99 WHERE singleton = 1',
	);
	expect(() => openEpicenterSyncAuthority({ database })).toThrow(
		'format 99 is not supported',
	);
	expect(
		raw
			.query<{ format_version: number }, []>(
				'SELECT format_version FROM main._authority_metadata',
			)
			.get()?.format_version,
	).toBe(99);
	raw.close();
});

test('exact retry returns one receipt while fork, old batch, and gap conflict', () => {
	const { raw, authority } = setup();
	const first = batch(1, [{ verb: 'set', address: VALUE_ADDRESS, content: 1 }]);
	const accepted = authority.exchange({
		replicaId: REPLICA,
		after: 0,
		batch: first,
	});
	expect(
		authority.exchange({ replicaId: REPLICA, after: 0, batch: first }),
	).toEqual(accepted);
	const fork = batch(1, [{ verb: 'set', address: VALUE_ADDRESS, content: 2 }]);
	expect(
		authority.exchange({ replicaId: REPLICA, after: 0, batch: fork }),
	).toEqual({
		refusal: 'batch-conflict',
	});
	expect(
		authority.exchange({
			replicaId: REPLICA,
			after: 0,
			batch: batch(3, [
				{
					verb: 'set',
					address: { ...VALUE_ADDRESS, valueName: 'other' },
					content: 3,
				},
			]),
		}),
	).toEqual({ refusal: 'batch-conflict' });
	expect(
		raw
			.query<{ count: number }, []>(
				'SELECT COUNT(*) AS count FROM main._authority_value_facts',
			)
			.get()?.count,
	).toBe(1);
	raw.close();
});

test('fixed-through pages are ordered, bounded, and continue from position', () => {
	const { raw, authority } = setup({ pageSize: 1 });
	const intents: Intent[] = [
		{ verb: 'set', address: { ...VALUE_ADDRESS, valueName: 'a' }, content: 1 },
		{ verb: 'set', address: { ...VALUE_ADDRESS, valueName: 'b' }, content: 2 },
		{ verb: 'set', address: { ...VALUE_ADDRESS, valueName: 'c' }, content: 3 },
	];
	const first = authority.exchange({
		replicaId: REPLICA,
		after: 0,
		batch: batch(1, intents),
	});
	if ('refusal' in first) throw new Error(first.refusal);
	expect(first.facts).toHaveLength(1);
	expect(first.through).toBe(3);
	expect(first.next).not.toBeNull();
	const second = authority.exchange({
		replicaId: REPLICA,
		after: 0,
		cursor: first.next ?? undefined,
	});
	if ('refusal' in second) throw new Error(second.refusal);
	expect(second.through).toBe(first.through);
	expect(second.facts[0]?.authoritySequence).toBe(2);
	raw.close();
});

test('record replaced above through waits for the next exchange without skipping peers', () => {
	const { raw, authority } = setup({ pageSize: 1 });
	const first = authority.exchange({
		replicaId: REPLICA,
		after: 0,
		batch: batch(1, [
			{
				verb: 'set',
				address: { ...VALUE_ADDRESS, valueName: 'a' },
				content: 'a1',
			},
			{
				verb: 'set',
				address: { ...VALUE_ADDRESS, valueName: 'b' },
				content: 'b1',
			},
		]),
	});
	if ('refusal' in first || first.next === null) {
		throw new Error('Expected a first page');
	}
	authority.exchange({
		replicaId: REPLICA,
		after: 0,
		batch: batch(2, [
			{
				verb: 'set',
				address: { ...VALUE_ADDRESS, valueName: 'a' },
				content: 'a2',
			},
		]),
	});
	const remainder = authority.exchange({
		replicaId: REPLICA,
		after: 0,
		cursor: first.next,
	});
	if ('refusal' in remainder) throw new Error(remainder.refusal);
	expect(remainder.facts.map((record) => record.address)).toEqual([
		{ ...VALUE_ADDRESS, valueName: 'b' },
	]);
	const next = authority.exchange({ replicaId: REPLICA, after: first.through });
	if ('refusal' in next) throw new Error(next.refusal);
	expect(next.facts).toEqual([
		{
			presence: 'present',
			address: { ...VALUE_ADDRESS, valueName: 'a' },
			authoritySequence: 3,
			content: 'a2',
		},
	]);
	raw.close();
});

test('terminal row deletion removes document updates in the acceptance transaction', () => {
	const { raw, authority } = setup();
	const create = batch(1, [
		{ verb: 'patch', address: ROW_ADDRESS, set: { title: 'live' }, unset: [] },
	]);
	authority.exchange({ replicaId: REPLICA, after: 0, batch: create });
	raw.run('INSERT INTO document_updates VALUES (?, ?, ?, 1, ?)', [
		NAMESPACE,
		ROW_ADDRESS.tableName,
		ROW_ADDRESS.rowId,
		new Uint8Array([1]),
	]);
	const remove = batch(2, [{ verb: 'delete', address: ROW_ADDRESS }]);
	authority.exchange({ replicaId: REPLICA, after: 1, batch: remove });
	expect(
		raw
			.query<{ count: number }, []>(
				'SELECT COUNT(*) AS count FROM document_updates',
			)
			.get()?.count,
	).toBe(0);
	expect(
		raw
			.query<{ presence: string }, []>(
				'SELECT presence FROM main._authority_row_facts',
			)
			.get()?.presence,
	).toBe('absent');
	raw.close();
});

test('row table and value with the same local name occupy separate facts', () => {
	const { raw, authority } = setup();
	const sharedValueAddress = { ...VALUE_ADDRESS, valueName: 'shared' } as const;
	const sharedRowAddress = { ...ROW_ADDRESS, tableName: 'shared' } as const;
	const response = authority.exchange({
		replicaId: REPLICA,
		after: 0,
		batch: batch(1, [
			{
				verb: 'patch',
				address: sharedRowAddress,
				set: { title: 'row' },
				unset: [],
			},
			{ verb: 'set', address: sharedValueAddress, content: 'value' },
		]),
	});
	if ('refusal' in response) throw new Error(response.refusal);

	expect(response.facts).toEqual([
		{
			presence: 'present',
			address: sharedRowAddress,
			authoritySequence: 1,
			fields: { title: 'row' },
		},
		{
			presence: 'present',
			address: sharedValueAddress,
			authoritySequence: 2,
			content: 'value',
		},
	]);
	expect(
		raw
			.query<{ count: number }, []>(
				'SELECT COUNT(*) AS count FROM main._authority_row_facts',
			)
			.get()?.count,
	).toBe(1);
	expect(
		raw
			.query<{ count: number }, []>(
				'SELECT COUNT(*) AS count FROM main._authority_value_facts',
			)
			.get()?.count,
	).toBe(1);
	raw.close();
});

test('storage-limit refusal leaves no replica, fact, or sequence allocation', () => {
	const { raw, authority } = setup({
		size: () => AUTHORITY_STORAGE_BYTE_CEILING,
	});
	const response = authority.exchange({
		replicaId: REPLICA,
		after: 0,
		batch: batch(1, [
			{ verb: 'set', address: VALUE_ADDRESS, content: 'blocked' },
		]),
	});
	expect(response).toEqual({ refusal: 'storage-limit' });
	expect(
		raw
			.query<{ count: number }, []>(
				'SELECT COUNT(*) AS count FROM main._authority_replicas',
			)
			.get()?.count,
	).toBe(0);
	expect(
		raw
			.query<{ count: number }, []>(
				`SELECT COUNT(*) AS count FROM (
					SELECT authority_sequence FROM main._authority_row_facts
					UNION ALL
					SELECT authority_sequence FROM main._authority_value_facts
				)`,
			)
			.get()?.count,
	).toBe(0);
	expect(
		raw
			.query<{ next_sequence: number }, []>(
				'SELECT next_sequence FROM main._authority_metadata',
			)
			.get()?.next_sequence,
	).toBe(1);
	raw.close();
});

test('invalid request shape and mismatched digest throw without mutation', () => {
	const { raw, authority } = setup();
	expect(() => authority.exchange({ replicaId: REPLICA, after: -1 })).toThrow(
		'Invalid data protocol exchange request',
	);
	expect(() =>
		authority.exchange({
			replicaId: REPLICA,
			after: 0,
			batch: {
				...batch(1, [{ verb: 'set', address: VALUE_ADDRESS, content: 1 }]),
				digest: '0'.repeat(64),
			},
		}),
	).toThrow('Batch digest does not match its intents');
	expect(
		raw
			.query<{ count: number }, []>(
				`SELECT COUNT(*) AS count FROM (
					SELECT authority_sequence FROM main._authority_row_facts
					UNION ALL
					SELECT authority_sequence FROM main._authority_value_facts
				)`,
			)
			.get()?.count,
	).toBe(0);
	raw.close();
});

test('a store holding a previous format is refused, not rebuilt beside it', () => {
	// Same defect the replica had. Matching only the relations this format knows
	// about reads an older store as empty and creates a second live schema next
	// to it, orphaning the real data with no error anywhere.
	const raw = new Database(':memory:');
	const database = createBunSqliteAdapter(raw);
	raw.run('CREATE TABLE state (qualified_key TEXT PRIMARY KEY, value TEXT)');

	expect(() => openEpicenterSyncAuthority({ database })).toThrow(
		'not the current format',
	);
	expect(
		raw
			.query<{ name: string }, []>(
				`SELECT name FROM main.sqlite_schema
				 WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
			)
			.all()
			.map((row) => row.name),
	).toEqual(['state']);
	raw.close();
});
