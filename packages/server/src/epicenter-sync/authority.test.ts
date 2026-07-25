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

import { batchDigest, type Change } from '@epicenter/data/protocol';
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

function batch(seq: number, changes: Change[]) {
	return { seq, digest: batchDigest(changes), changes };
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
	raw.run('UPDATE metadata SET format_version = 99 WHERE singleton = 1');
	expect(() => openEpicenterSyncAuthority({ database })).toThrow(
		'format 99 is not supported',
	);
	expect(
		raw
			.query<{ format_version: number }, []>(
				'SELECT format_version FROM metadata',
			)
			.get()?.format_version,
	).toBe(99);
	raw.close();
});

test('exact retry returns one receipt while fork, old batch, and gap conflict', () => {
	const { raw, authority } = setup();
	const first = batch(1, [{ kind: 'set', address: VALUE_ADDRESS, value: 1 }]);
	const accepted = authority.exchange({
		replicaId: REPLICA,
		after: 0,
		batch: first,
	});
	expect(
		authority.exchange({ replicaId: REPLICA, after: 0, batch: first }),
	).toEqual(accepted);
	const fork = batch(1, [{ kind: 'set', address: VALUE_ADDRESS, value: 2 }]);
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
					kind: 'set',
					address: { ...VALUE_ADDRESS, valueName: 'other' },
					value: 3,
				},
			]),
		}),
	).toEqual({ refusal: 'batch-conflict' });
	expect(
		raw
			.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM value_facts')
			.get()?.count,
	).toBe(1);
	raw.close();
});

test('fixed-through pages are ordered, bounded, and continue from position', () => {
	const { raw, authority } = setup({ pageSize: 1 });
	const changes: Change[] = [
		{ kind: 'set', address: { ...VALUE_ADDRESS, valueName: 'a' }, value: 1 },
		{ kind: 'set', address: { ...VALUE_ADDRESS, valueName: 'b' }, value: 2 },
		{ kind: 'set', address: { ...VALUE_ADDRESS, valueName: 'c' }, value: 3 },
	];
	const first = authority.exchange({
		replicaId: REPLICA,
		after: 0,
		batch: batch(1, changes),
	});
	if ('refusal' in first) throw new Error(first.refusal);
	expect(first.records).toHaveLength(1);
	expect(first.through).toBe(3);
	expect(first.next).not.toBeNull();
	const second = authority.exchange({
		replicaId: REPLICA,
		after: 0,
		cursor: first.next ?? undefined,
	});
	if ('refusal' in second) throw new Error(second.refusal);
	expect(second.through).toBe(first.through);
	expect(second.records[0]?.changedSequence).toBe(2);
	raw.close();
});

test('record replaced above through waits for the next exchange without skipping peers', () => {
	const { raw, authority } = setup({ pageSize: 1 });
	const first = authority.exchange({
		replicaId: REPLICA,
		after: 0,
		batch: batch(1, [
			{
				kind: 'set',
				address: { ...VALUE_ADDRESS, valueName: 'a' },
				value: 'a1',
			},
			{
				kind: 'set',
				address: { ...VALUE_ADDRESS, valueName: 'b' },
				value: 'b1',
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
				kind: 'set',
				address: { ...VALUE_ADDRESS, valueName: 'a' },
				value: 'a2',
			},
		]),
	});
	const remainder = authority.exchange({
		replicaId: REPLICA,
		after: 0,
		cursor: first.next,
	});
	if ('refusal' in remainder) throw new Error(remainder.refusal);
	expect(remainder.records.map((record) => record.address)).toEqual([
		{ ...VALUE_ADDRESS, valueName: 'b' },
	]);
	const next = authority.exchange({ replicaId: REPLICA, after: first.through });
	if ('refusal' in next) throw new Error(next.refusal);
	expect(next.records).toEqual([
		{
			kind: 'value',
			address: { ...VALUE_ADDRESS, valueName: 'a' },
			changedSequence: 3,
			value: 'a2',
		},
	]);
	raw.close();
});

test('terminal row deletion removes document updates in the acceptance transaction', () => {
	const { raw, authority } = setup();
	const create = batch(1, [
		{ kind: 'create', address: ROW_ADDRESS, fields: { title: 'live' } },
	]);
	authority.exchange({ replicaId: REPLICA, after: 0, batch: create });
	raw.run('INSERT INTO document_updates VALUES (?, ?, ?, 1, ?)', [
		NAMESPACE,
		ROW_ADDRESS.tableName,
		ROW_ADDRESS.rowId,
		new Uint8Array([1]),
	]);
	const remove = batch(2, [{ kind: 'delete', address: ROW_ADDRESS }]);
	authority.exchange({ replicaId: REPLICA, after: 1, batch: remove });
	expect(
		raw
			.query<{ count: number }, []>(
				'SELECT COUNT(*) AS count FROM document_updates',
			)
			.get()?.count,
	).toBe(0);
	expect(
		raw.query<{ presence: string }, []>('SELECT presence FROM row_facts').get()
			?.presence,
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
				kind: 'create',
				address: sharedRowAddress,
				fields: { title: 'row' },
			},
			{ kind: 'set', address: sharedValueAddress, value: 'value' },
		]),
	});
	if ('refusal' in response) throw new Error(response.refusal);

	expect(response.records).toEqual([
		{
			kind: 'row',
			address: sharedRowAddress,
			changedSequence: 1,
			fields: { title: 'row' },
		},
		{
			kind: 'value',
			address: sharedValueAddress,
			changedSequence: 2,
			value: 'value',
		},
	]);
	expect(
		raw
			.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM row_facts')
			.get()?.count,
	).toBe(1);
	expect(
		raw
			.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM value_facts')
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
			{ kind: 'set', address: VALUE_ADDRESS, value: 'blocked' },
		]),
	});
	expect(response).toEqual({ refusal: 'storage-limit' });
	expect(
		raw
			.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM replicas')
			.get()?.count,
	).toBe(0);
	expect(
		raw
			.query<{ count: number }, []>(
				`SELECT COUNT(*) AS count FROM (
					SELECT changed_sequence FROM row_facts
					UNION ALL
					SELECT changed_sequence FROM value_facts
				)`,
			)
			.get()?.count,
	).toBe(0);
	expect(
		raw
			.query<{ next_sequence: number }, []>(
				'SELECT next_sequence FROM metadata',
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
				...batch(1, [{ kind: 'set', address: VALUE_ADDRESS, value: 1 }]),
				digest: '0'.repeat(64),
			},
		}),
	).toThrow('Batch digest does not match its changes');
	expect(
		raw
			.query<{ count: number }, []>(
				`SELECT COUNT(*) AS count FROM (
					SELECT changed_sequence FROM row_facts
					UNION ALL
					SELECT changed_sequence FROM value_facts
				)`,
			)
			.get()?.count,
	).toBe(0);
	raw.close();
});
