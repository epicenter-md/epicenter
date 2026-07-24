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
	type Change,
	type ExchangeRequest,
	type ExchangeResponse,
	foldChange,
	type Record as SyncRecord,
} from '../protocol/index.js';
import { openReplica } from './replica.js';

const KEY = 'so.epicenter.notes.rows';
const VALUE_KEY = 'so.epicenter.settings.theme';
const ROW_ID = 'abc123def456ghi789jkl012';
const DEPLOYMENT = 'https://example.com/';
const PRINCIPAL = 'principal-a';

function addressOf(value: Change | SyncRecord): string {
	return 'rowId' in value
		? `row\0${value.key}\0${value.rowId}`
		: `value\0${value.key}`;
}

function createScriptedAuthority(pageSize = 64) {
	let nextSequence = 1;
	let appliedChanges = 0;
	let conflicts = 0;
	const state = new Map<string, SyncRecord>();
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
			} else if (request.batch.digest !== batchDigest(request.batch.changes)) {
				conflicts += 1;
				return { refusal: 'batch-conflict' };
			} else {
				for (const change of request.batch.changes) {
					const address = addressOf(change);
					const folded = foldChange(state.get(address), change, nextSequence);
					if (folded.kind === 'applied') {
						state.set(address, structuredClone(folded.record));
						nextSequence += 1;
						appliedChanges += 1;
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
					record.changedSequence > position &&
					record.changedSequence <= through,
			)
			.sort((left, right) => left.changedSequence - right.changedSequence);
		const records = eligible
			.slice(0, pageSize)
			.map((record) => structuredClone(record));
		const next =
			eligible.length > pageSize
				? { through, position: records.at(-1)?.changedSequence ?? position }
				: null;
		return {
			...(receipt === undefined ? {} : { receipt }),
			through,
			records,
			next,
		};
	}

	return {
		exchange,
		submit(change: Change) {
			const folded = foldChange(
				state.get(addressOf(change)),
				change,
				nextSequence,
			);
			if (folded.kind === 'applied') {
				state.set(addressOf(change), structuredClone(folded.record));
				nextSequence += 1;
				appliedChanges += 1;
			}
		},
		get appliedChanges() {
			return appliedChanges;
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
	expect(firstMetadata.formatVersion).toBe(2);
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
		return { through: 0, records: [], next: null };
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
				kind: 'create',
				key: KEY,
				rowId: ROW_ID,
				fields: { title: 'A', old: true },
			}),
		).applied,
	).toBe(true);
	expect(
		expectOk(
			replica.write({
				kind: 'update',
				key: KEY,
				rowId: ROW_ID,
				fields: { set: { title: 'B' }, unset: ['old'] },
			}),
		).applied,
	).toBe(true);
	expect(expectOk(replica.readRow(KEY, ROW_ID))).toEqual({ title: 'B' });
	expectOk(replica.write({ kind: 'set', key: VALUE_KEY, value: 'dark' }));
	expect(expectOk(replica.readValue(VALUE_KEY))).toBe('dark');
	database.close();
});

test('lost batch response retries exact bytes and authority applies once', async () => {
	const { database, replica } = setup();
	const authority = createScriptedAuthority();
	expectOk(replica.write({ kind: 'set', key: VALUE_KEY, value: 'dark' }));
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
	expect(authority.appliedChanges).toBe(1);
	expect(expectOk(replica.readValue(VALUE_KEY))).toBe('dark');
	database.close();
});

test('multiple pending changes seal atomically and retry as one exact batch', async () => {
	const { database, replica } = setup();
	const authority = createScriptedAuthority();
	expectOk(replica.write({ kind: 'set', key: VALUE_KEY, value: 'dark' }));
	expectOk(
		replica.write({
			kind: 'create',
			key: KEY,
			rowId: ROW_ID,
			fields: { title: 'batched' },
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
	expect(firstRequest?.batch?.changes).toHaveLength(2);
	expect(retryRequest).toEqual(firstRequest);
	expect(authority.appliedChanges).toBe(2);
	expect(expectOk(replica.readValue(VALUE_KEY))).toBe('dark');
	expect(expectOk(replica.readRow(KEY, ROW_ID))).toEqual({ title: 'batched' });
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
	expectOk(replica.write({ kind: 'set', key: VALUE_KEY, value: 'first' }));
	expectOk(await replica.synchronize(authority.exchange));
	const identity = expectOk(replica.metadata()).replicaId;

	const reopened = expectOk(openReplica({ database: adapter }));
	expectOk(reopened.write({ kind: 'set', key: VALUE_KEY, value: 'second' }));
	expectOk(await reopened.synchronize(authority.exchange));
	expect(expectOk(reopened.metadata()).replicaId).toBe(identity);
	expect(authority.conflicts).toBe(0);
	expect(authority.appliedChanges).toBe(2);
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
			original.write({ kind: 'set', key: VALUE_KEY, value: 'baseline' }),
		);
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
				mintReplicaId: () => 'ssssssssssssssssssssssss',
			}),
		);
		const copiedBefore = expectOk(copied.metadata());
		expectOk(copied.write({ kind: 'set', key: VALUE_KEY, value: 'copied' }));
		expectOk(await copied.synchronize(authority.exchange));
		const copiedAfter = expectOk(copied.metadata());
		expect(copiedAfter.replicaId).not.toBe(copiedBefore.replicaId);
		expect(copiedAfter.lastAppliedAuthoritySequence).toBeGreaterThanOrEqual(
			copiedBefore.lastAppliedAuthoritySequence,
		);
		expect(authority.conflicts).toBe(1);
		expect(expectOk(copied.readValue(VALUE_KEY))).toBe('copied');
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
	authority.submit({ kind: 'set', key: VALUE_KEY, value: 'remote' });
	const failed = await replica.synchronize(authority.exchange);
	expect(expectErr(failed).name).toBe('StorageFailed');
	expect(expectOk(replica.readValue(VALUE_KEY))).toBe('remote');
	expect(expectOk(replica.metadata()).lastAppliedAuthoritySequence).toBe(0);
	expectOk(await replica.synchronize(authority.exchange));
	expect(expectOk(replica.metadata()).lastAppliedAuthoritySequence).toBe(1);
	expect(expectOk(replica.readValue(VALUE_KEY))).toBe('remote');
	database.close();
});
