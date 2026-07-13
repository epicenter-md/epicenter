import {
	isAdmissibleSnapshotRow,
	isBoundedRecordsSchemaHash,
	RECORD_SYNC_ADMISSION_LIMITS,
} from './admission.js';
import { foldRow } from './fold.js';
import type {
	Cells,
	LoggedMutation,
	Operation,
	PullRequest,
	PullResponse,
	PushRequest,
	PushResponse,
	RequestEnvelope,
	SnapshotChunk,
	SnapshotChunkRequest,
	SnapshotChunkResponse,
	SnapshotManifest,
	SnapshotRow,
} from './protocol.js';
import { RECORD_SYNC_PROTOCOL_MAJOR, requestRefusal } from './protocol.js';
import {
	createSnapshotChunk,
	createSnapshotManifest,
	type Sha256,
} from './snapshot.js';
import type { RecordSyncSqlite } from './sqlite.js';

const STORAGE_VERSION = 1;

export type RecordAuthorityBindingRequest = {
	protocolMajor: number;
	recordsSchemaHash: string;
};

export type RecordAuthorityBindingResult =
	| { ok: true; databaseId: string }
	| {
			ok: false;
			reason: 'protocol-mismatch' | 'records-schema-mismatch';
	  };

/** Parse the exact first-open authority binding shared by every transport. */
export function parseRecordAuthorityBindingRequest(
	value: unknown,
): RecordAuthorityBindingRequest {
	if (
		typeof value !== 'object' ||
		value === null ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype ||
		Object.keys(value).length !== 2 ||
		!Object.hasOwn(value, 'protocolMajor') ||
		!Object.hasOwn(value, 'recordsSchemaHash')
	) {
		throw new TypeError('Invalid record authority binding request');
	}
	const { protocolMajor, recordsSchemaHash } = value as Record<string, unknown>;
	if (
		!Number.isSafeInteger(protocolMajor) ||
		(protocolMajor as number) < 1 ||
		typeof recordsSchemaHash !== 'string' ||
		!isBoundedRecordsSchemaHash(recordsSchemaHash)
	) {
		throw new TypeError('Invalid record authority binding request');
	}
	return { protocolMajor: protocolMajor as number, recordsSchemaHash };
}

type StoredRow = {
	table_name: string;
	row_id: string;
	cells_json: string;
};
type StoredMutation = {
	server_sequence: number;
	actor_id: string;
	actor_sequence: number;
	operations_json: string;
};
type CapturedSnapshot = {
	generation: number;
	snapshotSequence: number;
	rows: SnapshotRow[];
	actorHighWater: Record<string, number>;
};

function one<TRow extends Record<string, string | number | null>>(
	database: RecordSyncSqlite,
	sql: string,
	parameters: readonly (string | number | null)[] = [],
): TRow | undefined {
	return database.all<TRow>(sql, parameters)[0];
}

function readStoredEnvelope(
	database: RecordSyncSqlite,
): RequestEnvelope | null {
	const hasMetadata = one<{ present: number }>(
		database,
		`SELECT 1 AS present FROM sqlite_master
		 WHERE type = 'table' AND name = 'record_sync_meta'`,
	);
	if (!hasMetadata) return null;
	const metadata = Object.fromEntries(
		database
			.all<{ key: string; value: string }>(
				`SELECT key, value FROM record_sync_meta
				 WHERE key IN ('protocolMajor', 'recordsSchemaHash', 'databaseId')`,
			)
			.map(({ key, value }) => [key, value]),
	);
	const protocolMajor = Number(metadata.protocolMajor);
	if (
		!Number.isSafeInteger(protocolMajor) ||
		protocolMajor < 1 ||
		!metadata.recordsSchemaHash ||
		!metadata.databaseId
	)
		throw new Error('Incomplete record-sync identity metadata');
	return {
		protocolMajor,
		recordsSchemaHash: metadata.recordsSchemaHash,
		databaseId: metadata.databaseId,
	};
}

export function recordAuthorityBindingRefusal(
	request: RecordAuthorityBindingRequest,
	envelope: RequestEnvelope,
): Extract<RecordAuthorityBindingResult, { ok: false }> | null {
	if (
		request.protocolMajor !== RECORD_SYNC_PROTOCOL_MAJOR ||
		request.protocolMajor !== envelope.protocolMajor
	)
		return { ok: false, reason: 'protocol-mismatch' };
	if (request.recordsSchemaHash !== envelope.recordsSchemaHash)
		return { ok: false, reason: 'records-schema-mismatch' };
	return null;
}

function initialize(
	database: RecordSyncSqlite,
	envelope: RequestEnvelope,
): void {
	database.transaction(() => {
		database.run(`
			CREATE TABLE IF NOT EXISTS record_sync_meta (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS record_sync_actor_high_water (
				actor_id TEXT PRIMARY KEY,
				sequence INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS record_sync_mutation_log (
				server_sequence INTEGER PRIMARY KEY,
				actor_id TEXT NOT NULL,
				actor_sequence INTEGER NOT NULL,
				operations_json TEXT NOT NULL,
				UNIQUE(actor_id, actor_sequence)
			);
			CREATE TABLE IF NOT EXISTS record_sync_canonical_rows (
				table_name TEXT NOT NULL,
				row_id TEXT NOT NULL,
				cells_json TEXT NOT NULL,
				PRIMARY KEY(table_name, row_id)
			);
			CREATE TABLE IF NOT EXISTS record_sync_snapshot_manifest (
				id INTEGER PRIMARY KEY CHECK(id = 1),
				manifest_json TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS record_sync_snapshot_chunks (
				chunk_index INTEGER PRIMARY KEY,
				generation INTEGER NOT NULL,
				rows_json TEXT NOT NULL,
				checksum TEXT NOT NULL
			);
		`);

		const identity = {
			storageVersion: STORAGE_VERSION,
			protocolMajor: envelope.protocolMajor,
			recordsSchemaHash: envelope.recordsSchemaHash,
			databaseId: envelope.databaseId,
		};
		const initial = {
			...identity,
			serverSequence: 0,
			watermark: 0,
			snapshotGeneration: 0,
		};
		for (const [key, value] of Object.entries(initial))
			database.run(
				'INSERT OR IGNORE INTO record_sync_meta(key, value) VALUES (?, ?)',
				[key, String(value)],
			);

		for (const [key, expected] of Object.entries(identity)) {
			const stored = one<{ value: string }>(
				database,
				'SELECT value FROM record_sync_meta WHERE key = ?',
				[key],
			)?.value;
			if (stored !== String(expected))
				throw new Error(`record-sync identity mismatch for ${key}`);
		}
	});
}

function readMeta(database: RecordSyncSqlite, key: string): number {
	const value = one<{ value: string }>(
		database,
		'SELECT value FROM record_sync_meta WHERE key = ?',
		[key],
	)?.value;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 0)
		throw new Error(`Invalid record-sync metadata: ${key}`);
	return parsed;
}

function writeMeta(
	database: RecordSyncSqlite,
	key: string,
	value: number,
): void {
	database.run('UPDATE record_sync_meta SET value = ? WHERE key = ?', [
		String(value),
		key,
	]);
}

function readCanonicalCells(
	database: RecordSyncSqlite,
	table: string,
	rowId: string,
): Cells | undefined {
	const stored = one<StoredRow>(
		database,
		`SELECT table_name, row_id, cells_json
		 FROM record_sync_canonical_rows
		 WHERE table_name = ? AND row_id = ?`,
		[table, rowId],
	);
	return stored ? JSON.parse(stored.cells_json) : undefined;
}

/** Internal sentinel that rolls the whole push transaction back. */
class CreateConflictError extends Error {
	constructor(operation: Operation) {
		super(
			`createRow named live identity '${operation.table}.${operation.rowId}'`,
		);
		this.name = 'CreateConflictError';
	}
}

/** Internal sentinel that rolls back a row that snapshots cannot carry. */
class RowTooLargeError extends Error {
	constructor(operation: Operation) {
		super(
			`row exceeds snapshot admission at '${operation.table}.${operation.rowId}'`,
		);
		this.name = 'RowTooLargeError';
	}
}

/** Internal sentinel that rolls the whole push transaction back. */
class ActorSequenceGapError extends Error {
	constructor() {
		super('actor sequence gap');
		this.name = 'ActorSequenceGapError';
	}
}

function applyOperation(
	database: RecordSyncSqlite,
	operation: Operation,
): void {
	const result = foldRow(
		readCanonicalCells(database, operation.table, operation.rowId),
		operation,
	);
	switch (result.kind) {
		case 'created':
		case 'updated':
			if (
				!isAdmissibleSnapshotRow({
					table: operation.table,
					rowId: operation.rowId,
					cells: result.cells,
				})
			) {
				throw new RowTooLargeError(operation);
			}
			database.run(
				`INSERT INTO record_sync_canonical_rows(
					table_name, row_id, cells_json
				) VALUES (?, ?, ?)
				ON CONFLICT(table_name, row_id) DO UPDATE SET
					cells_json = excluded.cells_json`,
				[operation.table, operation.rowId, JSON.stringify(result.cells)],
			);
			return;
		case 'deleted':
			database.run(
				`DELETE FROM record_sync_canonical_rows
				 WHERE table_name = ? AND row_id = ?`,
				[operation.table, operation.rowId],
			);
			return;
		case 'noop':
			return;
		case 'create-conflict':
			throw new CreateConflictError(operation);
	}
}

function readManifest(database: RecordSyncSqlite): SnapshotManifest | null {
	const stored = one<{ manifest_json: string }>(
		database,
		'SELECT manifest_json FROM record_sync_snapshot_manifest WHERE id = 1',
	);
	return stored ? JSON.parse(stored.manifest_json) : null;
}

function captureSnapshot(database: RecordSyncSqlite): CapturedSnapshot {
	return database.transaction(() => ({
		generation: readMeta(database, 'snapshotGeneration') + 1,
		snapshotSequence: readMeta(database, 'serverSequence'),
		rows: database
			.all<StoredRow>(
				`SELECT table_name, row_id, cells_json
				 FROM record_sync_canonical_rows
				 ORDER BY table_name, row_id`,
			)
			.map((row) => ({
				table: row.table_name,
				rowId: row.row_id,
				cells: JSON.parse(row.cells_json),
			})),
		actorHighWater: Object.fromEntries(
			database
				.all<{ actor_id: string; sequence: number }>(
					`SELECT actor_id, sequence
					 FROM record_sync_actor_high_water
					 ORDER BY actor_id`,
				)
				.map((row) => [row.actor_id, row.sequence]),
		),
	}));
}

async function encodeSnapshot(
	sha256: Sha256,
	capture: CapturedSnapshot,
	maxChunkBytes: number,
): Promise<{ manifest: SnapshotManifest; chunks: SnapshotChunk[] }> {
	const pages: SnapshotRow[][] = [];
	let rows: SnapshotRow[] = [];
	let contentBytes = 0;
	for (const row of capture.rows) {
		const rowBytes = encodedBytes(row);
		const separatorBytes = rows.length === 0 ? 0 : 1;
		const baseBytes = encodedBytes({
			generation: capture.generation,
			index: pages.length,
			rows: [],
			checksum: '0'.repeat(64),
		});
		if (baseBytes + contentBytes + separatorBytes + rowBytes <= maxChunkBytes) {
			rows.push(row);
			contentBytes += separatorBytes + rowBytes;
			continue;
		}
		if (rows.length === 0)
			throw new Error('Snapshot row exceeds maxChunkBytes');
		pages.push(rows);
		rows = [row];
		contentBytes = rowBytes;
		const nextBaseBytes = encodedBytes({
			generation: capture.generation,
			index: pages.length,
			rows: [],
			checksum: '0'.repeat(64),
		});
		if (nextBaseBytes + rowBytes > maxChunkBytes)
			throw new Error('Snapshot row exceeds maxChunkBytes');
	}
	pages.push(rows);
	const chunks = await Promise.all(
		pages.map((page, index) =>
			createSnapshotChunk(sha256, capture.generation, index, page),
		),
	);
	if (chunks.some((chunk) => encodedBytes(chunk) > maxChunkBytes))
		throw new Error('Snapshot checksum encoding exceeds maxChunkBytes');
	const manifest = await createSnapshotManifest(sha256, {
		generation: capture.generation,
		snapshotSequence: capture.snapshotSequence,
		chunkChecksums: chunks.map(({ checksum }) => checksum),
		actorHighWater: capture.actorHighWater,
	});
	return { manifest, chunks };
}

function encodedBytes(value: unknown): number {
	return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export type SnapshotPublicationOptions = {
	maxChunkBytes: number;
};

export type RecordAuthorityCompactionPolicy = SnapshotPublicationOptions & {
	mutationThreshold: number;
};

export function createRecordAuthority({
	database,
	envelope,
	sha256,
}: {
	database: RecordSyncSqlite;
	envelope: RequestEnvelope;
	sha256: Sha256;
}) {
	initialize(database, envelope);

	async function publishSnapshot({
		maxChunkBytes,
	}: SnapshotPublicationOptions): Promise<SnapshotManifest> {
		if (
			!Number.isSafeInteger(maxChunkBytes) ||
			maxChunkBytes < 1 ||
			maxChunkBytes > RECORD_SYNC_ADMISSION_LIMITS.encodedSnapshotChunkBytes
		) {
			throw new TypeError(
				`maxChunkBytes must be an integer from 1 through ${RECORD_SYNC_ADMISSION_LIMITS.encodedSnapshotChunkBytes}`,
			);
		}
		for (;;) {
			const capture = captureSnapshot(database);
			const encoded = await encodeSnapshot(sha256, capture, maxChunkBytes);
			const published = database.transaction(() => {
				if (
					readMeta(database, 'serverSequence') !== capture.snapshotSequence ||
					readMeta(database, 'snapshotGeneration') + 1 !== capture.generation
				)
					return false;
				database.run('DELETE FROM record_sync_snapshot_chunks');
				for (const chunk of encoded.chunks)
					database.run(
						`INSERT INTO record_sync_snapshot_chunks(
							chunk_index, generation, rows_json, checksum
						) VALUES (?, ?, ?, ?)`,
						[
							chunk.index,
							chunk.generation,
							JSON.stringify(chunk.rows),
							chunk.checksum,
						],
					);
				database.run(
					`INSERT INTO record_sync_snapshot_manifest(id, manifest_json)
					 VALUES (1, ?)
					 ON CONFLICT(id) DO UPDATE SET
						manifest_json = excluded.manifest_json`,
					[JSON.stringify(encoded.manifest)],
				);
				writeMeta(database, 'watermark', capture.snapshotSequence);
				writeMeta(database, 'snapshotGeneration', capture.generation);
				database.run(
					`DELETE FROM record_sync_mutation_log
					 WHERE server_sequence <= ?`,
					[capture.snapshotSequence],
				);
				return true;
			});
			if (published) return encoded.manifest;
		}
	}

	return {
		push(request: PushRequest): PushResponse {
			const refusal = requestRefusal(request, envelope);
			if (refusal) return { kind: 'push', ok: false, reason: refusal };
			try {
				database.transaction(() => {
					for (const mutation of request.mutations) {
						const highWater =
							one<{ sequence: number }>(
								database,
								`SELECT sequence FROM record_sync_actor_high_water
								 WHERE actor_id = ?`,
								[mutation.actorId],
							)?.sequence ?? 0;
						if (mutation.actorSequence <= highWater) continue;
						if (mutation.actorSequence !== highWater + 1) {
							throw new ActorSequenceGapError();
						}
						const serverSequence = readMeta(database, 'serverSequence') + 1;
						for (const operation of mutation.operations)
							applyOperation(database, operation);
						database.run(
							`INSERT INTO record_sync_mutation_log(
								server_sequence, actor_id, actor_sequence, operations_json
							) VALUES (?, ?, ?, ?)`,
							[
								serverSequence,
								mutation.actorId,
								mutation.actorSequence,
								JSON.stringify(mutation.operations),
							],
						);
						database.run(
							`INSERT INTO record_sync_actor_high_water(actor_id, sequence)
							 VALUES (?, ?)
							 ON CONFLICT(actor_id) DO UPDATE SET sequence = excluded.sequence`,
							[mutation.actorId, mutation.actorSequence],
						);
						writeMeta(database, 'serverSequence', serverSequence);
					}
				});
			} catch (error) {
				if (error instanceof ActorSequenceGapError) {
					return { kind: 'push', ok: false, reason: 'actor-sequence-gap' };
				}
				if (error instanceof RowTooLargeError) {
					return { kind: 'push', ok: false, reason: 'row-too-large' };
				}
				if (!(error instanceof CreateConflictError)) throw error;
				// The thrown sentinel rolled back the whole push, so no mutation
				// from this batch was accepted and the actor stays paused.
				return { kind: 'push', ok: false, reason: 'create-conflict' };
			}
			return { kind: 'push', ok: true };
		},

		pull(request: PullRequest): PullResponse {
			const refusal = requestRefusal(request, envelope);
			if (refusal) return { kind: 'pull', ok: false, reason: refusal };
			return database.transaction(() => {
				if (request.cursor < readMeta(database, 'watermark')) {
					const manifest = readManifest(database);
					if (!manifest)
						throw new Error('record-sync watermark has no snapshot');
					return {
						kind: 'pull',
						ok: true,
						snapshotRequired: true,
						manifest,
					};
				}
				const mutations: LoggedMutation[] = database
					.all<StoredMutation>(
						`SELECT server_sequence, actor_id, actor_sequence, operations_json
						 FROM record_sync_mutation_log
						 WHERE server_sequence > ?
						 ORDER BY server_sequence
						 LIMIT ?`,
						[request.cursor, request.limit],
					)
					.map((row) => ({
						serverSequence: row.server_sequence,
						actorId: row.actor_id,
						actorSequence: row.actor_sequence,
						operations: JSON.parse(row.operations_json),
					}));
				const newCursor = mutations.at(-1)?.serverSequence ?? request.cursor;
				return {
					kind: 'pull',
					ok: true,
					snapshotRequired: false,
					fromCursor: request.cursor,
					mutations,
					newCursor,
					hasMore: newCursor < readMeta(database, 'serverSequence'),
				};
			});
		},

		publishSnapshot,

		async maybePublishSnapshot({
			mutationThreshold,
			maxChunkBytes,
		}: RecordAuthorityCompactionPolicy): Promise<SnapshotManifest | null> {
			if (!Number.isSafeInteger(mutationThreshold) || mutationThreshold < 1)
				throw new TypeError('mutationThreshold must be a positive integer');
			const pending = database.transaction(
				() =>
					readMeta(database, 'serverSequence') -
					readMeta(database, 'watermark'),
			);
			return pending < mutationThreshold
				? null
				: publishSnapshot({ maxChunkBytes });
		},

		snapshotChunk(request: SnapshotChunkRequest): SnapshotChunkResponse {
			const refusal = requestRefusal(request, envelope);
			if (refusal) return { kind: 'snapshotChunk', ok: false, reason: refusal };
			return database.transaction(() => {
				const manifest = readManifest(database);
				if (!manifest || manifest.generation !== request.generation)
					return {
						kind: 'snapshotChunk',
						ok: false,
						reason: 'snapshot-replaced',
					};
				const stored = one<{
					generation: number;
					rows_json: string;
					checksum: string;
				}>(
					database,
					`SELECT generation, rows_json, checksum
					 FROM record_sync_snapshot_chunks
					 WHERE chunk_index = ?`,
					[request.index],
				);
				if (!stored)
					return {
						kind: 'snapshotChunk',
						ok: false,
						reason: 'chunk-out-of-range',
					};
				return {
					kind: 'snapshotChunk',
					ok: true,
					chunk: {
						generation: stored.generation,
						index: request.index,
						rows: JSON.parse(stored.rows_json),
						checksum: stored.checksum,
					},
				};
			});
		},
	};
}

export type RecordAuthority = ReturnType<typeof createRecordAuthority>;

export type OpenedRecordAuthority = {
	envelope: RequestEnvelope;
	authority: RecordAuthority;
};

/** Restore an authority that was previously bound, or return null if unopened. */
export function restoreRecordAuthority({
	database,
	sha256,
}: {
	database: RecordSyncSqlite;
	sha256: Sha256;
}): OpenedRecordAuthority | null {
	const envelope = readStoredEnvelope(database);
	return envelope
		? {
				envelope,
				authority: createRecordAuthority({ database, envelope, sha256 }),
			}
		: null;
}

/** Bind an authority exactly once, refusing incompatible later open requests. */
export function openRecordAuthority({
	database,
	request,
	createDatabaseId,
	sha256,
}: {
	database: RecordSyncSqlite;
	request: RecordAuthorityBindingRequest;
	createDatabaseId(): string;
	sha256: Sha256;
}):
	| ({ ok: true; databaseId: string } & OpenedRecordAuthority)
	| Extract<RecordAuthorityBindingResult, { ok: false }> {
	request = parseRecordAuthorityBindingRequest(request);
	const stored = readStoredEnvelope(database);
	if (stored) {
		const refusal = recordAuthorityBindingRefusal(request, stored);
		if (refusal) return refusal;
		return {
			ok: true,
			databaseId: stored.databaseId,
			envelope: stored,
			authority: createRecordAuthority({ database, envelope: stored, sha256 }),
		};
	}
	if (request.protocolMajor !== RECORD_SYNC_PROTOCOL_MAJOR)
		return { ok: false, reason: 'protocol-mismatch' };
	const databaseId = createDatabaseId();
	if (databaseId.trim() === '')
		throw new TypeError('databaseId must not be empty');
	const envelope = { ...request, databaseId };
	const authority = createRecordAuthority({ database, envelope, sha256 });
	return {
		ok: true,
		databaseId,
		envelope,
		authority,
	};
}
