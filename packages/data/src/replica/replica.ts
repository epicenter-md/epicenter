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
	type Address,
	addressKey,
	batchDigest,
	type Change,
	DATA_ADDRESS_CEILINGS,
	DATA_ADMISSION_LIMITS,
	type ExchangeRequest,
	type ExchangeResponse,
	encodedJsonBytes,
	foldChange,
	isRowAddress,
	isValueAddress,
	type JsonObject,
	type JsonValue,
	parseChange,
	parseExchangeResponse,
	parseReplicaId,
	type RowAddress,
	type Record as SyncRecord,
	type ValueAddress,
} from '../protocol/index.js';
import {
	createReplicaSchema,
	REPLICA_FORMAT_VERSION,
	REPLICA_TABLES,
} from './schema.js';

const mintRuntimeId = customAlphabet(
	'abcdefghijklmnopqrstuvwxyz0123456789',
	24,
);

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
	/**
	 * A synchronization cycle threw instead of returning a Result: a programming
	 * bug, or an injected dependency (a credential provider, a scheduler, an
	 * exchange or publish carrier) that rejected outside its own Result
	 * adaptation.
	 *
	 * Deliberately its own variant. Folding an unexpected throw into
	 * `TransportFailed` would claim the network was at fault and hand it the
	 * transport retry policy, which turns a bug into a hot retry loop and hides
	 * it behind an "offline" status the user cannot act on. The original throw
	 * stays on `cause`.
	 */
	SyncFaulted: ({ cause }: { cause: unknown }) => ({
		message: `Sync faulted unexpectedly: ${extractErrorMessage(cause)}`,
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
	last_sealed_batch_sequence: number;
};

type RowFactRow = SqliteRow & {
	namespace: string;
	table_name: string;
	row_id: string;
	presence: string;
	fields: string | null;
	changed_sequence: number;
};

type ValueFactRow = SqliteRow & {
	namespace: string;
	value_name: string;
	presence: string;
	content: string | null;
	changed_sequence: number;
};

type PendingRow = SqliteRow & {
	local_sequence: number;
	intent_kind: string;
	namespace: string;
	local_key: string;
	row_id: string | null;
	presence: string;
	payload: string | null;
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
			attached_principal, last_applied_authority_sequence,
			last_sealed_batch_sequence
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

function rowFactToRecord(row: RowFactRow): SyncRecord {
	const address: RowAddress = {
		kind: 'row',
		namespace: row.namespace,
		table: row.table_name,
		rowId: row.row_id,
	};
	return row.presence === 'absent'
		? { kind: 'row-deleted', address, changedSequence: row.changed_sequence }
		: {
				kind: 'row',
				address,
				changedSequence: row.changed_sequence,
				fields: JSON.parse(row.fields ?? 'null') as JsonObject,
			};
}

function valueFactToRecord(row: ValueFactRow): SyncRecord {
	const address: ValueAddress = {
		kind: 'value',
		namespace: row.namespace,
		value: row.value_name,
	};
	return row.presence === 'absent'
		? { kind: 'value-unset', address, changedSequence: row.changed_sequence }
		: {
				kind: 'value',
				address,
				changedSequence: row.changed_sequence,
				value: JSON.parse(row.content ?? 'null') as JsonValue,
			};
}

function readFact(
	database: SqliteDatabase,
	address: Address,
): SyncRecord | undefined {
	if (address.kind === 'row') {
		const row = database.all<RowFactRow>(
			`SELECT namespace, table_name, row_id, presence, fields, changed_sequence
			FROM row_facts WHERE namespace = ? AND table_name = ? AND row_id = ?`,
			[address.namespace, address.table, address.rowId],
		)[0];
		return row === undefined ? undefined : rowFactToRecord(row);
	}
	const row = database.all<ValueFactRow>(
		`SELECT namespace, value_name, presence, content, changed_sequence
		FROM value_facts WHERE namespace = ? AND value_name = ?`,
		[address.namespace, address.value],
	)[0];
	return row === undefined ? undefined : valueFactToRecord(row);
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
			// Scalar death, document death, and obligation death commit together:
			// a deleted row can never leave orphaned bytes or a dirty publication
			// that would republish content for a dead address (ADR-0174).
			database.run(
				'DELETE FROM document_updates WHERE namespace = ? AND table_name = ? AND row_id = ?',
				[namespace, table, rowId],
			);
			database.run(
				'DELETE FROM document_publication WHERE namespace = ? AND table_name = ? AND row_id = ?',
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

function enqueueChange(
	database: SqliteDatabase,
	localSequence: number,
	change: Change,
): void {
	if (change.address.kind === 'row') {
		const { namespace, table, rowId } = change.address;
		const patch =
			change.kind === 'create'
				? JSON.stringify({ kind: 'create', fields: change.fields })
				: change.kind === 'update'
					? JSON.stringify({ kind: 'update', fields: change.fields })
					: null;
		database.run(
			`INSERT INTO row_outbox (
				local_sequence, namespace, table_name, row_id, presence, patch
			) VALUES (?, ?, ?, ?, ?, ?)`,
			[
				localSequence,
				namespace,
				table,
				rowId,
				change.kind === 'delete' ? 'absent' : 'present',
				patch,
			],
		);
		return;
	}
	const { namespace, value } = change.address;
	database.run(
		`INSERT INTO value_outbox (
			local_sequence, namespace, value_name, presence, content
		) VALUES (?, ?, ?, ?, ?)`,
		[
			localSequence,
			namespace,
			value,
			change.kind === 'set' ? 'present' : 'absent',
			change.kind === 'set' ? JSON.stringify(change.value) : null,
		],
	);
}

function pendingRowToChange(row: PendingRow): Change {
	if (row.intent_kind === 'row') {
		if (row.row_id === null) {
			// `row_outbox.row_id` is NOT NULL, so this is unreachable unless the
			// union projection above is edited wrongly. Refuse rather than coerce
			// to an empty string: that empty-row-id sentinel is exactly what the
			// split relations exist to make unrepresentable.
			throw new Error('A pending row intent is missing its row id');
		}
		const address: RowAddress = {
			kind: 'row',
			namespace: row.namespace,
			table: row.local_key,
			rowId: row.row_id,
		};
		if (row.presence === 'absent') return { kind: 'delete', address };
		const patch = JSON.parse(row.payload ?? 'null') as {
			kind: 'create' | 'update';
			fields: JsonObject | { set: JsonObject; unset: string[] };
		};
		return patch.kind === 'create'
			? { kind: 'create', address, fields: patch.fields as JsonObject }
			: {
					kind: 'update',
					address,
					fields: patch.fields as { set: JsonObject; unset: string[] },
				};
	}
	const address: ValueAddress = {
		kind: 'value',
		namespace: row.namespace,
		value: row.local_key,
	};
	return row.presence === 'absent'
		? { kind: 'unset', address }
		: {
				kind: 'set',
				address,
				value: JSON.parse(row.payload ?? 'null') as JsonValue,
			};
}

/**
 * One local-sequence-ordered view across both intent queues.
 *
 * The two relations keep their own shapes, so the union projects each onto the
 * shared columns the sealer needs; `local_key` carries the table or value name
 * and `row_id` is NULL for a value intent rather than an empty-string sentinel.
 */
const PENDING_QUERY = `
	SELECT local_sequence, 'row' AS intent_kind, namespace,
		table_name AS local_key, row_id, presence, patch AS payload
	FROM row_outbox
	UNION ALL
	SELECT local_sequence, 'value' AS intent_kind, namespace,
		value_name AS local_key, NULL AS row_id, presence, content AS payload
	FROM value_outbox
	ORDER BY local_sequence`;

function pendingChanges(
	database: SqliteDatabase,
	limit: number,
): { localSequence: number; change: Change }[] {
	return database
		.all<PendingRow>(`${PENDING_QUERY} LIMIT ?`, [limit])
		.map((row) => ({
			localSequence: row.local_sequence,
			change: pendingRowToChange(row),
		}));
}

function hasPendingAddress(
	database: SqliteDatabase,
	address: Address,
): boolean {
	const rows =
		address.kind === 'row'
			? database.all<SqliteRow>(
					`SELECT 1 AS pending FROM row_outbox
					WHERE namespace = ? AND table_name = ? AND row_id = ? LIMIT 1`,
					[address.namespace, address.table, address.rowId],
				)
			: database.all<SqliteRow>(
					`SELECT 1 AS pending FROM value_outbox
					WHERE namespace = ? AND value_name = ? LIMIT 1`,
					[address.namespace, address.value],
				);
	return rows.length > 0;
}

function deletePending(
	database: SqliteDatabase,
	localSequences: readonly number[],
): void {
	for (const localSequence of localSequences) {
		database.run('DELETE FROM row_outbox WHERE local_sequence = ?', [
			localSequence,
		]);
		database.run('DELETE FROM value_outbox WHERE local_sequence = ?', [
			localSequence,
		]);
	}
}

function installRecord(database: SqliteDatabase, record: SyncRecord): boolean {
	if (hasPendingAddress(database, record.address)) return false;
	const existing = readFact(database, record.address);
	if (
		existing !== undefined &&
		existing.changedSequence >= record.changedSequence
	) {
		return false;
	}
	storeRecord(database, record);
	return true;
}

function sealBatch(database: SqliteDatabase, lastSealedSequence: number) {
	const pending = pendingChanges(
		database,
		DATA_ADMISSION_LIMITS.changesPerBatch,
	);
	if (pending.length === 0) return undefined;
	const seq = lastSealedSequence + 1;
	const selected: number[] = [];
	const changes: Change[] = [];
	for (const entry of pending) {
		const candidate = [...changes, entry.change];
		if (
			encodedJsonBytes({ seq, digest: '0'.repeat(64), changes: candidate }) >
			DATA_ADMISSION_LIMITS.encodedBatchBytes
		) {
			break;
		}
		selected.push(entry.localSequence);
		changes.push(entry.change);
	}
	if (changes.length === 0)
		throw new Error('One outbox change exceeds the batch admission limit');
	return {
		batch: { seq, digest: batchDigest(changes), changes },
		localSequences: selected,
	};
}

function createReplica(
	database: SqliteDatabase,
	mintReplica: () => string,
	log: Logger,
) {
	let nextLocalSequence =
		(database.all<SqliteRow & { sequence: number }>(
			`SELECT COALESCE(MAX(local_sequence), 0) AS sequence FROM (
				SELECT local_sequence FROM row_outbox
				UNION ALL SELECT local_sequence FROM value_outbox
			)`,
		)[0]?.sequence ?? 0) + 1;
	const changeListeners = new Set<(changes: readonly Address[]) => void>();
	const outboxListeners = new Set<() => void>();

	function notify(changes: readonly Address[]): void {
		if (changes.length === 0) return;
		for (const listener of changeListeners) {
			try {
				listener(changes);
			} catch (cause) {
				log.error(ReplicaError.SubscriberThrew({ cause }));
			}
		}
	}

	/**
	 * Wake the outbox subscribers for a committed local write.
	 *
	 * Contained exactly like {@link notify}: these listeners start background
	 * synchronization, so letting one throw would surface an unrelated sync
	 * failure as the local write's own rejection.
	 */
	function notifyOutbox(): void {
		for (const listener of outboxListeners) {
			try {
				listener();
			} catch (cause) {
				log.error(ReplicaError.SubscriberThrew({ cause }));
			}
		}
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
				const current = readFact(database, parsed.address);
				const folded = foldChange(current, parsed, 0);
				if (folded.kind === 'noop') return { applied: false };
				storeRecord(database, folded.record);
				enqueueChange(database, nextLocalSequence, parsed);
				nextLocalSequence += 1;
				return { applied: true };
			}),
		);
		if (result.error === null && result.data.applied) {
			notify([parsed.address]);
			notifyOutbox();
		}
		return result;
	}

	function subscribe(
		listener: (changes: readonly Address[]) => void,
	): () => void {
		changeListeners.add(listener);
		return () => changeListeners.delete(listener);
	}

	function subscribeOutbox(listener: () => void): () => void {
		outboxListeners.add(listener);
		return () => outboxListeners.delete(listener);
	}

	function readRow(
		address: RowAddress,
	): Result<JsonObject | undefined, ReplicaError> {
		if (!isRowAddress(address, DATA_ADDRESS_CEILINGS)) {
			return ReplicaError.InvalidInput({ boundary: 'row address' });
		}
		return storageResult('read row', () => {
			const record = readFact(database, address);
			return record?.kind === 'row'
				? structuredClone(record.fields)
				: undefined;
		});
	}

	function readValue(
		address: ValueAddress,
	): Result<JsonValue | undefined, ReplicaError> {
		if (!isValueAddress(address, DATA_ADDRESS_CEILINGS)) {
			return ReplicaError.InvalidInput({ boundary: 'value address' });
		}
		return storageResult('read value', () => {
			const record = readFact(database, address);
			return record?.kind === 'value'
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
			const metadataRow = storageResult('read metadata', () => {
				const row = readMetadata(database);
				if (row === undefined) throw new Error('metadata singleton is missing');
				return row;
			});
			if (metadataRow.error !== null) return metadataRow;
			const current = toMetadata(metadataRow.data);
			if (current.attachment === undefined) return ReplicaError.NotAttached();

			const outboxResult = storageResult('seal batch', () =>
				sealBatch(database, metadataRow.data.last_sealed_batch_sequence),
			);
			if (outboxResult.error !== null) return outboxResult;
			const sealed = outboxResult.data;
			const batch = sealed?.batch;
			let cursor: ExchangeRequest['cursor'];
			let isFirstPage = true;

			while (true) {
				const request: ExchangeRequest = {
					replicaId: current.replicaId,
					after: current.lastAppliedAuthoritySequence,
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
								`UPDATE metadata SET replica_id = ?,
									last_sealed_batch_sequence = 0 WHERE singleton = 1`,
								[replicaId],
							);
							// Renumber every pending intent from 1 in its existing order.
							// The forked replica starts a fresh batch sequence, so the
							// queue must start from a fresh local sequence too.
							const pending = pendingChanges(database, Number.MAX_SAFE_INTEGER);
							database.run('DELETE FROM row_outbox');
							database.run('DELETE FROM value_outbox');
							for (const [index, entry] of pending.entries()) {
								enqueueChange(database, index + 1, entry.change);
							}
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
					cursor?.position ?? current.lastAppliedAuthoritySequence;
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
						const changes = new Map<string, Address>();
						if (isFirstPage && batch !== undefined && sealed !== undefined) {
							deletePending(database, sealed.localSequences);
							database.run(
								'UPDATE metadata SET last_sealed_batch_sequence = ? WHERE singleton = 1',
								[batch.seq],
							);
						}
						for (const record of response.records) {
							if (!installRecord(database, record)) continue;
							changes.set(addressKey(record.address), record.address);
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
				() => pendingChanges(database, 1)[0],
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
			WHERE type = 'table' AND name IN (${REPLICA_TABLES.map(() => '?').join(', ')})`,
			REPLICA_TABLES,
		);
		if (tables.length === 0) {
			const replicaId = mintReplicaId();
			if (parseReplicaId(replicaId).error !== null)
				return ReplicaError.InvalidInput({ boundary: 'minted replica id' });
			database.transaction(() => createReplicaSchema(database, replicaId));
		} else if (tables.length !== REPLICA_TABLES.length) {
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
