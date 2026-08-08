import {
	batchDigest,
	type Cursor,
	DATA_ADMISSION_LIMITS,
	type ExchangeResponse,
	encodedJsonBytes,
	type Fact,
	foldIntent,
	type JsonObject,
	parseExchangeRequest,
	type Receipt,
	type RowAddress,
} from '@epicenter/data/legacy/protocol';
import type { SqliteDatabase, SqliteRow } from '@epicenter/sqlite';

import { initializeAuthoritySchema } from './authority-schema.js';

export const AUTHORITY_STORAGE_BYTE_CEILING = 10 * 1024 ** 3 - 64 * 1024 ** 2;

type MetadataRow = SqliteRow & { next_sequence: number };
type ReplicaRow = SqliteRow & {
	accepted_batch: number;
	request_digest: string | null;
	receipt_sequence: number;
};

/** One row of the sequence-ordered read over the one fact relation. */
type FactRow = SqliteRow & {
	namespace: string;
	table_name: string;
	row_id: string;
	presence: string;
	fields: string | null;
	authority_sequence: number;
};

function readMetadata(database: SqliteDatabase): MetadataRow {
	const metadata = database.all<MetadataRow>(
		'SELECT next_sequence FROM main._authority_metadata WHERE singleton = 1',
	)[0];
	if (metadata === undefined) throw new Error('Authority metadata is missing');
	return metadata;
}

function readReplica(
	database: SqliteDatabase,
	replicaId: string,
): ReplicaRow | undefined {
	return database.all<ReplicaRow>(
		`SELECT accepted_batch, request_digest, receipt_sequence
		FROM main._authority_replicas WHERE replica_id = ?`,
		[replicaId],
	)[0];
}

function receiptFrom(row: ReplicaRow): Receipt {
	if (row.request_digest === null || row.accepted_batch < 1) {
		throw new Error('Authority replica receipt is incomplete');
	}
	return {
		seq: row.accepted_batch,
		digest: row.request_digest,
		appliedThrough: row.receipt_sequence,
	};
}

function factRowToFact(row: FactRow): Fact {
	const address: RowAddress = {
		namespace: row.namespace,
		tableName: row.table_name,
		rowId: row.row_id,
	};
	return row.presence === 'absent'
		? {
				presence: 'absent',
				address,
				authoritySequence: row.authority_sequence,
			}
		: {
				presence: 'present',
				address,
				authoritySequence: row.authority_sequence,
				fields: JSON.parse(row.fields ?? 'null') as JsonObject,
			};
}

/**
 * The exchange page is one sequence-ordered read of the one fact relation.
 *
 * It was a `UNION ALL` carrying a query-local `fact_kind` label while rows and
 * values lived apart. One relation makes the label and the union unnecessary
 * rather than cheaper (ADR-0206).
 */
const FACTS_IN_RANGE = `
	SELECT authority_sequence, namespace, table_name, row_id, presence, fields
	FROM main._authority_row_facts WHERE authority_sequence > ? AND authority_sequence <= ?
	ORDER BY authority_sequence`;

/**
 * Read the one current fact at an address.
 *
 * The address is already known here, so this selects only the payload and the
 * sequence and rebuilds the record around the caller's address.
 */
function readFact(
	database: SqliteDatabase,
	address: RowAddress,
): Fact | undefined {
	const row = database.all<
		SqliteRow & {
			presence: string;
			fields: string | null;
			authority_sequence: number;
		}
	>(
		`SELECT presence, fields, authority_sequence
		FROM main._authority_row_facts WHERE namespace = ? AND table_name = ? AND row_id = ?`,
		[address.namespace, address.tableName, address.rowId],
	)[0];
	if (row === undefined) return undefined;
	return row.presence === 'absent'
		? {
				presence: 'absent',
				address,
				authoritySequence: row.authority_sequence,
			}
		: {
				presence: 'present',
				address,
				authoritySequence: row.authority_sequence,
				fields: JSON.parse(row.fields ?? 'null') as JsonObject,
			};
}

function storeFact(database: SqliteDatabase, fact: Fact): void {
	const { namespace, tableName, rowId } = fact.address;
	database.run(
		`INSERT INTO main._authority_row_facts (
			namespace, table_name, row_id, presence, fields, authority_sequence
		) VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT (namespace, table_name, row_id) DO UPDATE SET
			presence = excluded.presence,
			fields = excluded.fields,
			authority_sequence = excluded.authority_sequence`,
		[
			namespace,
			tableName,
			rowId,
			fact.presence,
			'fields' in fact ? JSON.stringify(fact.fields) : null,
			fact.authoritySequence,
		],
	);
	if (fact.presence === 'absent') {
		database.run(
			'DELETE FROM document_updates WHERE namespace = ? AND table_name = ? AND row_id = ?',
			[namespace, tableName, rowId],
		);
		database.run(
			'DELETE FROM document_versions WHERE namespace = ? AND table_name = ? AND row_id = ?',
			[namespace, tableName, rowId],
		);
	}
}

function readPage(
	database: SqliteDatabase,
	position: number,
	through: number,
	pageSize: number,
	receipt: Receipt | undefined,
): { through: number; facts: Fact[]; next: Cursor | null } {
	const available = database.all<FactRow>(`${FACTS_IN_RANGE} LIMIT ?`, [
		position,
		through,
		pageSize + 1,
	]);
	let facts = available.slice(0, pageSize).map(factRowToFact);
	while (
		facts.length > 1 &&
		encodedJsonBytes({
			...(receipt === undefined ? {} : { receipt }),
			through,
			facts,
			next: { through, position: facts.at(-1)?.authoritySequence ?? position },
		}) > DATA_ADMISSION_LIMITS.encodedPageBytes
	) {
		facts = facts.slice(0, -1);
	}
	const lastPosition = facts.at(-1)?.authoritySequence ?? position;
	const hasMore =
		available.length > facts.length ||
		database.all<FactRow>(`${FACTS_IN_RANGE} LIMIT 1`, [lastPosition, through])
			.length > 0;
	return {
		through,
		facts,
		next: hasMore ? { through, position: lastPosition } : null,
	};
}

/** Open one principal-owned scalar sync authority over caller-owned SQLite. */
export function openEpicenterSyncAuthority({
	database,
	pageSize = DATA_ADMISSION_LIMITS.factsPerPage,
	readDatabaseSize,
}: {
	database: SqliteDatabase;
	pageSize?: number;
	/**
	 * Current size of the caller's database in bytes. When provided, a batch
	 * that would grow the store past the ceiling is refused rather than applied.
	 */
	readDatabaseSize?: () => number;
}) {
	if (
		!Number.isInteger(pageSize) ||
		pageSize < 1 ||
		pageSize > DATA_ADMISSION_LIMITS.factsPerPage
	) {
		throw new RangeError('Authority page size is outside protocol limits');
	}
	initializeAuthoritySchema(database);

	return {
		/**
		 * Settle one replica's batch, if it carried one, and answer the next page
		 * of the sequence-ordered fact stream.
		 *
		 * Takes `unknown` because a Durable Object RPC entry point re-enters this
		 * from a serialized boundary, so the request is parsed here rather than
		 * trusted from a type.
		 */
		exchange(rawRequest: unknown): ExchangeResponse {
			return database.transaction(() => {
				const parsed = parseExchangeRequest(rawRequest);
				if (parsed.error !== null) throw new TypeError(parsed.error.message);
				const request = parsed.data;
				let receipt: Receipt | undefined;
				let metadata = readMetadata(database);

				if (request.batch !== undefined) {
					if (request.batch.digest !== batchDigest(request.batch.intents)) {
						throw new TypeError('Batch digest does not match its intents');
					}
					const stored = readReplica(database, request.replicaId);
					const acceptedBatch = stored?.accepted_batch ?? 0;
					if (request.batch.seq === acceptedBatch) {
						if (
							stored === undefined ||
							stored.request_digest !== request.batch.digest
						) {
							return { refusal: 'batch-conflict' };
						}
						receipt = receiptFrom(stored);
					} else if (request.batch.seq !== acceptedBatch + 1) {
						return { refusal: 'batch-conflict' };
					} else {
						if (
							readDatabaseSize !== undefined &&
							readDatabaseSize() >= AUTHORITY_STORAGE_BYTE_CEILING
						) {
							return { refusal: 'storage-limit' };
						}
						let nextSequence = metadata.next_sequence;
						for (const intent of request.batch.intents) {
							const folded = foldIntent(
								readFact(database, intent.address),
								intent,
								nextSequence,
							);
							if (folded.kind === 'noop') continue;
							// The authority is the only writer of `next_sequence`, so an
							// applied fold always carries a positive sequence and is a
							// genuine authority fact rather than a local one.
							storeFact(database, folded.fact as Fact);
							nextSequence += 1;
						}
						const appliedThrough = nextSequence - 1;
						database.run(
							'UPDATE main._authority_metadata SET next_sequence = ? WHERE singleton = 1',
							[nextSequence],
						);
						database.run(
							`INSERT INTO main._authority_replicas (
								replica_id, accepted_batch, request_digest, receipt_sequence
							) VALUES (?, ?, ?, ?)
							ON CONFLICT (replica_id) DO UPDATE SET
								accepted_batch = excluded.accepted_batch,
								request_digest = excluded.request_digest,
								receipt_sequence = excluded.receipt_sequence`,
							[
								request.replicaId,
								request.batch.seq,
								request.batch.digest,
								appliedThrough,
							],
						);
						receipt = {
							seq: request.batch.seq,
							digest: request.batch.digest,
							appliedThrough,
						};
						metadata = { ...metadata, next_sequence: nextSequence };
					}
				}

				const head = metadata.next_sequence - 1;
				const through = request.cursor?.through ?? head;
				const position = request.cursor?.position ?? request.after;
				if (request.after > head || through > head) {
					throw new TypeError('Exchange cursor is ahead of the authority');
				}
				return {
					...(receipt === undefined ? {} : { receipt }),
					...readPage(database, position, through, pageSize, receipt),
				};
			});
		},
	};
}
