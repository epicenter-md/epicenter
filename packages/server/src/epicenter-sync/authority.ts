import {
	batchDigest,
	type Change,
	type Cursor,
	DATA_ADMISSION_LIMITS,
	type ExchangeRequest,
	type ExchangeResponse,
	encodedJsonBytes,
	foldChange,
	type JsonObject,
	type JsonValue,
	parseExchangeRequest,
	type Receipt,
	type Record as SyncRecord,
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
type StateRow = SqliteRow & {
	address_kind: string;
	qualified_key: string;
	row_id: string;
	status: string;
	json_payload: string | null;
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

function stateRowToRecord(row: StateRow): SyncRecord {
	if (row.address_kind === 'row') {
		return row.status === 'deleted'
			? {
					kind: 'row-deleted',
					key: row.qualified_key,
					rowId: row.row_id,
					changedSequence: row.changed_sequence,
				}
			: {
					kind: 'row',
					key: row.qualified_key,
					rowId: row.row_id,
					changedSequence: row.changed_sequence,
					fields: JSON.parse(row.json_payload ?? 'null') as JsonObject,
				};
	}
	return row.status === 'unset'
		? {
				kind: 'value-unset',
				key: row.qualified_key,
				changedSequence: row.changed_sequence,
			}
		: {
				kind: 'value',
				key: row.qualified_key,
				changedSequence: row.changed_sequence,
				value: JSON.parse(row.json_payload ?? 'null') as JsonValue,
			};
}

function addressOf(value: SyncRecord | Change) {
	return 'rowId' in value
		? { kind: 'row', key: value.key, rowId: value.rowId }
		: { kind: 'value', key: value.key, rowId: '' };
}

function readRecord(
	database: SqliteDatabase,
	change: NonNullable<ExchangeRequest['batch']>['changes'][number],
): SyncRecord | undefined {
	const address = addressOf(change);
	const row = database.all<StateRow>(
		`SELECT address_kind, qualified_key, row_id, status, json_payload, changed_sequence
		FROM state WHERE address_kind = ? AND qualified_key = ? AND row_id = ?`,
		[address.kind, address.key, address.rowId],
	)[0];
	return row === undefined ? undefined : stateRowToRecord(row);
}

function storeRecord(database: SqliteDatabase, record: SyncRecord): void {
	const address = addressOf(record);
	const status =
		record.kind === 'row-deleted'
			? 'deleted'
			: record.kind === 'value-unset'
				? 'unset'
				: 'live';
	const payload =
		record.kind === 'row'
			? JSON.stringify(record.fields)
			: record.kind === 'value'
				? JSON.stringify(record.value)
				: null;
	database.run(
		`INSERT INTO state (
			address_kind, qualified_key, row_id, status, json_payload, changed_sequence
		) VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT (address_kind, qualified_key, row_id) DO UPDATE SET
			status = excluded.status,
			json_payload = excluded.json_payload,
			changed_sequence = excluded.changed_sequence`,
		[
			address.kind,
			address.key,
			address.rowId,
			status,
			payload,
			record.changedSequence,
		],
	);
	if (record.kind === 'row-deleted') {
		database.run(
			'DELETE FROM document_updates WHERE qualified_key = ? AND row_id = ?',
			[record.key, record.rowId],
		);
		database.run(
			'DELETE FROM document_versions WHERE qualified_key = ? AND row_id = ?',
			[record.key, record.rowId],
		);
	}
}

function readPage(
	database: SqliteDatabase,
	position: number,
	through: number,
	pageSize: number,
	receipt: Receipt | undefined,
): { through: number; records: SyncRecord[]; next: Cursor | null } {
	const available = database.all<StateRow>(
		`SELECT address_kind, qualified_key, row_id, status, json_payload, changed_sequence
		FROM state
		WHERE changed_sequence > ? AND changed_sequence <= ?
		ORDER BY changed_sequence
		LIMIT ?`,
		[position, through, pageSize + 1],
	);
	let records = available.slice(0, pageSize).map(stateRowToRecord);
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
		database.all<SqliteRow>(
			`SELECT 1 AS present FROM state
			WHERE changed_sequence > ? AND changed_sequence <= ? LIMIT 1`,
			[lastPosition, through],
		).length > 0;
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
								readRecord(database, change),
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
