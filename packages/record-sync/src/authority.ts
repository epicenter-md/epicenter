import { foldRow, type LogicalRow } from './fold.js';
import type {
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
import { requestRefusal } from './protocol.js';
import {
	createSnapshotChunk,
	createSnapshotManifest,
	type Sha256,
} from './snapshot.js';
import type { RecordSyncSqlite } from './sqlite.js';

const STORAGE_VERSION = 1;

type StoredRow = {
	table_name: string;
	row_id: string;
	cells_json: string;
	deleted: number;
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
				deleted INTEGER NOT NULL,
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
			schemaEpochId: envelope.schemaEpochId,
			databaseIncarnationId: envelope.databaseIncarnationId,
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

function readLogicalRow(
	database: RecordSyncSqlite,
	table: string,
	rowId: string,
): LogicalRow | undefined {
	const stored = one<StoredRow>(
		database,
		`SELECT table_name, row_id, cells_json, deleted
		 FROM record_sync_canonical_rows
		 WHERE table_name = ? AND row_id = ?`,
		[table, rowId],
	);
	if (!stored) return undefined;
	return stored.deleted
		? { kind: 'tombstone' }
		: {
				kind: 'live',
				cells: JSON.parse(stored.cells_json),
			};
}

function applyOperation(
	database: RecordSyncSqlite,
	operation: Operation,
): void {
	const next = foldRow(
		readLogicalRow(database, operation.table, operation.rowId),
		operation,
	);
	database.run(
		`INSERT INTO record_sync_canonical_rows(
			table_name, row_id, cells_json, deleted
		) VALUES (?, ?, ?, ?)
		ON CONFLICT(table_name, row_id) DO UPDATE SET
			cells_json = excluded.cells_json,
			deleted = excluded.deleted`,
		[
			operation.table,
			operation.rowId,
			next.kind === 'live' ? JSON.stringify(next.cells) : '{}',
			next.kind === 'tombstone' ? 1 : 0,
		],
	);
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
				`SELECT table_name, row_id, cells_json, deleted
				 FROM record_sync_canonical_rows
				 ORDER BY table_name, row_id`,
			)
			.map((row) => ({
				table: row.table_name,
				rowId: row.row_id,
				deleted: Boolean(row.deleted),
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
	rowsPerChunk: number,
): Promise<{ manifest: SnapshotManifest; chunks: SnapshotChunk[] }> {
	const pages: SnapshotRow[][] = [];
	for (let start = 0; start < capture.rows.length; start += rowsPerChunk)
		pages.push(capture.rows.slice(start, start + rowsPerChunk));
	if (pages.length === 0) pages.push([]);
	const chunks = await Promise.all(
		pages.map((rows, index) =>
			createSnapshotChunk(sha256, capture.generation, index, rows),
		),
	);
	const manifest = await createSnapshotManifest(sha256, {
		generation: capture.generation,
		snapshotSequence: capture.snapshotSequence,
		chunkChecksums: chunks.map(({ checksum }) => checksum),
		actorHighWater: capture.actorHighWater,
	});
	return { manifest, chunks };
}

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

	return {
		push(request: PushRequest): PushResponse {
			const refusal = requestRefusal(request, envelope);
			if (refusal) return { kind: 'push', ok: false, reason: refusal };
			let response: PushResponse = { kind: 'push', ok: true };
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
						response = {
							kind: 'push',
							ok: false,
							reason: 'actor-sequence-gap',
						};
						return;
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
			return response;
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

		async publishSnapshot(rowsPerChunk: number): Promise<SnapshotManifest> {
			if (!Number.isSafeInteger(rowsPerChunk) || rowsPerChunk < 1)
				throw new TypeError('rowsPerChunk must be a positive integer');
			for (;;) {
				const capture = captureSnapshot(database);
				const encoded = await encodeSnapshot(sha256, capture, rowsPerChunk);
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
