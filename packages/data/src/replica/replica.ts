import type { SqliteDatabase, SqliteRow } from '@epicenter/sqlite';
import { customAlphabet } from 'nanoid';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { Ok, type Result, trySync } from 'wellcrafted/result';

import {
	batchDigest,
	type Change,
	DATA_ADMISSION_LIMITS,
	type ExchangeRequest,
	type ExchangeResponse,
	encodedJsonBytes,
	foldChange,
	type JsonObject,
	type JsonValue,
	parseChange,
	parseExchangeResponse,
	parseQualifiedKey,
	parseReplicaId,
	parseRowId,
	type Record as SyncRecord,
} from '../protocol/index.js';
import { createReplicaSchema, REPLICA_FORMAT_VERSION } from './schema.js';

const mintRuntimeId = customAlphabet(
	'abcdefghijklmnopqrstuvwxyz0123456789',
	24,
);
const OUTBOX_SEQUENCE_KEY = 'so.epicenter.internal.batch-sequence';

export const ReplicaError = defineErrors({
	StorageFailed: ({
		operation,
		cause,
	}: {
		operation: string;
		cause: unknown;
	}) => ({
		message: `Replica storage failed during ${operation}: ${extractErrorMessage(cause)}`,
		operation,
		cause,
	}),
	UnsupportedFormat: ({ found }: { found: number | null }) => ({
		message: `Replica format ${found === null ? 'is incomplete' : found} is not supported`,
		found,
	}),
	WrongAttachment: ({
		expectedDeploymentId,
		expectedPrincipalId,
		deploymentId,
		principalId,
	}: {
		expectedDeploymentId: string;
		expectedPrincipalId: string;
		deploymentId: string;
		principalId: string;
	}) => ({
		message:
			'This replica is permanently attached to another deployment or principal',
		expectedDeploymentId,
		expectedPrincipalId,
		deploymentId,
		principalId,
	}),
	NotAttached: () => ({ message: 'Attach the replica before synchronizing' }),
	InvalidInput: ({ boundary }: { boundary: string }) => ({
		message: `Invalid replica ${boundary}`,
		boundary,
	}),
	InvalidExchange: ({ reason }: { reason: string }) => ({
		message: `Invalid exchange response: ${reason}`,
		reason,
	}),
	StorageLimit: () => ({ message: 'The authority storage limit was reached' }),
	TransportFailed: ({ cause }: { cause: unknown }) => ({
		message: `Replica exchange failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
	SubscriberThrew: ({ cause }: { cause: unknown }) => ({
		message: `Replica change subscriber threw: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type ReplicaError = InferErrors<typeof ReplicaError>;

type MetadataRow = SqliteRow & {
	format_version: number;
	replica_id: string;
	attached_deployment: string | null;
	attached_principal: string | null;
	last_applied_authority_sequence: number;
};

type StateRow = SqliteRow & {
	address_kind: string;
	qualified_key: string;
	row_id: string;
	status: string;
	json_payload: string | null;
	changed_sequence: number;
};

type OutboxRow = SqliteRow & {
	local_sequence: number;
	address_kind: string;
	qualified_key: string;
	row_id: string;
	status: string;
	json_payload: string | null;
};

export type ReplicaMetadata = {
	formatVersion: number;
	replicaId: string;
	attachment: { deploymentId: string; principalId: string } | undefined;
	lastAppliedAuthoritySequence: number;
};

export type Exchange = (
	request: ExchangeRequest,
) => ExchangeResponse | Promise<ExchangeResponse>;

export type OpenReplicaOptions = {
	database: SqliteDatabase;
	mintReplicaId?: () => string;
	log?: Logger;
};

export type ReplicaChange =
	| { kind: 'row'; key: string; rowId: string }
	| { kind: 'value'; key: string };

function storageResult<T>(
	operation: string,
	run: () => T,
): Result<T, ReplicaError> {
	return trySync({
		try: run,
		catch: (cause) => ReplicaError.StorageFailed({ operation, cause }),
	});
}

function readMetadata(database: SqliteDatabase): MetadataRow | undefined {
	return database.all<MetadataRow>(
		`SELECT format_version, replica_id, attached_deployment,
			attached_principal, last_applied_authority_sequence
		FROM metadata WHERE singleton = 1`,
	)[0];
}

function toMetadata(row: MetadataRow): ReplicaMetadata {
	return {
		formatVersion: row.format_version,
		replicaId: row.replica_id,
		attachment:
			row.attached_deployment === null || row.attached_principal === null
				? undefined
				: {
						deploymentId: row.attached_deployment,
						principalId: row.attached_principal,
					},
		lastAppliedAuthoritySequence: row.last_applied_authority_sequence,
	};
}

function scalarAddress(value: Change | SyncRecord): {
	kind: 'row' | 'value';
	key: string;
	rowId: string;
} {
	return 'rowId' in value
		? { kind: 'row', key: value.key, rowId: value.rowId }
		: { kind: 'value', key: value.key, rowId: '' };
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

function readState(
	database: SqliteDatabase,
	change: Change,
): SyncRecord | undefined {
	const address = scalarAddress(change);
	const row = database.all<StateRow>(
		`SELECT address_kind, qualified_key, row_id, status, json_payload, changed_sequence
		FROM state WHERE address_kind = ? AND qualified_key = ? AND row_id = ?`,
		[address.kind, address.key, address.rowId],
	)[0];
	return row === undefined ? undefined : stateRowToRecord(row);
}

function storeRecord(database: SqliteDatabase, record: SyncRecord): void {
	const address = scalarAddress(record);
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
	}
}

function encodeOutboxChange(change: Change): {
	status: string;
	payload: string | null;
} {
	switch (change.kind) {
		case 'create':
		case 'update':
			return {
				status: 'live',
				payload: JSON.stringify({ kind: change.kind, fields: change.fields }),
			};
		case 'delete':
			return { status: 'deleted', payload: null };
		case 'set':
			return { status: 'live', payload: JSON.stringify(change.value) };
		case 'unset':
			return { status: 'unset', payload: null };
		default:
			return change satisfies never;
	}
}

function outboxRowToChange(row: OutboxRow): Change {
	if (row.address_kind === 'row') {
		if (row.status === 'deleted') {
			return { kind: 'delete', key: row.qualified_key, rowId: row.row_id };
		}
		const payload = JSON.parse(row.json_payload ?? 'null') as {
			kind: 'create' | 'update';
			fields: JsonObject | { set: JsonObject; unset: string[] };
		};
		return payload.kind === 'create'
			? {
					kind: 'create',
					key: row.qualified_key,
					rowId: row.row_id,
					fields: payload.fields as JsonObject,
				}
			: {
					kind: 'update',
					key: row.qualified_key,
					rowId: row.row_id,
					fields: payload.fields as { set: JsonObject; unset: string[] },
				};
	}
	return row.status === 'unset'
		? { kind: 'unset', key: row.qualified_key }
		: {
				kind: 'set',
				key: row.qualified_key,
				value: JSON.parse(row.json_payload ?? 'null') as JsonValue,
			};
}

function hasPendingAddress(
	database: SqliteDatabase,
	record: SyncRecord,
): boolean {
	const address = scalarAddress(record);
	return (
		database.all<SqliteRow>(
			`SELECT 1 AS pending FROM outbox
		WHERE local_sequence > 0
			AND address_kind = ? AND qualified_key = ? AND row_id = ? LIMIT 1`,
			[address.kind, address.key, address.rowId],
		).length > 0
	);
}

function installRecord(database: SqliteDatabase, record: SyncRecord): boolean {
	if (hasPendingAddress(database, record)) return false;
	const address = scalarAddress(record);
	const existing = database.all<StateRow>(
		`SELECT address_kind, qualified_key, row_id, status, json_payload, changed_sequence
		FROM state WHERE address_kind = ? AND qualified_key = ? AND row_id = ?`,
		[address.kind, address.key, address.rowId],
	)[0];
	if (
		existing !== undefined &&
		existing.changed_sequence >= record.changedSequence
	)
		return false;
	storeRecord(database, record);
	return true;
}

function pendingOutboxRows(database: SqliteDatabase): OutboxRow[] {
	return database.all<OutboxRow>(
		`SELECT local_sequence, address_kind, qualified_key, row_id, status, json_payload
		FROM outbox WHERE local_sequence > 0 ORDER BY local_sequence LIMIT ?`,
		[DATA_ADMISSION_LIMITS.changesPerBatch],
	);
}

function sealBatch(database: SqliteDatabase) {
	const rows = pendingOutboxRows(database);
	if (rows.length === 0) return undefined;
	const seq = readLastBatchSequence(database) + 1;
	const selected: OutboxRow[] = [];
	const changes: Change[] = [];
	for (const row of rows) {
		if (changes.length === DATA_ADMISSION_LIMITS.changesPerBatch) break;
		const change = outboxRowToChange(row);
		const candidate = [...changes, change];
		if (
			encodedJsonBytes({ seq, digest: '0'.repeat(64), changes: candidate }) >
			DATA_ADMISSION_LIMITS.encodedBatchBytes
		) {
			break;
		}
		selected.push(row);
		changes.push(change);
	}
	if (changes.length === 0)
		throw new Error('One outbox change exceeds the batch admission limit');
	return {
		batch: { seq, digest: batchDigest(changes), changes },
		localSequences: selected.map((row) => row.local_sequence),
	};
}

function readLastBatchSequence(database: SqliteDatabase): number {
	return (
		database.all<SqliteRow & { sequence: number }>(
			`SELECT COALESCE(-MIN(local_sequence), 0) AS sequence
			FROM outbox WHERE local_sequence < 0`,
		)[0]?.sequence ?? 0
	);
}

function rememberBatchSequence(
	database: SqliteDatabase,
	sequence: number,
): void {
	database.run('DELETE FROM outbox WHERE local_sequence < 0');
	database.run(
		`INSERT INTO outbox (
			local_sequence, address_kind, qualified_key, row_id, status, json_payload
		) VALUES (?, 'value', ?, '', 'unset', NULL)`,
		[-sequence, OUTBOX_SEQUENCE_KEY],
	);
}

function createReplica(
	database: SqliteDatabase,
	mintReplica: () => string,
	log: Logger,
) {
	const maximumPendingSequence =
		database.all<SqliteRow & { sequence: number }>(
			'SELECT COALESCE(MAX(local_sequence), 0) AS sequence FROM outbox WHERE local_sequence > 0',
		)[0]?.sequence ?? 0;
	let nextLocalSequence =
		Math.max(readLastBatchSequence(database), maximumPendingSequence) + 1;
	const changeListeners = new Set<
		(changes: readonly ReplicaChange[]) => void
	>();
	const outboxListeners = new Set<() => void>();

	function notify(changes: readonly ReplicaChange[]): void {
		if (changes.length === 0) return;
		for (const listener of changeListeners) {
			try {
				listener(changes);
			} catch (cause) {
				log.error(ReplicaError.SubscriberThrew({ cause }));
			}
		}
	}

	function changeOf(value: Change | SyncRecord): ReplicaChange {
		return 'rowId' in value
			? { kind: 'row', key: value.key, rowId: value.rowId }
			: { kind: 'value', key: value.key };
	}

	function metadata(): Result<ReplicaMetadata, ReplicaError> {
		return storageResult('read metadata', () => {
			const row = readMetadata(database);
			if (row === undefined) throw new Error('metadata singleton is missing');
			return toMetadata(row);
		});
	}

	function attach({
		deploymentId,
		principalId,
	}: {
		deploymentId: string;
		principalId: string;
	}): Result<void, ReplicaError> {
		if (deploymentId.length === 0 || principalId.length === 0) {
			return ReplicaError.InvalidInput({ boundary: 'attachment' });
		}
		try {
			if (new URL(deploymentId).href !== deploymentId) {
				return ReplicaError.InvalidInput({
					boundary: 'canonical deployment URL',
				});
			}
		} catch {
			return ReplicaError.InvalidInput({
				boundary: 'canonical deployment URL',
			});
		}
		try {
			database.transaction(() => {
				const row = readMetadata(database);
				if (row === undefined) throw new Error('metadata singleton is missing');
				if (
					row.attached_deployment === null &&
					row.attached_principal === null
				) {
					database.run(
						'UPDATE metadata SET attached_deployment = ?, attached_principal = ? WHERE singleton = 1',
						[deploymentId, principalId],
					);
					return;
				}
				if (
					row.attached_deployment === deploymentId &&
					row.attached_principal === principalId
				)
					return;
				throw new AttachmentMismatch({
					expectedDeploymentId: row.attached_deployment ?? '',
					expectedPrincipalId: row.attached_principal ?? '',
					deploymentId,
					principalId,
				});
			});
			return Ok(undefined);
		} catch (cause) {
			if (cause instanceof AttachmentMismatch) {
				return ReplicaError.WrongAttachment(cause.attachment);
			}
			return ReplicaError.StorageFailed({ operation: 'attach', cause });
		}
	}

	function write(change: Change): Result<{ applied: boolean }, ReplicaError> {
		const { data: parsed, error } = parseChange(change);
		if (error !== null)
			return ReplicaError.InvalidInput({ boundary: 'change' });
		const result = storageResult('write', () =>
			database.transaction(() => {
				const current = readState(database, parsed);
				const folded = foldChange(current, parsed, 0);
				if (folded.kind === 'noop') return { applied: false };
				storeRecord(database, folded.record);
				const address = scalarAddress(parsed);
				const encoded = encodeOutboxChange(parsed);
				database.run(
					`INSERT INTO outbox (
						local_sequence, address_kind, qualified_key, row_id, status, json_payload
					) VALUES (?, ?, ?, ?, ?, ?)`,
					[
						nextLocalSequence,
						address.kind,
						address.key,
						address.rowId,
						encoded.status,
						encoded.payload,
					],
				);
				nextLocalSequence += 1;
				return { applied: true };
			}),
		);
		if (result.error === null && result.data.applied)
			notify([changeOf(parsed)]);
		if (result.error === null && result.data.applied) {
			for (const listener of outboxListeners) listener();
		}
		return result;
	}

	function subscribe(
		listener: (changes: readonly ReplicaChange[]) => void,
	): () => void {
		changeListeners.add(listener);
		return () => changeListeners.delete(listener);
	}

	function subscribeOutbox(listener: () => void): () => void {
		outboxListeners.add(listener);
		return () => outboxListeners.delete(listener);
	}

	function readRow(
		key: string,
		rowId: string,
	): Result<JsonObject | undefined, ReplicaError> {
		if (
			parseQualifiedKey(key).error !== null ||
			parseRowId(rowId).error !== null
		) {
			return ReplicaError.InvalidInput({ boundary: 'row address' });
		}
		return storageResult('read row', () => {
			const row = database.all<StateRow>(
				`SELECT address_kind, qualified_key, row_id, status, json_payload, changed_sequence
				FROM state WHERE address_kind = 'row' AND qualified_key = ? AND row_id = ?`,
				[key, rowId],
			)[0];
			if (row === undefined || row.status !== 'live') return undefined;
			const record = stateRowToRecord(row);
			return record.kind === 'row' ? structuredClone(record.fields) : undefined;
		});
	}

	function readValue(key: string): Result<JsonValue | undefined, ReplicaError> {
		if (parseQualifiedKey(key).error !== null)
			return ReplicaError.InvalidInput({ boundary: 'value address' });
		return storageResult('read value', () => {
			const row = database.all<StateRow>(
				`SELECT address_kind, qualified_key, row_id, status, json_payload, changed_sequence
				FROM state WHERE address_kind = 'value' AND qualified_key = ? AND row_id = ''`,
				[key],
			)[0];
			if (row === undefined || row.status !== 'live') return undefined;
			const record = stateRowToRecord(row);
			return record.kind === 'value'
				? structuredClone(record.value)
				: undefined;
		});
	}

	async function synchronize(
		exchange: Exchange,
	): Promise<Result<void, ReplicaError>> {
		let conflictRecoveries = 0;
		while (true) {
			let didRecoverConflict = false;
			const metadataResult = metadata();
			if (metadataResult.error !== null) return metadataResult;
			if (metadataResult.data.attachment === undefined)
				return ReplicaError.NotAttached();

			const outboxResult = storageResult('seal batch', () =>
				sealBatch(database),
			);
			if (outboxResult.error !== null) return outboxResult;
			const sealed = outboxResult.data;
			const batch = sealed?.batch;
			let cursor: ExchangeRequest['cursor'];
			let isFirstPage = true;

			while (true) {
				const request: ExchangeRequest = {
					replicaId: metadataResult.data.replicaId,
					after: metadataResult.data.lastAppliedAuthoritySequence,
					...(isFirstPage && batch !== undefined ? { batch } : {}),
					...(cursor === undefined ? {} : { cursor }),
				};
				let rawResponse: ExchangeResponse;
				try {
					rawResponse = await exchange(request);
				} catch (cause) {
					return ReplicaError.TransportFailed({ cause });
				}
				const { data: response, error: responseError } =
					parseExchangeResponse(rawResponse);
				if (responseError !== null)
					return ReplicaError.InvalidExchange({
						reason: responseError.message,
					});

				if ('refusal' in response) {
					if (response.refusal === 'storage-limit')
						return ReplicaError.StorageLimit();
					conflictRecoveries += 1;
					if (conflictRecoveries > 8)
						return ReplicaError.InvalidExchange({
							reason: 'repeated batch conflicts',
						});
					const recovery = storageResult('recover replica fork', () =>
						database.transaction(() => {
							const replicaId = mintReplica();
							if (parseReplicaId(replicaId).error !== null)
								throw new Error('minted replica id is invalid');
							database.run(
								'UPDATE metadata SET replica_id = ? WHERE singleton = 1',
								[replicaId],
							);
							const pending = database.all<OutboxRow>(
								`SELECT local_sequence, address_kind, qualified_key, row_id, status, json_payload
								FROM outbox WHERE local_sequence > 0 ORDER BY local_sequence`,
							);
							database.run('DELETE FROM outbox WHERE local_sequence < 0');
							for (const row of pending)
								database.run(
									'UPDATE outbox SET local_sequence = ? WHERE local_sequence = ?',
									[-row.local_sequence, row.local_sequence],
								);
							for (const [index, row] of pending.entries())
								database.run(
									'UPDATE outbox SET local_sequence = ? WHERE local_sequence = ?',
									[index + 1, -row.local_sequence],
								);
							nextLocalSequence = pending.length + 1;
						}),
					);
					if (recovery.error !== null) return recovery;
					didRecoverConflict = true;
					break;
				}

				if (cursor !== undefined && response.through !== cursor.through) {
					return ReplicaError.InvalidExchange({
						reason: 'page changed the fixed through cursor',
					});
				}
				const priorPosition =
					cursor?.position ?? metadataResult.data.lastAppliedAuthoritySequence;
				if (
					response.records.some(
						(record) => record.changedSequence <= priorPosition,
					) ||
					(response.next !== null && response.next.position <= priorPosition)
				) {
					return ReplicaError.InvalidExchange({
						reason: 'page did not advance from its requested position',
					});
				}
				if (isFirstPage && batch !== undefined) {
					if (
						response.receipt?.seq !== batch.seq ||
						response.receipt.digest !== batch.digest
					) {
						return ReplicaError.InvalidExchange({
							reason: 'batch receipt does not match the sealed batch',
						});
					}
				} else if (response.receipt !== undefined) {
					return ReplicaError.InvalidExchange({
						reason: 'unexpected batch receipt',
					});
				}

				const installed = storageResult('install exchange page', () =>
					database.transaction(() => {
						const changes = new Map<string, ReplicaChange>();
						if (isFirstPage && batch !== undefined && sealed !== undefined) {
							for (const localSequence of sealed.localSequences) {
								database.run('DELETE FROM outbox WHERE local_sequence = ?', [
									localSequence,
								]);
							}
							rememberBatchSequence(database, batch.seq);
						}
						for (const record of response.records) {
							if (!installRecord(database, record)) continue;
							const change = changeOf(record);
							const address =
								change.kind === 'row'
									? `row\0${change.key}\0${change.rowId}`
									: `value\0${change.key}`;
							changes.set(address, change);
						}
						return [...changes.values()];
					}),
				);
				if (installed.error !== null) return installed;
				notify(installed.data);

				if (response.next !== null) {
					cursor = response.next;
					isFirstPage = false;
					continue;
				}
				const advanced = storageResult('advance authority cursor', () =>
					database.transaction(() => {
						database.run(
							'UPDATE metadata SET last_applied_authority_sequence = ? WHERE singleton = 1',
							[response.through],
						);
					}),
				);
				if (advanced.error !== null) return advanced;
				break;
			}

			if (didRecoverConflict) continue;
			const pending = storageResult(
				'check pending outbox',
				() => pendingOutboxRows(database)[0],
			);
			if (pending.error !== null) return pending;
			if (pending.data === undefined) return Ok(undefined);
		}
	}

	return {
		metadata,
		attach,
		write,
		readRow,
		readValue,
		subscribe,
		subscribeOutbox,
		synchronize,
	};
}

export type Replica = ReturnType<typeof createReplica>;

class AttachmentMismatch extends Error {
	constructor(
		readonly attachment: {
			expectedDeploymentId: string;
			expectedPrincipalId: string;
			deploymentId: string;
			principalId: string;
		},
	) {
		super('attachment mismatch');
	}
}

export function openReplica({
	database,
	mintReplicaId = mintRuntimeId,
	log = createLogger('data/replica'),
}: OpenReplicaOptions): Result<Replica, ReplicaError> {
	try {
		const tables = database.all<SqliteRow & { name: string }>(
			`SELECT name FROM sqlite_schema
			WHERE type = 'table' AND name IN ('metadata', 'state', 'outbox', 'document_updates')`,
		);
		if (tables.length === 0) {
			const replicaId = mintReplicaId();
			if (parseReplicaId(replicaId).error !== null)
				return ReplicaError.InvalidInput({ boundary: 'minted replica id' });
			database.transaction(() => createReplicaSchema(database, replicaId));
		} else if (!tables.some((table) => table.name === 'metadata')) {
			return ReplicaError.UnsupportedFormat({ found: null });
		}
		const row = readMetadata(database);
		if (row === undefined)
			return ReplicaError.UnsupportedFormat({ found: null });
		if (row.format_version !== REPLICA_FORMAT_VERSION) {
			return ReplicaError.UnsupportedFormat({ found: row.format_version });
		}
		if (parseReplicaId(row.replica_id).error !== null)
			return ReplicaError.UnsupportedFormat({ found: row.format_version });
		return Ok(createReplica(database, mintReplicaId, log));
	} catch (cause) {
		if (cause instanceof AttachmentMismatch) {
			return ReplicaError.WrongAttachment(cause.attachment);
		}
		return ReplicaError.StorageFailed({ operation: 'open', cause });
	}
}
