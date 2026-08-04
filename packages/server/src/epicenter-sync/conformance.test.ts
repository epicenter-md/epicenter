/**
 * Epicenter sync conformance tests.
 *
 * Verifies that an ordinary row patch converges between the real replica and
 * authority implementations.
 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';

import { openReplica } from '@epicenter/data';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { expectOk } from 'wellcrafted/testing';

import { openEpicenterSyncAuthority } from './authority.js';

test('a row patch converges through the real authority', async () => {
	const authorityDatabase = new Database(':memory:');
	const authority = openEpicenterSyncAuthority({
		database: createBunSqliteAdapter(authorityDatabase),
	});
	const replicaDatabase = new Database(':memory:');
	const replica = expectOk(
		openReplica({
			database: createBunSqliteAdapter(replicaDatabase),
			mintReplicaId: () => 'aaaaaaaaaaaaaaaaaaaaaaa1',
		}),
	);
	expectOk(replica.attach({ deploymentId: 'https://example.com/', principalId: 'instance' }));
	const address = {
		namespace: 'so.epicenter.tests',
		tableName: 'rows',
		rowId: 'app',
	} as const;
	expectOk(replica.write({ verb: 'patch', address, set: { title: 'converged' }, unset: [] }));
	expectOk(await replica.synchronize(authority.exchange));
	expect(expectOk(replica.readRow(address))).toEqual({ title: 'converged' });

	replicaDatabase.close();
	authorityDatabase.close();
});
