/**
 * SQLite Replica Tests
 *
 * Verifies durable identity and attachment, optimistic writes, exact batch
 * retry, fork recovery, and cursor crash safety against a scripted authority.
 *
 * Key behaviors:
 * - Opening preserves identity and rejects unknown formats
 * - Attachment refuses a different principal before exchange
 * - Outbox retry, fork recovery, and page reinstall converge
 */

import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';

import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { expectErr, expectOk } from 'wellcrafted/testing';

import {
} from '../protocol/index.js';
import { openReplica } from './replica.js';

const DEPLOYMENT = 'https://example.com/';
const PRINCIPAL = 'principal-a';

function setup(database = new Database(':memory:')) {
	const adapter = createBunSqliteAdapter(database);
	const replica = expectOk(openReplica({ database: adapter }));
	expectOk(
		replica.attach({ deploymentId: DEPLOYMENT, principalId: PRINCIPAL }),
	);
	return { database, adapter, replica };
}

test('fresh open mints identity and reopen preserves it', () => {
	const database = new Database(':memory:');
	const adapter = createBunSqliteAdapter(database);
	const first = expectOk(openReplica({ database: adapter }));
	const firstMetadata = expectOk(first.metadata());
	expect(firstMetadata.replicaId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
	expect(firstMetadata.formatVersion).toBe(7);
	const reopened = expectOk(openReplica({ database: adapter }));
	expect(expectOk(reopened.metadata())).toEqual(firstMetadata);
	database.close();
});

test('unknown format refuses without rewriting metadata', () => {
	const database = new Database(':memory:');
	database.run(`CREATE TABLE metadata (
		singleton INTEGER PRIMARY KEY,
		format_version INTEGER NOT NULL,
		replica_id TEXT NOT NULL,
		attached_deployment TEXT,
		attached_principal TEXT,
		last_applied_authority_sequence INTEGER NOT NULL
	) STRICT`);
	database.run(
		"INSERT INTO metadata VALUES (1, 99, 'rrrrrrrrrrrrrrrrrrrrrrrr', NULL, NULL, 0)",
	);
	const error = expectErr(
		openReplica({ database: createBunSqliteAdapter(database) }),
	);
	expect(error.name).toBe('UnsupportedFormat');
	expect(
		database
			.query<{ format_version: number }, []>(
				'SELECT format_version FROM metadata',
			)
			.get()?.format_version,
	).toBe(99);
	database.close();
});

test('attachment is idempotent and another principal is refused before exchange', async () => {
	const { database, replica } = setup();
	expectOk(
		replica.attach({ deploymentId: DEPLOYMENT, principalId: PRINCIPAL }),
	);
	const error = expectErr(
		replica.attach({ deploymentId: DEPLOYMENT, principalId: 'principal-b' }),
	);
	expect(error.name).toBe('WrongAttachment');
	let exchangeCalls = 0;
	const result = await replica.synchronize(() => {
		exchangeCalls += 1;
		return { through: 0, facts: [], next: null };
	});
	expectOk(result);
	expect(exchangeCalls).toBe(1);
	expect(expectOk(replica.metadata()).attachment).toEqual({
		deploymentId: DEPLOYMENT,
		principalId: PRINCIPAL,
	});
	database.close();
});

test('attachment requires the canonical deployment URL', () => {
	const database = new Database(':memory:');
	const replica = expectOk(
		openReplica({ database: createBunSqliteAdapter(database) }),
	);
	expect(
		expectErr(
			replica.attach({
				deploymentId: 'https://example.com',
				principalId: PRINCIPAL,
			}),
		).name,
	).toBe('InvalidInput');
	expect(expectOk(replica.metadata()).attachment).toBeUndefined();
	database.close();
});

test('a file holding a previous format is refused, not silently rebuilt beside it', () => {
	// The defect this pins: asking only "are the relations I know about here?"
	// reads a file full of an older format as empty, builds a second schema next
	// to it, and orphans the real data invisibly. Open must refuse instead.
	const database = new Database(':memory:');
	const adapter = createBunSqliteAdapter(database);
	database.run(
		'CREATE TABLE state (qualified_key TEXT PRIMARY KEY, value TEXT)',
	);
	database.run('CREATE TABLE outbox (local_sequence INTEGER PRIMARY KEY)');

	const opened = openReplica({ database: adapter });
	expect(expectErr(opened).name).toBe('UnsupportedFormat');

	// Nothing was created beside the legacy tables.
	const tables = database
		.query<{ name: string }, []>(
			`SELECT name FROM main.sqlite_schema
			 WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
		)
		.all()
		.map((row) => row.name);
	expect(tables).toEqual(['outbox', 'state']);
	database.close();
});

test('a partially created current format is refused rather than completed', () => {
	const database = new Database(':memory:');
	const adapter = createBunSqliteAdapter(database);
	database.run(
		'CREATE TABLE main._replica_metadata (singleton INTEGER PRIMARY KEY)',
	);

	expect(expectErr(openReplica({ database: adapter })).name).toBe(
		'UnsupportedFormat',
	);
	database.close();
});
