import {
	encodedJsonBytes,
	RECORD_SYNC_ADMISSION_LIMITS,
} from './admission.js';
import { foldRow } from './fold.js';
import type {
	JsonObject,
	RecordCommand,
	SnapshotBodyUpdate,
	SnapshotChunk,
	SnapshotChunkRequest,
	SnapshotChunkResponse,
	SnapshotManifest,
	SnapshotRow,
	StateEntry,
	SyncRequest,
	SyncResponse,
	SyncToken,
} from './protocol.js';
import { RECORD_SYNC_PROTOCOL_MAJOR, requestRefusal } from './protocol.js';
import { recordRoundDigest } from './round-digest.js';
import {
	createSnapshotChunks,
	createSnapshotManifest,
	type Sha256,
} from './snapshot.js';
import type { RecordSyncSqlite } from './sqlite.js';

const STORAGE_VERSION = 2;

/**
 * Merge one row's ordered opaque body updates into one baseline update
 * (ADR-0133). Injected so the sync core stays CRDT-library-free; an authority
 * without it keeps an unbounded per-row log between snapshots.
 */
export type MergeBodyUpdates = (updates: Uint8Array[]) => Uint8Array;

type StoredMeta = {
	storage_version: number;
	protocol_major: number;
	server_sequence: number;
	tombstone_floor: number;
	snapshot_generation: number;
};

type StoredReplica = {
	accepted_round: number;
	request_digest: string;
};

type StoredState = {
	kind: 'row' | 'deletion' | 'bodyUpdate';
	table_name: string;
	row_id: string;
	value_json: string | null;
	last_server_sequence: number;
};

type StoredSnapshotChunk = {
	generation: number;
	chunk_index: number;
	rows_json: string;
	bodies_json: string;
	checksum: string;
};

type SnapshotCapture = {
	generation: number;
	head: number;
	rows: SnapshotRow[];
	bodies: SnapshotBodyUpdate[];
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
		const hasLegacyStorage = Boolean(
			one<{ present: number }>(
				database,
				`SELECT 1 AS present FROM sqlite_master
				 WHERE type = 'table'
				   AND name IN ('record_sync_family', 'record_sync_actors')`,
			),
		);
		if (hasLegacyStorage) {
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
			CREATE TABLE IF NOT EXISTS record_sync_replicas (
				replica_id TEXT PRIMARY KEY,
				accepted_round INTEGER NOT NULL,
				request_digest TEXT NOT NULL
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
			CREATE TABLE IF NOT EXISTS record_sync_body_updates (
				table_name TEXT NOT NULL,
				row_id TEXT NOT NULL,
				update_b64 TEXT NOT NULL,
				last_server_sequence INTEGER NOT NULL,
				PRIMARY KEY(table_name, row_id, last_server_sequence)
			);
			CREATE INDEX IF NOT EXISTS record_sync_body_updates_sequence
				ON record_sync_body_updates(last_server_sequence);
			CREATE TABLE IF NOT EXISTS record_sync_snapshot_manifest (
				id INTEGER PRIMARY KEY CHECK(id = 1),
				manifest_json TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS record_sync_snapshot_chunks (
				chunk_index INTEGER PRIMARY KEY,
				generation INTEGER NOT NULL,
				rows_json TEXT NOT NULL,
				bodies_json TEXT NOT NULL,
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

/**
 * Fold one admitted command at one server sequence. Never refuses: every
 * outcome is an application or a deterministic no-op (ADR-0131). Returns
 * whether the command applied, for optional diagnostics.
 */
function applyCommand(
	database: RecordSyncSqlite,
	command: RecordCommand,
	serverSequence: number,
): boolean {
	if (command.kind === 'bodyAppend') {
		// Only a live row accepts body updates; absence (never created, or
		// dead forever) folds the append to a no-op (ADR-0133).
		if (readRow(database, command.table, command.rowId) === undefined) {
			return false;
		}
		database.run(
			`INSERT INTO record_sync_body_updates(
				table_name, row_id, update_b64, last_server_sequence
			) VALUES (?, ?, ?, ?)`,
			[command.table, command.rowId, command.update, serverSequence],
		);
		return true;
	}
	const current = readRow(database, command.table, command.rowId);
	const result = foldRow(current, command);
	switch (result.kind) {
		case 'noop':
			return false;
		case 'row':
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
			return true;
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
			// Death purges the body log; late appends fold to no-ops forever.
			database.run(
				`DELETE FROM record_sync_body_updates
				 WHERE table_name = ? AND row_id = ?`,
				[command.table, command.rowId],
			);
			return true;
	}
}

function readManifest(database: RecordSyncSqlite): SnapshotManifest | null {
	const stored = one<{ manifest_json: string }>(
		database,
		'SELECT manifest_json FROM record_sync_snapshot_manifest WHERE id = 1',
	);
	return stored ? JSON.parse(stored.manifest_json) : null;
}

function collectEntries(
	database: RecordSyncSqlite,
	checkpoint: number,
	limit: number,
): StateEntry[] {
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
			UNION ALL
			SELECT 'bodyUpdate' AS kind, table_name, row_id, update_b64 AS value_json,
			       last_server_sequence
			FROM record_sync_body_updates
		 )
		 WHERE last_server_sequence > ?
		 ORDER BY last_server_sequence, table_name, row_id
		 LIMIT ?`,
		[checkpoint, limit],
	);
	return stored.map((entry): StateEntry => {
		switch (entry.kind) {
			case 'row':
				return {
					kind: 'row',
					table: entry.table_name,
					rowId: entry.row_id,
					value: JSON.parse(entry.value_json as string),
					lastServerSequence: entry.last_server_sequence,
				};
			case 'deletion':
				return {
					kind: 'deletion',
					table: entry.table_name,
					rowId: entry.row_id,
					lastServerSequence: entry.last_server_sequence,
				};
			case 'bodyUpdate':
				return {
					kind: 'bodyUpdate',
					table: entry.table_name,
					rowId: entry.row_id,
					update: entry.value_json as string,
					lastServerSequence: entry.last_server_sequence,
				};
		}
	});
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
			bodies: database
				.all<{
					table_name: string;
					row_id: string;
					update_b64: string;
					last_server_sequence: number;
				}>(
					`SELECT table_name, row_id, update_b64, last_server_sequence
					 FROM record_sync_body_updates
					 ORDER BY table_name, row_id, last_server_sequence`,
				)
				.map((stored) => ({
					table: stored.table_name,
					rowId: stored.row_id,
					update: stored.update_b64,
					lastServerSequence: stored.last_server_sequence,
				})),
		};
	});
}

function decodeBase64(value: string): Uint8Array {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

export type SnapshotPublicationOptions = { maxChunkBytes: number };

export type RecordAuthorityCompactionPolicy = SnapshotPublicationOptions & {
	minimumRetainedSequences: number;
};

/** Open one schema-blind fold-never-refuse authority over caller-owned SQLite. */
export function openRecordAuthority({
	database,
	sha256,
	mergeBodyUpdates,
}: {
	database: RecordSyncSqlite;
	sha256: Sha256;
	mergeBodyUpdates?: MergeBodyUpdates;
}) {
	initialize(database);

	const authority = {
		/**
		 * One exchange (ADR-0131): fold an optional sealed round exactly once,
		 * then answer with ordered current-state pages from the caller's
		 * checkpoint. Terminal verdicts: a digest mismatch on the accepted
		 * round, or a round that is neither accepted nor its successor.
		 */
		sync(request: SyncRequest): SyncResponse {
			const refusal = requestRefusal(request);
			if (refusal) return { kind: 'sync', ok: false, reason: refusal };
			const round = request.sealedRound;
			if (round && recordRoundDigest(round.commands) !== round.requestDigest) {
				throw new TypeError('Sealed round digest does not match its commands');
			}
			return database.transaction(() => {
				const facts = request.token;
				// Validate the token before folding anything so a corrupt
				// checkpoint can never roll back an accepted round.
				if (facts.checkpoint > requireMeta(database).server_sequence) {
					throw new TypeError('Sync checkpoint is ahead of the authority');
				}
				const stored = one<StoredReplica>(
					database,
					`SELECT accepted_round, request_digest FROM record_sync_replicas
					 WHERE replica_id = ?`,
					[facts.replicaId],
				) ?? { accepted_round: 0, request_digest: '' };

				if (round) {
					if (round.round === stored.accepted_round) {
						// Retry of the accepted round: digest must match; nothing
						// refolds and pages regenerate from current state.
						if (round.requestDigest !== stored.request_digest) {
							return {
								kind: 'sync',
								ok: false,
								reason: 'replica-fork',
							} as const;
						}
					} else if (round.round === stored.accepted_round + 1) {
						const meta = requireMeta(database);
						let serverSequence = meta.server_sequence;
						for (const command of round.commands) {
							serverSequence += 1;
							applyCommand(database, command, serverSequence);
						}
						database.run(
							'UPDATE record_sync_meta SET server_sequence = ? WHERE id = 1',
							[serverSequence],
						);
						database.run(
							`INSERT INTO record_sync_replicas(
								replica_id, accepted_round, request_digest
							) VALUES (?, ?, ?)
							ON CONFLICT(replica_id) DO UPDATE SET
								accepted_round = excluded.accepted_round,
								request_digest = excluded.request_digest`,
							[facts.replicaId, round.round, round.requestDigest],
						);
					} else {
						// A round from the past (or a skipped future) proves a fork
						// or a corrupted replica; one stored digest cannot judge it.
						return {
							kind: 'sync',
							ok: false,
							reason: 'replica-fork',
						} as const;
					}
				}

				const acceptedRound = round
					? Math.max(stored.accepted_round, round.round)
					: stored.accepted_round;
				const meta = requireMeta(database);

				// Round first, snapshot second: the fold above already happened.
				if (facts.checkpoint < meta.tombstone_floor) {
					const manifest = readManifest(database);
					if (!manifest || manifest.head < meta.tombstone_floor) {
						throw new Error('Tombstone floor has no covering snapshot');
					}
					return {
						kind: 'sync',
						ok: true,
						snapshotRequired: true,
						resumeToken: {
							replicaId: facts.replicaId,
							acceptedRound,
							checkpoint: manifest.head,
						},
						manifest,
					} as const;
				}

				const pageLimit =
					request.pageLimit ??
					RECORD_SYNC_ADMISSION_LIMITS.stateEntriesPerPage;
				const stored2 = collectEntries(
					database,
					facts.checkpoint,
					pageLimit + 1,
				);
				let entries = stored2.slice(0, pageLimit);
				let hasMore = stored2.length > entries.length;
				const page = (): Extract<
					SyncResponse,
					{ ok: true; snapshotRequired: false }
				> => ({
					kind: 'sync',
					ok: true,
					snapshotRequired: false,
					token: {
						replicaId: facts.replicaId,
						acceptedRound,
						checkpoint: hasMore
							? (entries.at(-1)?.lastServerSequence ?? facts.checkpoint)
							: meta.server_sequence,
					} satisfies SyncToken,
					entries,
					hasMore,
				});
				let response = page();
				while (
					encodedJsonBytes(response) >
					RECORD_SYNC_ADMISSION_LIMITS.encodedPageBytes
				) {
					if (entries.length <= 1) {
						throw new Error(
							'One admitted state entry exceeds the page byte limit',
						);
					}
					entries = entries.slice(0, -1);
					hasMore = true;
					response = page();
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
				bodies: capture.bodies,
				maxChunkBytes,
			});
			const manifest = await createSnapshotManifest(sha256, {
				generation: capture.generation,
				head: capture.head,
				chunkChecksums: chunks.map((chunk) => chunk.checksum),
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
							chunk_index, generation, rows_json, bodies_json, checksum
						) VALUES (?, ?, ?, ?, ?)`,
						[
							chunk.index,
							chunk.generation,
							JSON.stringify(chunk.rows),
							JSON.stringify(chunk.bodies),
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

		/**
		 * Raise the floor. Deletions at or below it are forgotten, and each
		 * live row's covered body prefix merges into one baseline when a merge
		 * function was injected (ADR-0133).
		 */
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
				if (mergeBodyUpdates) {
					const keys = database.all<{ table_name: string; row_id: string }>(
						`SELECT DISTINCT table_name, row_id FROM record_sync_body_updates
						 WHERE last_server_sequence <= ?`,
						[floor],
					);
					for (const key of keys) {
						const covered = database.all<{
							update_b64: string;
							last_server_sequence: number;
						}>(
							`SELECT update_b64, last_server_sequence
							 FROM record_sync_body_updates
							 WHERE table_name = ? AND row_id = ?
							   AND last_server_sequence <= ?
							 ORDER BY last_server_sequence`,
							[key.table_name, key.row_id, floor],
						);
						if (covered.length <= 1) continue;
						const merged = encodeBase64(
							mergeBodyUpdates(
								covered.map((update) => decodeBase64(update.update_b64)),
							),
						);
						const baselineSequence = covered.at(-1)!.last_server_sequence;
						database.run(
							`DELETE FROM record_sync_body_updates
							 WHERE table_name = ? AND row_id = ?
							   AND last_server_sequence <= ?`,
							[key.table_name, key.row_id, floor],
						);
						database.run(
							`INSERT INTO record_sync_body_updates(
								table_name, row_id, update_b64, last_server_sequence
							) VALUES (?, ?, ?, ?)`,
							[key.table_name, key.row_id, merged, baselineSequence],
						);
					}
				}
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
				`SELECT generation, chunk_index, rows_json, bodies_json, checksum
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
				bodies: JSON.parse(stored.bodies_json),
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
				bodyLog: database.all<{
					table: string;
					rowId: string;
					lastServerSequence: number;
				}>(
					`SELECT table_name AS "table", row_id AS rowId,
					        last_server_sequence AS lastServerSequence
					 FROM record_sync_body_updates
					 ORDER BY table_name, row_id, last_server_sequence`,
				),
				replicaRounds: Object.fromEntries(
					database
						.all<{ replica_id: string; accepted_round: number }>(
							`SELECT replica_id, accepted_round FROM record_sync_replicas
							 ORDER BY replica_id`,
						)
						.map((replica) => [replica.replica_id, replica.accepted_round]),
				),
			};
		},
	};

	return authority;
}

export type RecordAuthority = ReturnType<typeof openRecordAuthority>;
