import {
	type Address,
	batchDigest,
	type Cursor,
	DATA_ADMISSION_LIMITS,
	type ExchangeResponse,
	encodedJsonBytes,
	foldChange,
	type JsonObject,
	type JsonValue,
	parseExchangeRequest,
	type Receipt,
	type RowAddress,
	type Record as SyncRecord,
	type ValueAddress,
} from '@epicenter/data/protocol';
import type { SqliteDatabase, SqliteRow } from '@epicenter/sqlite';

import { initializeAuthoritySchema } from './authority-schema.js';

export const AUTHORITY_STORAGE_BYTE_CEILING = 10 * 1024 ** 3 - 64 * 1024 ** 2;

type MetadataRow = SqliteRow & { next_sequence: number };
type ReplicaRow = SqliteRow & {
	accepted_batch: number;
	request_digest: string | null;
	receipt_sequence: number;
};

/**
 * One row of the sequence-ordered union over both fact relations.
 *
 * `local_key` carries the table or value name, and `row_id` is NULL for a value
 * fact rather than an empty-string sentinel.
 */
type FactRow = SqliteRow & {
	fact_kind: string;
	namespace: string;
	local_key: string;
	row_id: string | null;
	presence: string;
	payload: string | null;
	changed_sequence: number;
};

export type EpicenterSyncAuthority = {
	exchange(request: unknown): ExchangeResponse;
};

export type OpenAuthorityOptions = {
	database: SqliteDatabase;
	pageSize?: number;
	readDatabaseSize?: () => number;
};

function readMetadata(database: SqliteDatabase): MetadataRow {
	const metadata = database.all<MetadataRow>(
		'SELECT next_sequence FROM metadata WHERE singleton = 1',
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
		FROM replicas WHERE replica_id = ?`,
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

function factRowToRecord(row: FactRow): SyncRecord {
	if (row.fact_kind === 'row') {
		if (row.row_id === null) {
			// `row_facts.row_id` is NOT NULL, so this is unreachable unless the
			// union projection above is edited wrongly. Refuse rather than coerce
			// to an empty string: that empty-row-id sentinel is exactly what the
			// split relations exist to make unrepresentable.
			throw new Error('A row fact is missing its row id');
		}
		const address: RowAddress = {
			kind: 'row',
			namespace: row.namespace,
			table: row.local_key,
			rowId: row.row_id,
		};
		return row.presence === 'absent'
			? { kind: 'row-deleted', address, changedSequence: row.changed_sequence }
			: {
					kind: 'row',
					address,
					changedSequence: row.changed_sequence,
					fields: JSON.parse(row.payload ?? 'null') as JsonObject,
				};
	}
	const address: ValueAddress = {
		kind: 'value',
		namespace: row.namespace,
		value: row.local_key,
	};
	return row.presence === 'absent'
		? { kind: 'value-unset', address, changedSequence: row.changed_sequence }
		: {
				kind: 'value',
				address,
				changedSequence: row.changed_sequence,
				value: JSON.parse(row.payload ?? 'null') as JsonValue,
			};
}

/**
 * The exchange page is one sequence-ordered stream over both fact relations, so
 * every read that pages by sequence goes through this projection.
 */
const FACTS_IN_RANGE = `
	SELECT changed_sequence, 'row' AS fact_kind, namespace,
		table_name AS local_key, row_id, presence, fields AS payload
	FROM row_facts WHERE changed_sequence > ? AND changed_sequence <= ?
	UNION ALL
	SELECT changed_sequence, 'value' AS fact_kind, namespace,
		value_name AS local_key, NULL AS row_id, presence, content AS payload
	FROM value_facts WHERE changed_sequence > ? AND changed_sequence <= ?
	ORDER BY changed_sequence`;

/**
 * Read the one current fact at an address.
 *
 * The address is already known here, so each branch selects only the payload and
 * sequence and rebuilds the record around the caller's address.
 */
function readFact(
	database: SqliteDatabase,
	address: Address,
): SyncRecord | undefined {
	if (address.kind === 'row') {
		const row = database.all<
			SqliteRow & {
				presence: string;
				fields: string | null;
				changed_sequence: number;
			}
		>(
			`SELECT presence, fields, changed_sequence
			FROM row_facts WHERE namespace = ? AND table_name = ? AND row_id = ?`,
			[address.namespace, address.table, address.rowId],
		)[0];
		if (row === undefined) return undefined;
		return row.presence === 'absent'
			? { kind: 'row-deleted', address, changedSequence: row.changed_sequence }
			: {
					kind: 'row',
					address,
					changedSequence: row.changed_sequence,
					fields: JSON.parse(row.fields ?? 'null') as JsonObject,
				};
	}
	const row = database.all<
		SqliteRow & {
			presence: string;
			content: string | null;
			changed_sequence: number;
		}
	>(
		`SELECT presence, content, changed_sequence
		FROM value_facts WHERE namespace = ? AND value_name = ?`,
		[address.namespace, address.value],
	)[0];
	if (row === undefined) return undefined;
	return row.presence === 'absent'
		? { kind: 'value-unset', address, changedSequence: row.changed_sequence }
		: {
				kind: 'value',
				address,
				changedSequence: row.changed_sequence,
				value: JSON.parse(row.content ?? 'null') as JsonValue,
			};
}

function storeRecord(database: SqliteDatabase, record: SyncRecord): void {
	if (record.kind === 'row' || record.kind === 'row-deleted') {
		const { namespace, table, rowId } = record.address;
		database.run(
			`INSERT INTO row_facts (
				namespace, table_name, row_id, presence, fields, changed_sequence
			) VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT (namespace, table_name, row_id) DO UPDATE SET
				presence = excluded.presence,
				fields = excluded.fields,
				changed_sequence = excluded.changed_sequence`,
			[
				namespace,
				table,
				rowId,
				record.kind === 'row' ? 'present' : 'absent',
				record.kind === 'row' ? JSON.stringify(record.fields) : null,
				record.changedSequence,
			],
		);
		if (record.kind === 'row-deleted') {
			database.run(
				'DELETE FROM document_updates WHERE namespace = ? AND table_name = ? AND row_id = ?',
				[namespace, table, rowId],
			);
			database.run(
				'DELETE FROM document_versions WHERE namespace = ? AND table_name = ? AND row_id = ?',
				[namespace, table, rowId],
			);
		}
		return;
	}
	const { namespace, value } = record.address;
	database.run(
		`INSERT INTO value_facts (
			namespace, value_name, presence, content, changed_sequence
		) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT (namespace, value_name) DO UPDATE SET
			presence = excluded.presence,
			content = excluded.content,
			changed_sequence = excluded.changed_sequence`,
		[
			namespace,
			value,
			record.kind === 'value' ? 'present' : 'absent',
			record.kind === 'value' ? JSON.stringify(record.value) : null,
			record.changedSequence,
		],
	);
}

function readPage(
	database: SqliteDatabase,
	position: number,
	through: number,
	pageSize: number,
	receipt: Receipt | undefined,
): { through: number; records: SyncRecord[]; next: Cursor | null } {
	const available = database.all<FactRow>(`${FACTS_IN_RANGE} LIMIT ?`, [
		position,
		through,
		position,
		through,
		pageSize + 1,
	]);
	let records = available.slice(0, pageSize).map(factRowToRecord);
	while (
		records.length > 1 &&
		encodedJsonBytes({
			...(receipt === undefined ? {} : { receipt }),
			through,
			records,
			next: { through, position: records.at(-1)?.changedSequence ?? position },
		}) > DATA_ADMISSION_LIMITS.encodedPageBytes
	) {
		records = records.slice(0, -1);
	}
	const lastPosition = records.at(-1)?.changedSequence ?? position;
	const hasMore =
		available.length > records.length ||
		database.all<FactRow>(`${FACTS_IN_RANGE} LIMIT 1`, [
			lastPosition,
			through,
			lastPosition,
			through,
		]).length > 0;
	return {
		through,
		records,
		next: hasMore ? { through, position: lastPosition } : null,
	};
}

/** Open one principal-owned scalar sync authority over caller-owned SQLite. */
export function openEpicenterSyncAuthority({
	database,
	pageSize = DATA_ADMISSION_LIMITS.recordsPerPage,
	readDatabaseSize,
}: OpenAuthorityOptions): EpicenterSyncAuthority {
	if (
		!Number.isInteger(pageSize) ||
		pageSize < 1 ||
		pageSize > DATA_ADMISSION_LIMITS.recordsPerPage
	) {
		throw new RangeError('Authority page size is outside protocol limits');
	}
	initializeAuthoritySchema(database);

	return {
		exchange(rawRequest): ExchangeResponse {
			return database.transaction(() => {
				const parsed = parseExchangeRequest(rawRequest);
				if (parsed.error !== null) throw new TypeError(parsed.error.message);
				const request = parsed.data;
				let receipt: Receipt | undefined;
				let metadata = readMetadata(database);

				if (request.batch !== undefined) {
					if (request.batch.digest !== batchDigest(request.batch.changes)) {
						throw new TypeError('Batch digest does not match its changes');
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
						for (const change of request.batch.changes) {
							const folded = foldChange(
								readFact(database, change.address),
								change,
								nextSequence,
							);
							if (folded.kind === 'noop') continue;
							storeRecord(database, folded.record);
							nextSequence += 1;
						}
						const appliedThrough = nextSequence - 1;
						database.run(
							'UPDATE metadata SET next_sequence = ? WHERE singleton = 1',
							[nextSequence],
						);
						database.run(
							`INSERT INTO replicas (
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
