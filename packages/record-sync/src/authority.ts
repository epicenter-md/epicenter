import {
	encodedJsonBytes,
	isAdmissibleSnapshotRow,
	RECORD_SYNC_ADMISSION_LIMITS,
} from './admission.js';
import { recordBatchChecksum } from './batch-checksum.js';
import { canonicalJson } from './canonical-json.js';
import { foldRow } from './fold.js';
import type {
	JsonObject,
	PullRequest,
	PullResponse,
	PushReceipt,
	PushRequest,
	PushResponse,
	RecordCommand,
	SnapshotChunk,
	SnapshotChunkRequest,
	SnapshotChunkResponse,
	SnapshotManifest,
	SnapshotRow,
	StateEntry,
} from './protocol.js';
import { RECORD_SYNC_PROTOCOL_MAJOR, requestRefusal } from './protocol.js';
import {
	createSnapshotChunks,
	createSnapshotManifest,
	type Sha256,
} from './snapshot.js';
import type { RecordSyncSqlite } from './sqlite.js';

const STORAGE_VERSION = 1;

type StoredMeta = {
	storage_version: number;
	protocol_major: number;
	server_sequence: number;
	tombstone_floor: number;
	snapshot_generation: number;
};

type StoredActor = {
	high_water: number;
	batch_json: string | null;
	batch_checksum: string | null;
	first_actor_sequence: number | null;
	last_actor_sequence: number | null;
	first_server_sequence: number | null;
	last_server_sequence: number | null;
};

type StoredState = {
	kind: 'row' | 'deletion';
	table_name: string;
	row_id: string;
	value_json: string | null;
	last_server_sequence: number;
};

type StoredSnapshotChunk = {
	generation: number;
	chunk_index: number;
	rows_json: string;
	checksum: string;
};

type SnapshotCapture = {
	generation: number;
	head: number;
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

function initialize(database: RecordSyncSqlite): void {
	database.transaction(() => {
		const hasCurrentMeta = Boolean(
			one<{ present: number }>(
				database,
				`SELECT 1 AS present FROM sqlite_master
				 WHERE type = 'table' AND name = 'record_sync_meta'`,
			),
		);
		const hasLegacyAuthority = Boolean(
			one<{ present: number }>(
				database,
				`SELECT 1 AS present FROM sqlite_master
				 WHERE type = 'table' AND name = 'record_sync_family'`,
			),
		);
		if (!hasCurrentMeta && hasLegacyAuthority) {
			throw new Error('Incompatible legacy record-sync authority storage');
		}
		database.run(`
			CREATE TABLE IF NOT EXISTS record_sync_meta (
				id INTEGER PRIMARY KEY CHECK(id = 1),
				storage_version INTEGER NOT NULL,
				protocol_major INTEGER NOT NULL,
				server_sequence INTEGER NOT NULL,
				tombstone_floor INTEGER NOT NULL,
				snapshot_generation INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS record_sync_actors (
				actor_id TEXT PRIMARY KEY,
				high_water INTEGER NOT NULL,
				batch_json TEXT,
				batch_checksum TEXT,
				first_actor_sequence INTEGER,
				last_actor_sequence INTEGER,
				first_server_sequence INTEGER,
				last_server_sequence INTEGER
			);
			CREATE TABLE IF NOT EXISTS record_sync_rows (
				table_name TEXT NOT NULL,
				row_id TEXT NOT NULL,
				value_json TEXT NOT NULL CHECK(json_valid(value_json)),
				last_server_sequence INTEGER NOT NULL,
				PRIMARY KEY(table_name, row_id)
			);
			CREATE INDEX IF NOT EXISTS record_sync_rows_sequence
				ON record_sync_rows(last_server_sequence);
			CREATE TABLE IF NOT EXISTS record_sync_deletions (
				table_name TEXT NOT NULL,
				row_id TEXT NOT NULL,
				last_server_sequence INTEGER NOT NULL,
				PRIMARY KEY(table_name, row_id)
			);
			CREATE INDEX IF NOT EXISTS record_sync_deletions_sequence
				ON record_sync_deletions(last_server_sequence);
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
		const stored = readMeta(database);
		if (!stored) {
			database.run(
				`INSERT INTO record_sync_meta(
					id, storage_version, protocol_major, server_sequence,
					tombstone_floor, snapshot_generation
				) VALUES (1, ?, ?, 0, 0, 0)`,
				[STORAGE_VERSION, RECORD_SYNC_PROTOCOL_MAJOR],
			);
			return;
		}
		if (
			stored.storage_version !== STORAGE_VERSION ||
			stored.protocol_major !== RECORD_SYNC_PROTOCOL_MAJOR
		) {
			throw new Error('Incompatible record-sync authority storage');
		}
	});
}

function readMeta(database: RecordSyncSqlite): StoredMeta | undefined {
	return one<StoredMeta>(
		database,
		`SELECT storage_version, protocol_major, server_sequence,
		        tombstone_floor, snapshot_generation
		 FROM record_sync_meta WHERE id = 1`,
	);
}

function requireMeta(database: RecordSyncSqlite): StoredMeta {
	const meta = readMeta(database);
	if (!meta) throw new Error('Record authority is not initialized');
	return meta;
}

function readRow(
	database: RecordSyncSqlite,
	table: string,
	rowId: string,
): JsonObject | undefined {
	const stored = one<{ value_json: string }>(
		database,
		`SELECT value_json FROM record_sync_rows
		 WHERE table_name = ? AND row_id = ?`,
		[table, rowId],
	);
	return stored ? JSON.parse(stored.value_json) : undefined;
}

class CreateConflictError extends Error {}
class RowTooLargeError extends Error {}

function applyCommand(
	database: RecordSyncSqlite,
	command: RecordCommand,
	serverSequence: number,
): void {
	const current = readRow(database, command.table, command.rowId);
	if (command.kind === 'createRow' && current !== undefined) {
		throw new CreateConflictError();
	}
	const result = foldRow(current, command);
	switch (result.kind) {
		case 'create-conflict':
			throw new CreateConflictError();
		case 'noop':
			return;
		case 'row': {
			const row: SnapshotRow = {
				table: command.table,
				rowId: command.rowId,
				value: result.value,
				lastServerSequence: serverSequence,
			};
			if (!isAdmissibleSnapshotRow(row)) throw new RowTooLargeError();
			database.run(
				`INSERT INTO record_sync_rows(
					table_name, row_id, value_json, last_server_sequence
				) VALUES (?, ?, ?, ?)
				ON CONFLICT(table_name, row_id) DO UPDATE SET
					value_json = excluded.value_json,
					last_server_sequence = excluded.last_server_sequence`,
				[
					command.table,
					command.rowId,
					JSON.stringify(result.value),
					serverSequence,
				],
			);
			database.run(
				`DELETE FROM record_sync_deletions
				 WHERE table_name = ? AND row_id = ?`,
				[command.table, command.rowId],
			);
			return;
		}
		case 'deletion':
			database.run(
				`DELETE FROM record_sync_rows
				 WHERE table_name = ? AND row_id = ?`,
				[command.table, command.rowId],
			);
			database.run(
				`INSERT INTO record_sync_deletions(
					table_name, row_id, last_server_sequence
				) VALUES (?, ?, ?)
				ON CONFLICT(table_name, row_id) DO UPDATE SET
					last_server_sequence = excluded.last_server_sequence`,
				[command.table, command.rowId, serverSequence],
			);
	}
}

function storedReceipt(
	actorId: string,
	actor: StoredActor,
): PushReceipt | null {
	if (
		actor.batch_checksum === null ||
		actor.first_actor_sequence === null ||
		actor.last_actor_sequence === null ||
		actor.first_server_sequence === null ||
		actor.last_server_sequence === null
	) {
		return null;
	}
	return {
		actorId,
		batchChecksum: actor.batch_checksum,
		firstActorSequence: actor.first_actor_sequence,
		lastActorSequence: actor.last_actor_sequence,
		firstServerSequence: actor.first_server_sequence,
		lastServerSequence: actor.last_server_sequence,
	};
}

function readManifest(database: RecordSyncSqlite): SnapshotManifest | null {
	const stored = one<{ manifest_json: string }>(
		database,
		'SELECT manifest_json FROM record_sync_snapshot_manifest WHERE id = 1',
	);
	return stored ? JSON.parse(stored.manifest_json) : null;
}

function pullPage({
	cursor,
	entries,
	hasMore,
	head,
}: {
	cursor: number;
	entries: StateEntry[];
	hasMore: boolean;
	head: number;
}): Extract<PullResponse, { ok: true; snapshotRequired: false }> {
	return {
		kind: 'pull',
		ok: true,
		snapshotRequired: false,
		fromCursor: cursor,
		entries,
		newCursor: hasMore ? (entries.at(-1)?.lastServerSequence ?? cursor) : head,
		hasMore,
	};
}

function captureSnapshot(database: RecordSyncSqlite): SnapshotCapture {
	return database.transaction(() => {
		const meta = requireMeta(database);
		return {
			generation: meta.snapshot_generation + 1,
			head: meta.server_sequence,
			rows: database
				.all<{
					table_name: string;
					row_id: string;
					value_json: string;
					last_server_sequence: number;
				}>(
					`SELECT table_name, row_id, value_json, last_server_sequence
					 FROM record_sync_rows ORDER BY table_name, row_id`,
				)
				.map((stored) => ({
					table: stored.table_name,
					rowId: stored.row_id,
					value: JSON.parse(stored.value_json),
					lastServerSequence: stored.last_server_sequence,
				})),
			actorHighWater: Object.fromEntries(
				database
					.all<{ actor_id: string; high_water: number }>(
						'SELECT actor_id, high_water FROM record_sync_actors ORDER BY actor_id',
					)
					.map((actor) => [actor.actor_id, actor.high_water]),
			),
		};
	});
}

export type SnapshotPublicationOptions = { maxChunkBytes: number };

export type RecordAuthorityCompactionPolicy = SnapshotPublicationOptions & {
	minimumRetainedSequences: number;
};

/** Open one schema-blind current-state authority over caller-owned SQLite. */
export function openRecordAuthority({
	database,
	sha256,
}: {
	database: RecordSyncSqlite;
	sha256: Sha256;
}) {
	initialize(database);

	const authority = {
		push(request: PushRequest): PushResponse {
			const refusal = requestRefusal(request);
			if (refusal) return { kind: 'push', ok: false, reason: refusal };
			const canonicalBatch = canonicalJson(request);
			const batchChecksum = recordBatchChecksum(request);
			const first = request.mutations[0];
			const last = request.mutations.at(-1);
			if (!first || !last) throw new TypeError('Push must not be empty');
			try {
				return database.transaction(() => {
					const actor = one<StoredActor>(
						database,
						`SELECT high_water, batch_json, batch_checksum,
						        first_actor_sequence, last_actor_sequence,
						        first_server_sequence, last_server_sequence
						 FROM record_sync_actors WHERE actor_id = ?`,
						[request.actorId],
					) ?? {
						high_water: 0,
						batch_json: null,
						batch_checksum: null,
						first_actor_sequence: null,
						last_actor_sequence: null,
						first_server_sequence: null,
						last_server_sequence: null,
					};
					if (first.actorSequence <= actor.high_water) {
						const receipt = storedReceipt(request.actorId, actor);
						return actor.batch_json === canonicalBatch && receipt
							? { kind: 'push', ok: true, acceptance: 'retry', receipt }
							: { kind: 'push', ok: false, reason: 'actor-fork' };
					}
					if (first.actorSequence !== actor.high_water + 1) {
						return {
							kind: 'push',
							ok: false,
							reason: 'actor-sequence-gap',
						};
					}
					const meta = requireMeta(database);
					const firstServerSequence = meta.server_sequence + 1;
					for (const [index, mutation] of request.mutations.entries()) {
						applyCommand(
							database,
							mutation.command,
							firstServerSequence + index,
						);
					}
					const lastServerSequence =
						meta.server_sequence + request.mutations.length;
					const receipt: PushReceipt = {
						actorId: request.actorId,
						batchChecksum,
						firstActorSequence: first.actorSequence,
						lastActorSequence: last.actorSequence,
						firstServerSequence,
						lastServerSequence,
					};
					database.run(
						`INSERT INTO record_sync_actors(
							actor_id, high_water, batch_json, batch_checksum,
							first_actor_sequence, last_actor_sequence,
							first_server_sequence, last_server_sequence
						) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
						ON CONFLICT(actor_id) DO UPDATE SET
							high_water = excluded.high_water,
							batch_json = excluded.batch_json,
							batch_checksum = excluded.batch_checksum,
							first_actor_sequence = excluded.first_actor_sequence,
							last_actor_sequence = excluded.last_actor_sequence,
							first_server_sequence = excluded.first_server_sequence,
							last_server_sequence = excluded.last_server_sequence`,
						[
							request.actorId,
							last.actorSequence,
							canonicalBatch,
							batchChecksum,
							first.actorSequence,
							last.actorSequence,
							firstServerSequence,
							lastServerSequence,
						],
					);
					database.run(
						'UPDATE record_sync_meta SET server_sequence = ? WHERE id = 1',
						[lastServerSequence],
					);
					return { kind: 'push', ok: true, acceptance: 'accepted', receipt };
				});
			} catch (error) {
				if (error instanceof CreateConflictError) {
					return { kind: 'push', ok: false, reason: 'create-conflict' };
				}
				if (error instanceof RowTooLargeError) {
					return { kind: 'push', ok: false, reason: 'row-too-large' };
				}
				throw error;
			}
		},

		pull(request: PullRequest): PullResponse {
			const refusal = requestRefusal(request);
			if (refusal) return { kind: 'pull', ok: false, reason: refusal };
			return database.transaction(() => {
				const meta = requireMeta(database);
				if (request.cursor > meta.server_sequence) {
					throw new TypeError('Pull cursor is ahead of the authority');
				}
				if (request.cursor < meta.tombstone_floor) {
					const manifest = readManifest(database);
					if (!manifest || manifest.head < meta.tombstone_floor) {
						throw new Error('Tombstone floor has no covering snapshot');
					}
					return {
						kind: 'pull',
						ok: true,
						snapshotRequired: true,
						manifest,
					};
				}
				const stored = database.all<StoredState>(
					`SELECT kind, table_name, row_id, value_json, last_server_sequence
					 FROM (
						SELECT 'row' AS kind, table_name, row_id, value_json,
						       last_server_sequence
						FROM record_sync_rows
						UNION ALL
						SELECT 'deletion' AS kind, table_name, row_id, NULL AS value_json,
						       last_server_sequence
						FROM record_sync_deletions
					 )
					 WHERE last_server_sequence > ?
					 ORDER BY last_server_sequence, table_name, row_id
					 LIMIT ?`,
					[request.cursor, request.limit + 1],
				);
				let entries: StateEntry[] = stored
					.slice(0, request.limit)
					.map((entry) =>
						entry.kind === 'row'
							? {
									kind: 'row',
									table: entry.table_name,
									rowId: entry.row_id,
									value: JSON.parse(entry.value_json as string),
									lastServerSequence: entry.last_server_sequence,
								}
							: {
									kind: 'deletion',
									table: entry.table_name,
									rowId: entry.row_id,
									lastServerSequence: entry.last_server_sequence,
								},
					);
				let hasMore = stored.length > entries.length;
				let response = pullPage({
					cursor: request.cursor,
					entries,
					hasMore,
					head: meta.server_sequence,
				});
				while (
					encodedJsonBytes(response) >
					RECORD_SYNC_ADMISSION_LIMITS.encodedPullBytes
				) {
					if (entries.length <= 1) {
						throw new Error(
							'One admitted state entry exceeds the pull byte limit',
						);
					}
					entries = entries.slice(0, -1);
					hasMore = true;
					response = pullPage({
						cursor: request.cursor,
						entries,
						hasMore,
						head: meta.server_sequence,
					});
				}
				return response;
			});
		},

		async publishSnapshot({
			maxChunkBytes,
		}: SnapshotPublicationOptions): Promise<SnapshotManifest | undefined> {
			if (
				!Number.isSafeInteger(maxChunkBytes) ||
				maxChunkBytes < 1 ||
				maxChunkBytes > RECORD_SYNC_ADMISSION_LIMITS.encodedSnapshotChunkBytes
			) {
				throw new TypeError('Invalid snapshot chunk byte limit');
			}
			const capture = captureSnapshot(database);
			const chunks = await createSnapshotChunks(sha256, {
				generation: capture.generation,
				rows: capture.rows,
				maxChunkBytes,
			});
			const manifest = await createSnapshotManifest(sha256, {
				generation: capture.generation,
				head: capture.head,
				chunkChecksums: chunks.map((chunk) => chunk.checksum),
				actorHighWater: capture.actorHighWater,
			});
			return database.transaction(() => {
				const meta = requireMeta(database);
				if (
					meta.server_sequence !== capture.head ||
					meta.snapshot_generation + 1 !== capture.generation
				) {
					return undefined;
				}
				database.run('DELETE FROM record_sync_snapshot_chunks');
				for (const chunk of chunks) {
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
				}
				database.run(
					`INSERT INTO record_sync_snapshot_manifest(id, manifest_json)
					 VALUES (1, ?)
					 ON CONFLICT(id) DO UPDATE SET manifest_json = excluded.manifest_json`,
					[JSON.stringify(manifest)],
				);
				database.run(
					'UPDATE record_sync_meta SET snapshot_generation = ? WHERE id = 1',
					[capture.generation],
				);
				return manifest;
			});
		},

		compactDeletionsThrough(requestedFloor: number): number {
			if (!Number.isSafeInteger(requestedFloor) || requestedFloor < 0) {
				throw new TypeError('Compaction floor must be a non-negative integer');
			}
			return database.transaction(() => {
				const meta = requireMeta(database);
				const manifest = readManifest(database);
				if (!manifest) throw new Error('Publish a snapshot before compaction');
				const floor = Math.max(
					meta.tombstone_floor,
					Math.min(requestedFloor, manifest.head, meta.server_sequence),
				);
				database.run(
					'DELETE FROM record_sync_deletions WHERE last_server_sequence <= ?',
					[floor],
				);
				database.run(
					'UPDATE record_sync_meta SET tombstone_floor = ? WHERE id = 1',
					[floor],
				);
				return floor;
			});
		},

		async maybePublishSnapshot({
			minimumRetainedSequences,
			maxChunkBytes,
		}: RecordAuthorityCompactionPolicy): Promise<SnapshotManifest | undefined> {
			if (
				!Number.isSafeInteger(minimumRetainedSequences) ||
				minimumRetainedSequences < 0
			) {
				throw new TypeError('Invalid retained sequence count');
			}
			const meta = requireMeta(database);
			if (
				meta.server_sequence - meta.tombstone_floor <=
				minimumRetainedSequences
			) {
				return undefined;
			}
			const manifest = await authority.publishSnapshot({ maxChunkBytes });
			if (manifest) authority.compactDeletionsThrough(manifest.head);
			return manifest;
		},

		snapshotChunk(request: SnapshotChunkRequest): SnapshotChunkResponse {
			const refusal = requestRefusal(request);
			if (refusal) {
				return { kind: 'snapshotChunk', ok: false, reason: refusal };
			}
			const manifest = readManifest(database);
			if (!manifest || manifest.generation !== request.generation) {
				return {
					kind: 'snapshotChunk',
					ok: false,
					reason: 'snapshot-replaced',
				};
			}
			const stored = one<StoredSnapshotChunk>(
				database,
				`SELECT generation, chunk_index, rows_json, checksum
				 FROM record_sync_snapshot_chunks WHERE chunk_index = ?`,
				[request.index],
			);
			if (!stored) {
				return {
					kind: 'snapshotChunk',
					ok: false,
					reason: 'chunk-out-of-range',
				};
			}
			const chunk: SnapshotChunk = {
				generation: stored.generation,
				index: stored.chunk_index,
				rows: JSON.parse(stored.rows_json),
				checksum: stored.checksum,
			};
			return { kind: 'snapshotChunk', ok: true, chunk };
		},

		inspect() {
			const meta = requireMeta(database);
			return {
				head: meta.server_sequence,
				tombstoneFloor: meta.tombstone_floor,
				rows: database
					.all<{
						table_name: string;
						row_id: string;
						value_json: string;
						last_server_sequence: number;
					}>(
						`SELECT table_name, row_id, value_json, last_server_sequence
						 FROM record_sync_rows ORDER BY table_name, row_id`,
					)
					.map((row) => ({
						table: row.table_name,
						rowId: row.row_id,
						value: JSON.parse(row.value_json),
						lastServerSequence: row.last_server_sequence,
					})),
				deletions: database.all<{
					table: string;
					rowId: string;
					lastServerSequence: number;
				}>(
					`SELECT table_name AS "table", row_id AS rowId,
					        last_server_sequence AS lastServerSequence
					 FROM record_sync_deletions ORDER BY table_name, row_id`,
				),
				actorHighWater: Object.fromEntries(
					database
						.all<{ actor_id: string; high_water: number }>(
							'SELECT actor_id, high_water FROM record_sync_actors ORDER BY actor_id',
						)
						.map((actor) => [actor.actor_id, actor.high_water]),
				),
			};
		},
	};

	return authority;
}

export type RecordAuthority = ReturnType<typeof openRecordAuthority>;
