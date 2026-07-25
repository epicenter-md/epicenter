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
const NAMESPACE = 'so.epicenter.tests';
const ROW_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const ROW_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';

function rowAddress(rowId: string) {
	return {
		kind: 'row',
		namespace: NAMESPACE,
		tableName: 'rows',
		rowId,
	} as const;
}

function valueAddress(valueName: string) {
	return { kind: 'value', namespace: NAMESPACE, valueName } as const;
}

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
			verb: 'patch',
			address: rowAddress(ROW_A),
			set: { title: 'keep', note: 'remove' },
			unset: [],
		}),
	);
	expectOk(
		first.write({
			verb: 'patch',
			address: rowAddress(ROW_B),
			set: { title: 'offline' },
			unset: [],
		}),
	);
	expectOk(
		first.write({
			verb: 'set',
			address: valueAddress('value'),
			content: 'first',
		}),
	);
	expectOk(await first.synchronize(authority.exchange));
	expectOk(await second.synchronize(authority.exchange));

	expectOk(
		second.write({
			verb: 'patch',
			address: rowAddress(ROW_A),
			set: { title: 'updated' },
			unset: ['note'],
		}),
	);
	expectOk(second.write({ verb: 'delete', address: rowAddress(ROW_B) }));
	expectOk(second.write({ verb: 'unset', address: valueAddress('value') }));
	expectOk(await second.synchronize(authority.exchange));

	expectOk(
		first.write({
			verb: 'patch',
			address: rowAddress(ROW_B),
			set: { title: 'stale-live' },
			unset: [],
		}),
	);
	expectOk(await first.synchronize(authority.exchange));
	expect(expectOk(first.readRow(rowAddress(ROW_A)))).toEqual({
		title: 'updated',
	});
	expect(expectOk(first.readRow(rowAddress(ROW_B)))).toBeUndefined();
	expect(expectOk(first.readValue(valueAddress('value')))).toBeUndefined();

	expectOk(
		first.write({
			verb: 'set',
			address: valueAddress('value'),
			content: 'second',
		}),
	);
	expectOk(await first.synchronize(authority.exchange));
	expectOk(await second.synchronize(authority.exchange));
	expect(expectOk(second.readRow(rowAddress(ROW_A)))).toEqual({
		title: 'updated',
	});
	expect(expectOk(second.readRow(rowAddress(ROW_B)))).toBeUndefined();
	expect(expectOk(second.readValue(valueAddress('value')))).toBe('second');

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
		writer.write({ verb: 'set', address: valueAddress('a'), content: 1 }),
	);
	expectOk(
		writer.write({ verb: 'set', address: valueAddress('b'), content: 2 }),
	);
	expectOk(
		writer.write({ verb: 'set', address: valueAddress('c'), content: 3 }),
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
	expect(expectOk(fresh.readValue(valueAddress('a')))).toBe(1);
	expect(expectOk(fresh.readValue(valueAddress('b')))).toBe(2);
	expect(expectOk(fresh.readValue(valueAddress('c')))).toBe(3);

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
		replica.write({ verb: 'set', address: valueAddress('a'), content: 1 }),
	);
	expectOk(
		replica.write({ verb: 'set', address: valueAddress('b'), content: 2 }),
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
		expectOk(
			original.write({
				verb: 'set',
				address: valueAddress('value'),
				content: 'base',
			}),
		);
		expectOk(await original.synchronize(authority.exchange));
		copyFileSync(originalPath, copyPath);
		expectOk(
			original.write({
				verb: 'set',
				address: valueAddress('value'),
				content: 'original',
			}),
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
		expectOk(
			copied.write({
				verb: 'set',
				address: valueAddress('value'),
				content: 'copy',
			}),
		);
		expectOk(await copied.synchronize(authority.exchange));
		expect(expectOk(copied.metadata()).replicaId).not.toBe(before);
		expect(expectOk(copied.readValue(valueAddress('value')))).toBe('copy');
		expectOk(await original.synchronize(authority.exchange));
		expect(expectOk(original.readValue(valueAddress('value')))).toBe('copy');
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
		writer.write({ verb: 'set', address: valueAddress('a'), content: 1 }),
	);
	expectOk(
		writer.write({ verb: 'set', address: valueAddress('b'), content: 2 }),
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
	expect(expectOk(replica.readValue(valueAddress('a')))).toBe(1);
	expect(expectOk(replica.readValue(valueAddress('b')))).toBe(2);

	replicaDatabase.close();
	writerDatabase.close();
	authorityDatabase.close();
});
