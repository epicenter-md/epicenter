/**
 * SQLite-backed scalar V1 authority (ADR-0163).
 *
 * This module is intentionally not imported by a route or application. It is
 * the SQL realization of the pure authority in `@epicenter/data/protocol/v1`.
 * The existing relations are reused without a schema change:
 * - `accepted_batch` is the last completed submission number;
 * - `request_digest` is the private canonical request hash and never leaves
 *   this module;
 * - `receipt_sequence` is surplus under V1, so it is always written as zero
 *   and never read.
 */
import {
	type Address,
	AuthorityError,
	canonicalize,
	createAuthority,
	encodedFactBytes,
	type Fact,
	foldIntent,
	type Intent,
	parseFactsRequest,
	parseSubmissionRequest,
	type ScalarProtocolError,
	type SubmissionResponse,
	sha256Hex,
	type ValidatedLimits,
} from '@epicenter/data/protocol/v1';
import type { SqliteDatabase, SqliteRow } from '@epicenter/sqlite';
import type { Result } from 'wellcrafted/result';

import { initializeAuthoritySchema } from './authority-schema.js';

type V1AuthorityError = AuthorityError | ScalarProtocolError;

type MetadataRow = SqliteRow & { next_sequence: number };
type ReplicaRow = SqliteRow & {
	accepted_batch: number;
	request_digest: string | null;
};
type FactRow = SqliteRow & {
	fact_kind: string;
	namespace: string;
	local_key: string;
	row_id: string | null;
	presence: string;
	payload: string | null;
	authority_sequence: number;
};

const FACTS_IN_RANGE = `
	SELECT authority_sequence, 'row' AS fact_kind, namespace,
		table_name AS local_key, row_id, presence, fields AS payload
	FROM main._authority_row_facts WHERE authority_sequence > ?
	UNION ALL
	SELECT authority_sequence, 'value' AS fact_kind, namespace,
		value_name AS local_key, NULL AS row_id, presence, content AS payload
	FROM main._authority_value_facts WHERE authority_sequence > ?
	ORDER BY authority_sequence`;

function readMetadata(database: SqliteDatabase): MetadataRow {
	const row = database.all<MetadataRow>(
		'SELECT next_sequence FROM main._authority_metadata WHERE singleton = 1',
	)[0];
	if (row === undefined) throw new Error('Authority metadata is missing');
	return row;
}

function readReplica(
	database: SqliteDatabase,
	replicaId: string,
): ReplicaRow | undefined {
	return database.all<ReplicaRow>(
		`SELECT accepted_batch, request_digest
		FROM main._authority_replicas WHERE replica_id = ?`,
		[replicaId],
	)[0];
}

function factFromRow(row: FactRow): Fact {
	if (row.fact_kind === 'row') {
		if (row.row_id === null) throw new Error('Row fact is missing row id');
		const address = {
			kind: 'row' as const,
			namespace: row.namespace,
			tableName: row.local_key,
			rowId: row.row_id,
		};
		return row.presence === 'absent'
			? { address, sequence: row.authority_sequence, presence: 'absent' }
			: {
					address,
					sequence: row.authority_sequence,
					presence: 'present',
					fields: JSON.parse(row.payload ?? 'null'),
				};
	}
	const address = {
		kind: 'value' as const,
		namespace: row.namespace,
		valueName: row.local_key,
	};
	return row.presence === 'absent'
		? { address, sequence: row.authority_sequence, presence: 'absent' }
		: {
				address,
				sequence: row.authority_sequence,
				presence: 'present',
				content: JSON.parse(row.payload ?? 'null'),
			};
}

function readFact(
	database: SqliteDatabase,
	address: Address,
): Fact | undefined {
	const rows =
		address.kind === 'row'
			? database.all<FactRow>(
					`SELECT 'row' AS fact_kind, namespace, table_name AS local_key,
						row_id, presence, fields AS payload, authority_sequence
					FROM main._authority_row_facts
					WHERE namespace = ? AND table_name = ? AND row_id = ?`,
					[address.namespace, address.tableName, address.rowId],
				)
			: database.all<FactRow>(
					`SELECT 'value' AS fact_kind, namespace, value_name AS local_key,
						NULL AS row_id, presence, content AS payload, authority_sequence
					FROM main._authority_value_facts
					WHERE namespace = ? AND value_name = ?`,
					[address.namespace, address.valueName],
				);
	const row = rows[0];
	return row === undefined ? undefined : factFromRow(row);
}

function storeFact(database: SqliteDatabase, fact: Fact): void {
	if (fact.address.kind === 'row') {
		database.run(
			`INSERT INTO main._authority_row_facts
				(namespace, table_name, row_id, presence, fields, authority_sequence)
			VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT (namespace, table_name, row_id) DO UPDATE SET
				presence = excluded.presence, fields = excluded.fields,
				authority_sequence = excluded.authority_sequence`,
			[
				fact.address.namespace,
				fact.address.tableName,
				fact.address.rowId,
				fact.presence,
				'fields' in fact ? JSON.stringify(fact.fields) : null,
				fact.sequence,
			],
		);
		return;
	}
	database.run(
		`INSERT INTO main._authority_value_facts
				(namespace, value_name, presence, content, authority_sequence)
			VALUES (?, ?, ?, ?, ?)
			ON CONFLICT (namespace, value_name) DO UPDATE SET
				presence = excluded.presence, content = excluded.content,
				authority_sequence = excluded.authority_sequence`,
		[
			fact.address.namespace,
			fact.address.valueName,
			fact.presence,
			'content' in fact ? JSON.stringify(fact.content) : null,
			fact.sequence,
		],
	);
}

function currentFacts(
	database: SqliteDatabase,
	addresses: readonly Address[],
): Fact[] {
	return addresses.flatMap((address) => {
		const fact = readFact(database, address);
		return fact === undefined ? [] : [fact];
	});
}

function readFactResponse(
	database: SqliteDatabase,
	afterSequence: number,
	lifetime: string,
	limits: ValidatedLimits,
) {
	const rows = database.all<FactRow>(FACTS_IN_RANGE, [
		afterSequence,
		afterSequence,
	]);
	const qualifying = rows.map(factFromRow);
	let count = 0;
	for (let index = 1; index <= qualifying.length; index += 1) {
		const candidate = {
			authorityLifetime: lifetime,
			facts: qualifying.slice(0, index),
			hasMore: index < qualifying.length,
		};
		if (
			new TextEncoder().encode(canonicalize(candidate)).byteLength >
			limits.maxFactsResponseBytes
		)
			break;
		count = index;
	}
	return {
		authorityLifetime: lifetime,
		facts: qualifying.slice(0, count),
		hasMore: count < qualifying.length,
	};
}

/** Open the unmounted SQL authority used by the V1 conformance tests. */
export function openEpicenterSyncAuthorityV1({
	database,
	lifetime,
	limits,
}: {
	database: SqliteDatabase;
	lifetime: string;
	limits: ValidatedLimits;
}) {
	initializeAuthoritySchema(database);
	const admittedLifetime = createAuthority(lifetime, limits);
	if (admittedLifetime.error !== null) {
		throw new RangeError(admittedLifetime.error.message);
	}
	return {
		readFacts(
			afterSequence: number,
			authorityLifetime?: string,
		): Result<ReturnType<typeof readFactResponse>, V1AuthorityError> {
			const parsed = parseFactsRequest(
				{
					afterSequence,
					...(authorityLifetime === undefined ? {} : { authorityLifetime }),
				},
				limits,
			);
			if (parsed.error !== null) return parsed;
			return database.transaction(() => {
				const activeSequence = readMetadata(database).next_sequence - 1;
				if (
					parsed.data.authorityLifetime !== undefined &&
					parsed.data.authorityLifetime !== lifetime
				) {
					return AuthorityError.LifetimeMismatch({
						requested: parsed.data.authorityLifetime,
						active: lifetime,
					});
				}
				if (parsed.data.afterSequence > activeSequence) {
					return AuthorityError.SequenceAhead({
						requestedAfterSequence: parsed.data.afterSequence,
						activeSequence,
					});
				}
				return {
					data: readFactResponse(
						database,
						parsed.data.afterSequence,
						lifetime,
						limits,
					),
					error: null,
				};
			});
		},

		submit(
			authorityLifetime: string,
			replicaId: string,
			submissionNumber: number,
			intents: readonly Intent[],
		): Result<SubmissionResponse, V1AuthorityError> {
			const parsed = parseSubmissionRequest(
				{ authorityLifetime, replicaId, submissionNumber, intents },
				limits,
			);
			if (parsed.error !== null) return parsed;
			return database.transaction(() => {
				if (parsed.data.authorityLifetime !== lifetime) {
					return AuthorityError.LifetimeMismatch({
						requested: parsed.data.authorityLifetime,
						active: lifetime,
					});
				}
				const stored = readReplica(database, parsed.data.replicaId);
				const lastNumber = stored?.accepted_batch ?? 0;
				const requestHash = sha256Hex(canonicalize(parsed.data));
				if (parsed.data.submissionNumber === lastNumber) {
					if (stored?.request_digest !== requestHash) {
						return AuthorityError.SubmissionFork({ submissionNumber });
					}
					return {
						// The unchanged schema has no parked-results column. V1 retries
						// therefore preserve the durable settlement facts only; a later
						// schema wave must persist the bounded parked list as well.
						data: {
							authorityLifetime: lifetime,
							facts: currentFacts(
								database,
								parsed.data.intents.map((intent) => intent.address),
							),
							parked: [],
						},
						error: null,
					};
				}
				if (parsed.data.submissionNumber !== lastNumber + 1) {
					return AuthorityError.SubmissionGap({
						submissionNumber,
						expectedNumber: lastNumber + 1,
					});
				}
				let nextSequence = readMetadata(database).next_sequence;
				const parked: SubmissionResponse['parked'] = [];
				for (const intent of parsed.data.intents) {
					const outcome = foldIntent(
						readFact(database, intent.address),
						intent,
						nextSequence,
					);
					if (outcome.kind === 'unchanged') continue;
					if (
						outcome.fact.presence === 'present' &&
						'fields' in outcome.fact &&
						encodedFactBytes(outcome.fact) > limits.maxEncodedFactBytes
					) {
						parked.push({
							address: outcome.fact.address,
							code: 'fact-too-large',
							measuredBytes: encodedFactBytes(outcome.fact),
							limitBytes: limits.maxEncodedFactBytes,
						});
						continue;
					}
					if (!Number.isSafeInteger(nextSequence))
						return AuthorityError.SequenceExhausted({ nextSequence });
					storeFact(database, outcome.fact);
					nextSequence += 1;
				}
				database.run(
					'UPDATE main._authority_metadata SET next_sequence = ? WHERE singleton = 1',
					[nextSequence],
				);
				database.run(
					`INSERT INTO main._authority_replicas (replica_id, accepted_batch, request_digest, receipt_sequence)
					VALUES (?, ?, ?, 0)
					ON CONFLICT (replica_id) DO UPDATE SET accepted_batch = excluded.accepted_batch, request_digest = excluded.request_digest, receipt_sequence = 0`,
					[parsed.data.replicaId, parsed.data.submissionNumber, requestHash],
				);
				return {
					data: {
						authorityLifetime: lifetime,
						facts: currentFacts(
							database,
							parsed.data.intents.map((intent) => intent.address),
						),
						parked,
					},
					error: null,
				};
			});
		},
	};
}
