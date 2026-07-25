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
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { expectErr, expectOk } from 'wellcrafted/testing';

import {
	batchDigest,
	type ExchangeRequest,
	type ExchangeResponse,
	type Fact,
	foldIntent,
	type Intent,
	parseFact,
} from '../protocol/index.js';
import { openReplica } from './replica.js';

const ROW_ID = 'abc123def456ghi789jkl012';
const ROW_ADDRESS = {
	kind: 'row',
	namespace: 'so.epicenter.notes',
	tableName: 'rows',
	rowId: ROW_ID,
} as const;
const VALUE_ADDRESS = {
	kind: 'value',
	namespace: 'so.epicenter.settings',
	valueName: 'theme',
} as const;
const DEPLOYMENT = 'https://example.com/';
const PRINCIPAL = 'principal-a';

function addressOf(value: Intent | Fact): string {
	return JSON.stringify(value.address);
}

function createScriptedAuthority(pageSize = 64) {
	let nextSequence = 1;
	let appliedIntents = 0;
	let conflicts = 0;
	const state = new Map<string, Fact>();
	const receipts = new Map<
		string,
		{ seq: number; digest: string; appliedThrough: number }
	>();

	function exchange(request: ExchangeRequest): ExchangeResponse {
		let receipt:
			| { seq: number; digest: string; appliedThrough: number }
			| undefined;
		if (request.batch !== undefined) {
			const prior = receipts.get(request.replicaId);
			if (prior?.seq === request.batch.seq) {
				if (prior.digest !== request.batch.digest) {
					conflicts += 1;
					return { refusal: 'batch-conflict' };
				}
				receipt = prior;
			} else if (request.batch.seq !== (prior?.seq ?? 0) + 1) {
				conflicts += 1;
				return { refusal: 'batch-conflict' };
			} else if (request.batch.digest !== batchDigest(request.batch.intents)) {
				conflicts += 1;
				return { refusal: 'batch-conflict' };
			} else {
				for (const change of request.batch.intents) {
					const address = addressOf(change);
					const folded = foldIntent(state.get(address), change, nextSequence);
					if (folded.kind === 'applied') {
						state.set(address, structuredClone(folded.fact));
						nextSequence += 1;
						appliedIntents += 1;
					}
				}
				receipt = {
					seq: request.batch.seq,
					digest: request.batch.digest,
					appliedThrough: nextSequence - 1,
				};
				receipts.set(request.replicaId, receipt);
			}
		}

		const through = request.cursor?.through ?? nextSequence - 1;
		const position = request.cursor?.position ?? request.after;
		const eligible = [...state.values()]
			.filter(
				(record) =>
					record.authoritySequence > position &&
					record.authoritySequence <= through,
			)
			.sort((left, right) => left.authoritySequence - right.authoritySequence);
		const facts = eligible
			.slice(0, pageSize)
			.map((fact) => structuredClone(fact));
		const next =
			eligible.length > pageSize
				? { through, position: facts.at(-1)?.authoritySequence ?? position }
				: null;
		return {
			...(receipt === undefined ? {} : { receipt }),
			through,
			facts,
			next,
		};
	}

	return {
		exchange,
		submit(intent: Intent) {
			const folded = foldIntent(
				state.get(addressOf(intent)),
				intent,
				nextSequence,
			);
			if (folded.kind === 'applied') {
				state.set(addressOf(intent), structuredClone(folded.fact));
				nextSequence += 1;
				appliedIntents += 1;
			}
		},
		get appliedIntents() {
			return appliedIntents;
		},
		get conflicts() {
			return conflicts;
		},
	};
}

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
	expect(firstMetadata.replicaId).toMatch(/^[a-z0-9]{24}$/);
	expect(firstMetadata.formatVersion).toBe(6);
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

test('local writes expose the optimistic overlay before authority receipt', () => {
	const { database, replica } = setup();
	expect(
		expectOk(
			replica.write({
				verb: 'patch',
				address: ROW_ADDRESS,
				set: { title: 'A', old: true },
				unset: [],
			}),
		).applied,
	).toBe(true);
	expect(
		expectOk(
			replica.write({
				verb: 'patch',
				address: ROW_ADDRESS,
				set: { title: 'B' },
				unset: ['old'],
			}),
		).applied,
	).toBe(true);
	expect(expectOk(replica.readRow(ROW_ADDRESS))).toEqual({ title: 'B' });
	expectOk(
		replica.write({ verb: 'set', address: VALUE_ADDRESS, content: 'dark' }),
	);
	expect(expectOk(replica.readValue(VALUE_ADDRESS))).toBe('dark');
	database.close();
});

test('lost batch response retries exact bytes and authority applies once', async () => {
	const { database, replica } = setup();
	const authority = createScriptedAuthority();
	expectOk(
		replica.write({ verb: 'set', address: VALUE_ADDRESS, content: 'dark' }),
	);
	let loseFirstResponse = true;
	const first = await replica.synchronize((request) => {
		const response = authority.exchange(request);
		if (loseFirstResponse) {
			loseFirstResponse = false;
			throw new Error('response lost');
		}
		return response;
	});
	expect(expectErr(first).name).toBe('TransportFailed');
	expectOk(await replica.synchronize(authority.exchange));
	expect(authority.appliedIntents).toBe(1);
	expect(expectOk(replica.readValue(VALUE_ADDRESS))).toBe('dark');
	database.close();
});

test('multiple pending changes seal atomically and retry as one exact batch', async () => {
	const { database, replica } = setup();
	const authority = createScriptedAuthority();
	expectOk(
		replica.write({ verb: 'set', address: VALUE_ADDRESS, content: 'dark' }),
	);
	expectOk(
		replica.write({
			verb: 'patch',
			address: ROW_ADDRESS,
			set: { title: 'batched' },
			unset: [],
		}),
	);
	let firstRequest: ExchangeRequest | undefined;
	const lost = await replica.synchronize((request) => {
		firstRequest = structuredClone(request);
		authority.exchange(request);
		throw new Error('response lost');
	});
	expect(expectErr(lost).name).toBe('TransportFailed');
	let retryRequest: ExchangeRequest | undefined;
	expectOk(
		await replica.synchronize((request) => {
			retryRequest = structuredClone(request);
			return authority.exchange(request);
		}),
	);
	expect(firstRequest?.batch?.intents).toHaveLength(2);
	expect(retryRequest).toEqual(firstRequest);
	expect(authority.appliedIntents).toBe(2);
	expect(expectOk(replica.readValue(VALUE_ADDRESS))).toBe('dark');
	expect(expectOk(replica.readRow(ROW_ADDRESS))).toEqual({ title: 'batched' });
	database.close();
});

test('drained reopen preserves the next batch sequence and replica identity', async () => {
	const database = new Database(':memory:');
	const adapter = createBunSqliteAdapter(database);
	const replica = expectOk(openReplica({ database: adapter }));
	expectOk(
		replica.attach({ deploymentId: DEPLOYMENT, principalId: PRINCIPAL }),
	);
	const authority = createScriptedAuthority();
	expectOk(
		replica.write({ verb: 'set', address: VALUE_ADDRESS, content: 'first' }),
	);
	expectOk(await replica.synchronize(authority.exchange));
	const identity = expectOk(replica.metadata()).replicaId;

	const reopened = expectOk(openReplica({ database: adapter }));
	expectOk(
		reopened.write({ verb: 'set', address: VALUE_ADDRESS, content: 'second' }),
	);
	expectOk(await reopened.synchronize(authority.exchange));
	expect(expectOk(reopened.metadata()).replicaId).toBe(identity);
	expect(authority.conflicts).toBe(0);
	expect(authority.appliedIntents).toBe(2);
	database.close();
});

test('copied replica conflict remints identity, preserves cursor, and converges', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'epicenter-data-fork-'));
	const originalPath = join(directory, 'original.sqlite');
	const copyPath = join(directory, 'copy.sqlite');
	try {
		const originalDatabase = new Database(originalPath);
		const original = setup(originalDatabase).replica;
		const authority = createScriptedAuthority();
		expectOk(
			original.write({
				verb: 'set',
				address: VALUE_ADDRESS,
				content: 'baseline',
			}),
		);
		expectOk(await original.synchronize(authority.exchange));
		copyFileSync(originalPath, copyPath);

		expectOk(
			original.write({
				verb: 'set',
				address: VALUE_ADDRESS,
				content: 'original',
			}),
		);
		expectOk(await original.synchronize(authority.exchange));

		const copyDatabase = new Database(copyPath);
		const copied = expectOk(
			openReplica({
				database: createBunSqliteAdapter(copyDatabase),
				mintReplicaId: () => 'ssssssssssssssssssssssss',
			}),
		);
		const copiedBefore = expectOk(copied.metadata());
		expectOk(
			copied.write({ verb: 'set', address: VALUE_ADDRESS, content: 'copied' }),
		);
		expectOk(await copied.synchronize(authority.exchange));
		const copiedAfter = expectOk(copied.metadata());
		expect(copiedAfter.replicaId).not.toBe(copiedBefore.replicaId);
		expect(copiedAfter.lastAppliedAuthoritySequence).toBeGreaterThanOrEqual(
			copiedBefore.lastAppliedAuthoritySequence,
		);
		expect(authority.conflicts).toBe(1);
		expect(expectOk(copied.readValue(VALUE_ADDRESS))).toBe('copied');
		copyDatabase.close();
		originalDatabase.close();
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test('crash after page install but before cursor advance re-exchanges idempotently', async () => {
	const database = new Database(':memory:');
	const base = createBunSqliteAdapter(database);
	let failCursorAdvance = true;
	const crashing = {
		...base,
		run(
			sql: string,
			parameters?: readonly (string | number | null | Uint8Array)[],
		) {
			if (
				failCursorAdvance &&
				sql.includes('last_applied_authority_sequence = ?')
			) {
				failCursorAdvance = false;
				throw new Error('simulated crash');
			}
			base.run(sql, parameters);
		},
	};
	const replica = expectOk(openReplica({ database: crashing }));
	expectOk(
		replica.attach({ deploymentId: DEPLOYMENT, principalId: PRINCIPAL }),
	);
	const authority = createScriptedAuthority(1);
	authority.submit({ verb: 'set', address: VALUE_ADDRESS, content: 'remote' });
	const failed = await replica.synchronize(authority.exchange);
	expect(expectErr(failed).name).toBe('StorageFailed');
	expect(expectOk(replica.readValue(VALUE_ADDRESS))).toBe('remote');
	expect(expectOk(replica.metadata()).lastAppliedAuthoritySequence).toBe(0);
	expectOk(await replica.synchronize(authority.exchange));
	expect(expectOk(replica.metadata()).lastAppliedAuthoritySequence).toBe(1);
	expect(expectOk(replica.readValue(VALUE_ADDRESS))).toBe('remote');
	database.close();
});

test('a local optimistic fact sits at sequence 0 and is refused as an authority fact', () => {
	// The boundary defect G describes. A replica's own write is a `LocalFact`
	// whose authority sequence is 0, meaning "not assigned yet". That state is
	// legal locally and illegal on the wire, so the two domains stay separate
	// without relaxing authority admission to accommodate the local one.
	const { database, replica } = setup();
	expectOk(replica.write({ verb: 'set', address: VALUE_ADDRESS, content: 1 }));

	const stored = database
		.query<{ authority_sequence: number }, []>(
			'SELECT authority_sequence FROM main._replica_value_facts',
		)
		.get();
	expect(stored?.authority_sequence).toBe(0);

	// The same fact, offered as an authority fact, is refused.
	expect(
		expectErr(
			parseFact({
				presence: 'present',
				address: VALUE_ADDRESS,
				authoritySequence: 0,
				content: 1,
			}),
		).name,
	).toBe('Invalid');
	// One is the smallest sequence an authority may assign.
	expectOk(
		parseFact({
			presence: 'present',
			address: VALUE_ADDRESS,
			authoritySequence: 1,
			content: 1,
		}),
	);
	database.close();
});

test('a settled exchange replaces the local zero sequence with the authority one', async () => {
	const { database, replica } = setup();
	expectOk(replica.write({ verb: 'set', address: VALUE_ADDRESS, content: 1 }));

	const authority = createScriptedAuthority();
	expectOk(await replica.synchronize(authority.exchange));

	const stored = database
		.query<{ authority_sequence: number }, []>(
			'SELECT authority_sequence FROM main._replica_value_facts',
		)
		.get();
	expect(stored?.authority_sequence).toBeGreaterThan(0);
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

test('a TEMP view cannot redirect an internal owner read', () => {
	// Internal SQL is schema-qualified, so even a same-connection TEMP view named
	// after a private relation cannot intercept it. The inspection host uses a
	// separate connection as well, which is the stronger guarantee; this pins the
	// qualification independently.
	const { database, replica } = setup();
	expectOk(
		replica.write({ verb: 'set', address: VALUE_ADDRESS, content: 'real' }),
	);

	database.run(
		`CREATE TEMP VIEW _replica_value_facts AS
		 SELECT 'so.epicenter.settings' AS namespace, 'theme' AS value_name,
		        'present' AS presence, '"hijacked"' AS content, 1 AS authority_sequence`,
	);

	expect(expectOk(replica.readValue(VALUE_ADDRESS))).toBe('real');
	database.close();
});
