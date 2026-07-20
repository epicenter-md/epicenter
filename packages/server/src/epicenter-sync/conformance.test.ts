/**
 * Epicenter Sync Authority and Replica Conformance Tests
 *
 * Runs the real Data SQLite replica engine against the real server authority
 * in-process to prove convergence across retries, forks, pages, and tombstones.
 *
 * Key behaviors:
 * - Rows, values, unsets, and permanent deletions converge across replicas
 * - Dropped responses, fork recovery, and page-install crashes are retry safe
 * - Fresh replicas drain the authority through bounded fixed-through pages
 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openReplica } from '@epicenter/data';
import type { ExchangeRequest } from '@epicenter/data/protocol';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { expectErr, expectOk } from 'wellcrafted/testing';

import { openEpicenterSyncAuthority } from './authority.js';

const DEPLOYMENT = 'https://example.com/';
const PRINCIPAL = 'principal-a';
const KEY = 'so.epicenter.tests.rows';
const VALUE_KEY = 'so.epicenter.tests.value';
const ROW_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const ROW_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';

function openAttachedReplica(raw: Database, replicaId: string) {
	const replica = expectOk(
		openReplica({
			database: createBunSqliteAdapter(raw),
			mintReplicaId: () => replicaId,
		}),
	);
	expectOk(
		replica.attach({ deploymentId: DEPLOYMENT, principalId: PRINCIPAL }),
	);
	return replica;
}

test('two replicas converge across row changes, deletion, value unset, and later set', async () => {
	const authorityDatabase = new Database(':memory:');
	const authority = openEpicenterSyncAuthority({
		database: createBunSqliteAdapter(authorityDatabase),
		pageSize: 1,
	});
	const firstDatabase = new Database(':memory:');
	const secondDatabase = new Database(':memory:');
	const first = openAttachedReplica(firstDatabase, 'aaaaaaaaaaaaaaaaaaaaaaa1');
	const second = openAttachedReplica(
		secondDatabase,
		'bbbbbbbbbbbbbbbbbbbbbbb2',
	);

	expectOk(
		first.write({
			kind: 'create',
			key: KEY,
			rowId: ROW_A,
			fields: { title: 'keep', note: 'remove' },
		}),
	);
	expectOk(
		first.write({
			kind: 'create',
			key: KEY,
			rowId: ROW_B,
			fields: { title: 'offline' },
		}),
	);
	expectOk(first.write({ kind: 'set', key: VALUE_KEY, value: 'first' }));
	expectOk(await first.synchronize(authority.exchange));
	expectOk(await second.synchronize(authority.exchange));

	expectOk(
		second.write({
			kind: 'update',
			key: KEY,
			rowId: ROW_A,
			fields: { set: { title: 'updated' }, unset: ['note'] },
		}),
	);
	expectOk(second.write({ kind: 'delete', key: KEY, rowId: ROW_B }));
	expectOk(second.write({ kind: 'unset', key: VALUE_KEY }));
	expectOk(await second.synchronize(authority.exchange));

	expectOk(
		first.write({
			kind: 'update',
			key: KEY,
			rowId: ROW_B,
			fields: { set: { title: 'stale-live' }, unset: [] },
		}),
	);
	expectOk(await first.synchronize(authority.exchange));
	expect(expectOk(first.readRow(KEY, ROW_A))).toEqual({ title: 'updated' });
	expect(expectOk(first.readRow(KEY, ROW_B))).toBeUndefined();
	expect(expectOk(first.readValue(VALUE_KEY))).toBeUndefined();

	expectOk(first.write({ kind: 'set', key: VALUE_KEY, value: 'second' }));
	expectOk(await first.synchronize(authority.exchange));
	expectOk(await second.synchronize(authority.exchange));
	expect(expectOk(second.readRow(KEY, ROW_A))).toEqual({ title: 'updated' });
	expect(expectOk(second.readRow(KEY, ROW_B))).toBeUndefined();
	expect(expectOk(second.readValue(VALUE_KEY))).toBe('second');

	firstDatabase.close();
	secondDatabase.close();
	authorityDatabase.close();
});

test('fresh sequence-zero replica drains full state through bounded pages', async () => {
	const authorityDatabase = new Database(':memory:');
	const authority = openEpicenterSyncAuthority({
		database: createBunSqliteAdapter(authorityDatabase),
		pageSize: 1,
	});
	const writerDatabase = new Database(':memory:');
	const writer = openAttachedReplica(
		writerDatabase,
		'wwwwwwwwwwwwwwwwwwwwwww1',
	);
	expectOk(
		writer.write({ kind: 'set', key: 'so.epicenter.tests.a', value: 1 }),
	);
	expectOk(
		writer.write({ kind: 'set', key: 'so.epicenter.tests.b', value: 2 }),
	);
	expectOk(
		writer.write({ kind: 'set', key: 'so.epicenter.tests.c', value: 3 }),
	);
	expectOk(await writer.synchronize(authority.exchange));

	const freshDatabase = new Database(':memory:');
	const fresh = openAttachedReplica(freshDatabase, 'fffffffffffffffffffffff2');
	let calls = 0;
	expectOk(
		await fresh.synchronize((request) => {
			calls += 1;
			return authority.exchange(request);
		}),
	);
	expect(calls).toBe(3);
	expect(expectOk(fresh.readValue('so.epicenter.tests.a'))).toBe(1);
	expect(expectOk(fresh.readValue('so.epicenter.tests.b'))).toBe(2);
	expect(expectOk(fresh.readValue('so.epicenter.tests.c'))).toBe(3);

	freshDatabase.close();
	writerDatabase.close();
	authorityDatabase.close();
});

test('dropped response retries the exact multi-change batch and applies it once', async () => {
	const authorityDatabase = new Database(':memory:');
	const authority = openEpicenterSyncAuthority({
		database: createBunSqliteAdapter(authorityDatabase),
	});
	const replicaDatabase = new Database(':memory:');
	const replica = openAttachedReplica(
		replicaDatabase,
		'rrrrrrrrrrrrrrrrrrrrrrr1',
	);
	expectOk(
		replica.write({ kind: 'set', key: 'so.epicenter.tests.a', value: 1 }),
	);
	expectOk(
		replica.write({ kind: 'set', key: 'so.epicenter.tests.b', value: 2 }),
	);
	let firstRequest: ExchangeRequest | undefined;
	const lost = await replica.synchronize((request) => {
		firstRequest = structuredClone(request);
		authority.exchange(request);
		throw new Error('dropped response');
	});
	expect(expectErr(lost).name).toBe('TransportFailed');
	let retryRequest: ExchangeRequest | undefined;
	expectOk(
		await replica.synchronize((request) => {
			retryRequest = structuredClone(request);
			return authority.exchange(request);
		}),
	);
	expect(retryRequest).toEqual(firstRequest);
	expect(
		authorityDatabase
			.query<{ next_sequence: number }, []>(
				'SELECT next_sequence FROM metadata',
			)
			.get()?.next_sequence,
	).toBe(3);

	replicaDatabase.close();
	authorityDatabase.close();
});

test('forked replica remints its identity, resubmits, and converges', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'epicenter-sync-fork-'));
	const originalPath = join(directory, 'original.sqlite');
	const copyPath = join(directory, 'copy.sqlite');
	const authorityDatabase = new Database(':memory:');
	try {
		const authority = openEpicenterSyncAuthority({
			database: createBunSqliteAdapter(authorityDatabase),
		});
		const originalDatabase = new Database(originalPath);
		const original = openAttachedReplica(
			originalDatabase,
			'ooooooooooooooooooooooo1',
		);
		expectOk(original.write({ kind: 'set', key: VALUE_KEY, value: 'base' }));
		expectOk(await original.synchronize(authority.exchange));
		copyFileSync(originalPath, copyPath);
		expectOk(
			original.write({ kind: 'set', key: VALUE_KEY, value: 'original' }),
		);
		expectOk(await original.synchronize(authority.exchange));

		const copyDatabase = new Database(copyPath);
		const copied = expectOk(
			openReplica({
				database: createBunSqliteAdapter(copyDatabase),
				mintReplicaId: () => 'ccccccccccccccccccccccc2',
			}),
		);
		const before = expectOk(copied.metadata()).replicaId;
		expectOk(copied.write({ kind: 'set', key: VALUE_KEY, value: 'copy' }));
		expectOk(await copied.synchronize(authority.exchange));
		expect(expectOk(copied.metadata()).replicaId).not.toBe(before);
		expect(expectOk(copied.readValue(VALUE_KEY))).toBe('copy');
		expectOk(await original.synchronize(authority.exchange));
		expect(expectOk(original.readValue(VALUE_KEY))).toBe('copy');
		copyDatabase.close();
		originalDatabase.close();
	} finally {
		authorityDatabase.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test('crash between page install and cursor advance converges on retry', async () => {
	const authorityDatabase = new Database(':memory:');
	const authority = openEpicenterSyncAuthority({
		database: createBunSqliteAdapter(authorityDatabase),
		pageSize: 1,
	});
	const writerDatabase = new Database(':memory:');
	const writer = openAttachedReplica(
		writerDatabase,
		'wwwwwwwwwwwwwwwwwwwwwww2',
	);
	expectOk(
		writer.write({ kind: 'set', key: 'so.epicenter.tests.a', value: 1 }),
	);
	expectOk(
		writer.write({ kind: 'set', key: 'so.epicenter.tests.b', value: 2 }),
	);
	expectOk(await writer.synchronize(authority.exchange));

	const replicaDatabase = new Database(':memory:');
	const base = createBunSqliteAdapter(replicaDatabase);
	let failCursorAdvance = true;
	const crashing = {
		...base,
		run(sql: string, parameters?: Parameters<typeof base.run>[1]) {
			if (
				failCursorAdvance &&
				sql.includes('last_applied_authority_sequence = ?')
			) {
				failCursorAdvance = false;
				throw new Error('simulated cursor crash');
			}
			base.run(sql, parameters);
		},
	};
	const replica = expectOk(
		openReplica({
			database: crashing,
			mintReplicaId: () => 'xxxxxxxxxxxxxxxxxxxxxxx3',
		}),
	);
	expectOk(
		replica.attach({ deploymentId: DEPLOYMENT, principalId: PRINCIPAL }),
	);
	expect(expectErr(await replica.synchronize(authority.exchange)).name).toBe(
		'StorageFailed',
	);
	expect(expectOk(replica.metadata()).lastAppliedAuthoritySequence).toBe(0);
	expectOk(await replica.synchronize(authority.exchange));
	expect(expectOk(replica.metadata()).lastAppliedAuthoritySequence).toBe(2);
	expect(expectOk(replica.readValue('so.epicenter.tests.a'))).toBe(1);
	expect(expectOk(replica.readValue('so.epicenter.tests.b'))).toBe(2);

	replicaDatabase.close();
	writerDatabase.close();
	authorityDatabase.close();
});
