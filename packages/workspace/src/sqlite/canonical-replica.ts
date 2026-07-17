import {
	foldRow,
	isValidSnapshotChunk,
	isValidSnapshotManifest,
	type JsonObject,
	parseRecordCommand,
	parseSnapshotChunkResponse,
	parseSyncResponse,
	RECORD_SYNC_ADMISSION_LIMITS,
	RECORD_SYNC_PROTOCOL_MAJOR,
	type RecordCommand,
	type RecordSyncSqlite,
	recordRoundDigest,
	type SealedRound,
	type Sha256,
	type SnapshotChunkRequest,
	type SnapshotManifest,
	type StateEntry,
	type SyncRequest,
	type SyncResponse,
	type SyncToken,
} from '@epicenter/record-sync';

const STORAGE_VERSION = 2;
const RECORDS_TABLE = '__epicenter_records';
const META_TABLE = '__epicenter_replica_meta';
const OUTBOX_TABLE = '__epicenter_replica_outbox';
const SEALED_ROUND_TABLE = '__epicenter_replica_sealed_round';
const BODIES_TABLE = '__epicenter_replica_bodies';
const SNAPSHOT_META_TABLE = '__epicenter_replica_snapshot_meta';
const SNAPSHOT_ROWS_TABLE = '__epicenter_replica_snapshot_rows';
const SNAPSHOT_BODIES_TABLE = '__epicenter_replica_snapshot_bodies';

type StoredOutbox = {
	ordinal: number;
	command_json: string;
};

type StoredSnapshotMeta = {
	generation: number;
	manifest_json: string;
	resume_token_json: string;
	next_chunk_index: number;
};

export type CanonicalReplicaTransport = {
	sync(request: SyncRequest): Promise<unknown>;
	snapshotChunk(request: SnapshotChunkRequest): Promise<unknown>;
};

export type CanonicalReplicaStatus = {
	checkpoint: number;
	pendingCommands: number;
	hasInflightRound: boolean;
};

/**
 * A pending command that folded to a local no-op during replay: the mirror of
 * an authority no-op (ADR-0131). Heuristic and advisory, never durable
 * authority state.
 */
export type CanonicalReplicaDiagnostic = {
	command: RecordCommand;
	reason: 'folded-to-noop';
};

/**
 * Open the private synchronization owner for one complete canonical replica
 * (ADR-0131). The returned capability belongs to the workspace runtime, not
 * applications. Intent travels as sealed rounds: at most one exists, it is
 * retired whole when its exchange completes, and visible state is accepted
 * authority state with pending intent replayed over it under mirrored fold
 * rules.
 */
export function createCanonicalReplica({
	sqlite,
	transport,
	sha256,
	onRemoteCommit = () => undefined,
	onDiagnostic = () => undefined,
	roundLimit = RECORD_SYNC_ADMISSION_LIMITS.commandsPerRound,
	pageLimit = RECORD_SYNC_ADMISSION_LIMITS.stateEntriesPerPage,
}: {
	sqlite: RecordSyncSqlite;
	transport: CanonicalReplicaTransport;
	sha256: Sha256;
	onRemoteCommit?: () => void;
	onDiagnostic?: (diagnostic: CanonicalReplicaDiagnostic) => void;
	roundLimit?: number;
	pageLimit?: number;
}) {
	assertLimit(roundLimit, RECORD_SYNC_ADMISSION_LIMITS.commandsPerRound, 'round');
	assertLimit(pageLimit, RECORD_SYNC_ADMISSION_LIMITS.stateEntriesPerPage, 'page');
	initialize(sqlite);
	let activeSynchronization: Promise<CanonicalReplicaStatus> | undefined;
	let rerunRequested = false;

	function admit(command: RecordCommand): void {
		const admitted = parseRecordCommand(command);
		sqlite.run(
			`INSERT INTO "${OUTBOX_TABLE}"(command_json) VALUES (?)`,
			[JSON.stringify(admitted)],
		);
		rerunRequested = true;
	}

	function readToken(): SyncToken {
		const stored = sqlite.all<{ token_json: string }>(
			`SELECT token_json FROM "${META_TABLE}" WHERE id = 1`,
		)[0];
		if (!stored) throw new Error('Canonical replica is not initialized');
		return JSON.parse(stored.token_json) as SyncToken;
	}

	function writeToken(token: SyncToken): void {
		sqlite.run(`UPDATE "${META_TABLE}" SET token_json = ? WHERE id = 1`, [
			JSON.stringify(token),
		]);
	}

	function readSealedRound(): SealedRound | undefined {
		const stored = sqlite.all<{
			round: number;
			request_digest: string;
			commands_json: string;
		}>(
			`SELECT round, request_digest, commands_json
			 FROM "${SEALED_ROUND_TABLE}" WHERE id = 1`,
		)[0];
		return stored
			? {
					round: stored.round,
					requestDigest: stored.request_digest,
					commands: JSON.parse(stored.commands_json) as RecordCommand[],
				}
			: undefined;
	}

	/**
	 * Seal at most `roundLimit` pending commands into the next round. At most
	 * one sealed round exists; it leaves disk only when its exchange
	 * completes, so an interrupted exchange always retries the identical
	 * payload under the identical digest.
	 */
	function sealRound(): SealedRound | undefined {
		return sqlite.transaction(() => {
			const existing = readSealedRound();
			if (existing) return existing;
			const pending = sqlite.all<StoredOutbox>(
				`SELECT ordinal, command_json FROM "${OUTBOX_TABLE}"
				 ORDER BY ordinal LIMIT ?`,
				[roundLimit],
			);
			if (pending.length === 0) return undefined;
			let commands = pending.map(
				(entry) => parseRecordCommand(JSON.parse(entry.command_json)),
			);
			let taken = pending;
			while (
				commands.length > 1 &&
				encodedRoundBytes(readToken(), commands) >
					RECORD_SYNC_ADMISSION_LIMITS.encodedRoundBytes
			) {
				commands = commands.slice(0, -1);
				taken = taken.slice(0, -1);
			}
			const sealed: SealedRound = {
				round: readToken().acceptedRound + 1,
				requestDigest: recordRoundDigest(commands),
				commands,
			};
			sqlite.run(
				`INSERT INTO "${SEALED_ROUND_TABLE}"(id, round, request_digest, commands_json)
				 VALUES (1, ?, ?, ?)`,
				[sealed.round, sealed.requestDigest, JSON.stringify(sealed.commands)],
			);
			for (const entry of taken) {
				sqlite.run(`DELETE FROM "${OUTBOX_TABLE}" WHERE ordinal = ?`, [
					entry.ordinal,
				]);
			}
			return sealed;
		});
	}

	async function runSynchronization(): Promise<CanonicalReplicaStatus> {
		assertCanonicalStore(sqlite);
		while (true) {
			sealRound();
			const sealed = readSealedRound();
			const token = readToken();
			const request: SyncRequest = {
				protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
				kind: 'sync',
				token,
				...(sealed && token.acceptedRound < sealed.round
					? { sealedRound: sealed }
					: {}),
				...(pageLimit === RECORD_SYNC_ADMISSION_LIMITS.stateEntriesPerPage
					? {}
					: { pageLimit }),
			};
			const sentRound = request.sealedRound?.round;
			const response = parseSyncResponse(await transport.sync(request));
			if (!response.ok) {
				throw new Error(`Record sync refused: ${response.reason}`);
			}
			// The authority's acceptedRound must account exactly for what this
			// exchange submitted: a response that silently advances (or ignores)
			// a round is corrupt and must not retire local intent.
			const expectedAcceptedRound = sentRound ?? token.acceptedRound;
			if (response.snapshotRequired) {
				if (
					response.resumeToken.replicaId !== token.replicaId ||
					response.resumeToken.checkpoint !== response.manifest.head ||
					response.resumeToken.acceptedRound !== expectedAcceptedRound
				) {
					throw new Error('Snapshot resume token does not match this replica');
				}
				await downloadAndInstallSnapshot(response.manifest, response.resumeToken);
				onRemoteCommit();
				continue;
			}
			if (response.token.acceptedRound !== expectedAcceptedRound) {
				throw new Error('Sync page does not continue the local checkpoint');
			}
			const installed = installPage(token, response);
			if (installed && response.entries.length > 0) onRemoteCommit();
			if (
				!response.hasMore &&
				readSealedRound() === undefined &&
				outboxCount() === 0
			) {
				break;
			}
		}
		return status();
	}

	function installPage(
		expected: SyncToken,
		response: Extract<SyncResponse, { ok: true; snapshotRequired: false }>,
	): boolean {
		if (
			response.token.replicaId !== expected.replicaId ||
			response.token.checkpoint < expected.checkpoint ||
			response.token.acceptedRound < expected.acceptedRound ||
			(response.hasMore &&
				(response.entries.length === 0 ||
					response.token.checkpoint !==
						response.entries.at(-1)?.lastServerSequence)) ||
			!hasMonotoneEntries(response.entries, expected.checkpoint, response.token.checkpoint)
		) {
			throw new Error('Sync page does not continue the local checkpoint');
		}
		return sqlite.transaction(() => {
			const current = readToken();
			if (current.checkpoint > expected.checkpoint) return false;
			if (current.checkpoint !== expected.checkpoint) {
				throw new Error('Sync checkpoint changed before installation');
			}
			const affected = new Set<string>();
			for (const entry of response.entries) {
				applyStateEntry(entry);
				affected.add(recordKey(entry.table, entry.rowId));
			}
			writeToken(response.token);
			const sealed = readSealedRound();
			// The exchange completes when the round is accepted and the page
			// stream has reached head; only then does the round leave disk.
			if (
				sealed &&
				response.token.acceptedRound >= sealed.round &&
				!response.hasMore
			) {
				// Retirement diagnostics (advisory, ADR-0131): a patch that
				// re-folds to a no-op against final accepted state either lost
				// a capacity conflict or targets a row deletion beat it to.
				// Creates are excluded: an applied create always re-folds to a
				// no-op against its own accepted effect.
				for (const command of sealed.commands) {
					if (command.kind !== 'patchRow') continue;
					const current = readCanonical(sqlite, command.table, command.rowId);
					if (foldRow(current ?? undefined, command).kind === 'noop') {
						onDiagnostic({ command, reason: 'folded-to-noop' });
					}
				}
				sqlite.run(`DELETE FROM "${SEALED_ROUND_TABLE}"`);
			}
			replayPending(affected);
			clearSnapshotStaging(sqlite);
			return true;
		});
	}

	function applyStateEntry(entry: StateEntry): void {
		switch (entry.kind) {
			case 'row':
				sqlite.run(
					`INSERT INTO "${RECORDS_TABLE}"(table_key, row_id, payload)
					 VALUES (?, ?, ?)
					 ON CONFLICT(table_key, row_id) DO UPDATE SET payload = excluded.payload`,
					[entry.table, entry.rowId, JSON.stringify(entry.value)],
				);
				return;
			case 'deletion': {
				sqlite.run(
					`DELETE FROM "${RECORDS_TABLE}" WHERE table_key = ? AND row_id = ?`,
					[entry.table, entry.rowId],
				);
				sqlite.run(
					`DELETE FROM "${BODIES_TABLE}" WHERE table_name = ? AND row_id = ?`,
					[entry.table, entry.rowId],
				);
				// Deletion is permanent everywhere: the local body edit log dies
				// with the row too (the bodies owner creates it lazily).
				if (
					sqlite.all<{ present: number }>(
						`SELECT 1 AS present FROM sqlite_master
						 WHERE type = 'table' AND name = '__epicenter_bodies_log'`,
					).length > 0
				) {
					sqlite.run(
						`DELETE FROM "__epicenter_bodies_log" WHERE table_name = ? AND row_id = ?`,
						[entry.table, entry.rowId],
					);
				}
				// The deletion fence (ADR-0133): queued body edits for a row the
				// authority reports dead are dropped, never resubmitted. Appends
				// already sealed are immutable and rely on the authority fold.
				for (const pending of sqlite.all<StoredOutbox>(
					`SELECT ordinal, command_json FROM "${OUTBOX_TABLE}" ORDER BY ordinal`,
				)) {
					const command = JSON.parse(pending.command_json) as RecordCommand;
					if (
						command.kind === 'bodyAppend' &&
						command.table === entry.table &&
						command.rowId === entry.rowId
					) {
						sqlite.run(`DELETE FROM "${OUTBOX_TABLE}" WHERE ordinal = ?`, [
							pending.ordinal,
						]);
						onDiagnostic({ command, reason: 'folded-to-noop' });
					}
				}
				return;
			}
			case 'bodyUpdate':
				sqlite.run(
					`INSERT INTO "${BODIES_TABLE}"(
						table_name, row_id, update_b64, last_server_sequence
					) VALUES (?, ?, ?, ?)
					ON CONFLICT(table_name, row_id, last_server_sequence) DO UPDATE SET
						update_b64 = excluded.update_b64`,
					[entry.table, entry.rowId, entry.update, entry.lastServerSequence],
				);
		}
	}

	/**
	 * Replay pending intent over installed authority state under the mirrored
	 * fold rules, so visible state approximates future accepted state. A
	 * command that folds to a no-op surfaces as an advisory diagnostic.
	 */
	function replayPending(affected?: ReadonlySet<string>): void {
		const sealed = readSealedRound();
		const pending: RecordCommand[] = [
			...(sealed ? sealed.commands : []),
			...sqlite
				.all<StoredOutbox>(
					`SELECT ordinal, command_json FROM "${OUTBOX_TABLE}" ORDER BY ordinal`,
				)
				.map((entry) => JSON.parse(entry.command_json) as RecordCommand),
		];
		for (const command of pending) {
			if (command.kind === 'bodyAppend') continue;
			if (affected && !affected.has(recordKey(command.table, command.rowId))) {
				continue;
			}
			const current = readCanonical(sqlite, command.table, command.rowId);
			const folded = foldRow(current ?? undefined, command);
			switch (folded.kind) {
				case 'noop':
					onDiagnostic({ command, reason: 'folded-to-noop' });
					continue;
				case 'row':
					sqlite.run(
						`INSERT INTO "${RECORDS_TABLE}"(table_key, row_id, payload) VALUES (?, ?, ?)
						 ON CONFLICT(table_key, row_id) DO UPDATE SET payload = excluded.payload`,
						[command.table, command.rowId, JSON.stringify(folded.value)],
					);
					continue;
				case 'deletion':
					sqlite.run(
						`DELETE FROM "${RECORDS_TABLE}" WHERE table_key = ? AND row_id = ?`,
						[command.table, command.rowId],
					);
			}
		}
	}

	async function downloadAndInstallSnapshot(
		manifest: SnapshotManifest,
		resumeToken: SyncToken,
	): Promise<void> {
		if (!(await isValidSnapshotManifest(sha256, manifest))) {
			throw new Error('Snapshot manifest checksum is invalid');
		}
		prepareSnapshot(sqlite, manifest, resumeToken);
		let staged = readSnapshotMeta(sqlite);
		if (!staged) throw new Error('Snapshot staging was not initialized');
		while (staged.next_chunk_index < manifest.chunkChecksums.length) {
			const index = staged.next_chunk_index;
			const response = parseSnapshotChunkResponse(
				await transport.snapshotChunk({
					protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
					kind: 'snapshotChunk',
					generation: manifest.generation,
					index,
				}),
			);
			if (!response.ok) {
				clearSnapshotStaging(sqlite);
				throw new Error(`Snapshot chunk refused: ${response.reason}`);
			}
			const { chunk } = response;
			if (
				chunk.generation !== manifest.generation ||
				chunk.index !== index ||
				chunk.checksum !== manifest.chunkChecksums[index] ||
				!(await isValidSnapshotChunk(sha256, chunk))
			) {
				throw new Error(`Snapshot chunk ${index} does not match its manifest`);
			}
			stageSnapshotChunk(sqlite, manifest, chunk, index);
			staged = readSnapshotMeta(sqlite);
			if (!staged) throw new Error('Snapshot staging disappeared');
		}
		installStagedSnapshot(manifest);
	}

	function installStagedSnapshot(manifest: SnapshotManifest): void {
		sqlite.transaction(() => {
			const staged = readSnapshotMeta(sqlite);
			if (
				staged?.generation !== manifest.generation ||
				staged.manifest_json !== JSON.stringify(manifest) ||
				staged.next_chunk_index !== manifest.chunkChecksums.length
			) {
				throw new Error('Snapshot staging is incomplete');
			}
			const current = readToken();
			if (current.checkpoint > manifest.head) {
				clearSnapshotStaging(sqlite);
				return;
			}
			sqlite.run(`DELETE FROM "${RECORDS_TABLE}"`);
			sqlite.run(
				`INSERT INTO "${RECORDS_TABLE}"(table_key, row_id, payload)
				 SELECT table_key, row_id, payload FROM "${SNAPSHOT_ROWS_TABLE}"
				 WHERE generation = ?`,
				[manifest.generation],
			);
			sqlite.run(`DELETE FROM "${BODIES_TABLE}"`);
			sqlite.run(
				`INSERT INTO "${BODIES_TABLE}"(table_name, row_id, update_b64, last_server_sequence)
				 SELECT table_name, row_id, update_b64, last_server_sequence
				 FROM "${SNAPSHOT_BODIES_TABLE}" WHERE generation = ?`,
				[manifest.generation],
			);
			writeToken(JSON.parse(staged.resume_token_json) as SyncToken);
			// The sealed round survives bootstrap: its own writes stay visible
			// through replay until the exchange completes, exactly like paging.
			replayPending();
			clearSnapshotStaging(sqlite);
		});
	}

	function outboxCount(): number {
		return (
			sqlite.all<{ count: number }>(
				`SELECT COUNT(*) AS count FROM "${OUTBOX_TABLE}"`,
			)[0]?.count ?? 0
		);
	}

	function status(): CanonicalReplicaStatus {
		const sealed = readSealedRound();
		return {
			checkpoint: readToken().checkpoint,
			pendingCommands: outboxCount() + (sealed?.commands.length ?? 0),
			hasInflightRound: sealed !== undefined,
		};
	}

	return {
		admit,
		/** Coalesce concurrent wake-ups into one bounded synchronization pass. */
		synchronize(): Promise<CanonicalReplicaStatus> {
			rerunRequested = true;
			activeSynchronization ??= Promise.resolve()
				.then(async () => {
					let synchronized: CanonicalReplicaStatus;
					do {
						rerunRequested = false;
						synchronized = await runSynchronization();
					} while (rerunRequested);
					return synchronized;
				})
				.finally(() => {
					activeSynchronization = undefined;
				});
			return activeSynchronization;
		},
		status,
	};
}

export type CanonicalReplica = ReturnType<typeof createCanonicalReplica>;

function encodedRoundBytes(
	token: SyncToken,
	commands: RecordCommand[],
): number {
	const request: SyncRequest = {
		protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
		kind: 'sync',
		token,
		sealedRound: {
			round: token.acceptedRound + 1,
			requestDigest: '0'.repeat(16),
			commands,
		},
	};
	return new TextEncoder().encode(JSON.stringify(request)).byteLength;
}

function initialize(sqlite: RecordSyncSqlite): void {
	sqlite.transaction(() => {
		const legacy = sqlite.all<{ name: string }>(
			`SELECT name FROM sqlite_master
			 WHERE type = 'table' AND name IN (
				'__epicenter_replica_quarantine'
			 )`,
		);
		if (legacy.length > 0) {
			throw new Error('Incompatible canonical replica storage');
		}
		sqlite.run(`
			CREATE TABLE IF NOT EXISTS "${META_TABLE}" (
				id INTEGER PRIMARY KEY CHECK(id = 1),
				storage_version INTEGER NOT NULL,
				protocol_major INTEGER NOT NULL,
				token_json TEXT NOT NULL CHECK(json_valid(token_json))
			) STRICT;
			CREATE TABLE IF NOT EXISTS "${OUTBOX_TABLE}" (
				ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
				command_json TEXT NOT NULL CHECK(json_valid(command_json))
			) STRICT;
			CREATE TABLE IF NOT EXISTS "${SEALED_ROUND_TABLE}" (
				id INTEGER PRIMARY KEY CHECK(id = 1),
				round INTEGER NOT NULL,
				request_digest TEXT NOT NULL,
				commands_json TEXT NOT NULL CHECK(json_valid(commands_json))
			) STRICT;
			CREATE TABLE IF NOT EXISTS "${BODIES_TABLE}" (
				table_name TEXT NOT NULL,
				row_id TEXT NOT NULL,
				update_b64 TEXT NOT NULL,
				last_server_sequence INTEGER NOT NULL,
				PRIMARY KEY(table_name, row_id, last_server_sequence)
			) WITHOUT ROWID, STRICT;
			CREATE TABLE IF NOT EXISTS "${SNAPSHOT_META_TABLE}" (
				id INTEGER PRIMARY KEY CHECK(id = 1),
				generation INTEGER NOT NULL,
				manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
				resume_token_json TEXT NOT NULL CHECK(json_valid(resume_token_json)),
				next_chunk_index INTEGER NOT NULL
			) STRICT;
			CREATE TABLE IF NOT EXISTS "${SNAPSHOT_ROWS_TABLE}" (
				generation INTEGER NOT NULL,
				table_key TEXT NOT NULL,
				row_id TEXT NOT NULL,
				payload TEXT NOT NULL CHECK(json_valid(payload) AND json_type(payload) = 'object'),
				last_server_sequence INTEGER NOT NULL,
				PRIMARY KEY(generation, table_key, row_id)
			) WITHOUT ROWID, STRICT;
			CREATE TABLE IF NOT EXISTS "${SNAPSHOT_BODIES_TABLE}" (
				generation INTEGER NOT NULL,
				table_name TEXT NOT NULL,
				row_id TEXT NOT NULL,
				update_b64 TEXT NOT NULL,
				last_server_sequence INTEGER NOT NULL,
				PRIMARY KEY(generation, table_name, row_id, last_server_sequence)
			) WITHOUT ROWID, STRICT;
		`);
		const stored = sqlite.all<{
			storage_version: number;
			protocol_major: number;
		}>(
			`SELECT storage_version, protocol_major FROM "${META_TABLE}" WHERE id = 1`,
		)[0];
		if (!stored) {
			sqlite.run(
				`INSERT INTO "${META_TABLE}"(
					id, storage_version, protocol_major, token_json
				) VALUES (1, ?, ?, ?)`,
				[
					STORAGE_VERSION,
					RECORD_SYNC_PROTOCOL_MAJOR,
					JSON.stringify({
						replicaId: crypto.randomUUID(),
						acceptedRound: 0,
						checkpoint: 0,
					} satisfies SyncToken),
				],
			);
			return;
		}
		if (
			stored.storage_version !== STORAGE_VERSION ||
			stored.protocol_major !== RECORD_SYNC_PROTOCOL_MAJOR
		) {
			throw new Error('Incompatible canonical replica storage');
		}
	});
}

function hasMonotoneEntries(
	entries: readonly StateEntry[],
	fromCheckpoint: number,
	newCheckpoint: number,
): boolean {
	let previousSequence = fromCheckpoint;
	const currentStateKeys = new Set<string>();
	for (const entry of entries) {
		if (
			entry.lastServerSequence <= previousSequence ||
			entry.lastServerSequence > newCheckpoint
		) {
			return false;
		}
		previousSequence = entry.lastServerSequence;
		// Rows and deletions are current state: at most one entry per row per
		// page. Body updates are log entries and may repeat a row.
		if (entry.kind !== 'bodyUpdate') {
			const key = recordKey(entry.table, entry.rowId);
			if (currentStateKeys.has(key)) return false;
			currentStateKeys.add(key);
		}
	}
	return true;
}

function prepareSnapshot(
	sqlite: RecordSyncSqlite,
	manifest: SnapshotManifest,
	resumeToken: SyncToken,
): void {
	sqlite.transaction(() => {
		const stored = readSnapshotMeta(sqlite);
		if (
			stored?.generation === manifest.generation &&
			stored.manifest_json === JSON.stringify(manifest)
		) {
			return;
		}
		clearSnapshotStaging(sqlite);
		sqlite.run(
			`INSERT INTO "${SNAPSHOT_META_TABLE}"(
				id, generation, manifest_json, resume_token_json, next_chunk_index
			) VALUES (1, ?, ?, ?, 0)`,
			[manifest.generation, JSON.stringify(manifest), JSON.stringify(resumeToken)],
		);
	});
}

function readSnapshotMeta(
	sqlite: RecordSyncSqlite,
): StoredSnapshotMeta | undefined {
	return sqlite.all<StoredSnapshotMeta>(
		`SELECT generation, manifest_json, resume_token_json, next_chunk_index
		 FROM "${SNAPSHOT_META_TABLE}" WHERE id = 1`,
	)[0];
}

function stageSnapshotChunk(
	sqlite: RecordSyncSqlite,
	manifest: SnapshotManifest,
	chunk: {
		rows: readonly {
			table: string;
			rowId: string;
			value: JsonObject;
			lastServerSequence: number;
		}[];
		bodies: readonly {
			table: string;
			rowId: string;
			update: string;
			lastServerSequence: number;
		}[];
	},
	index: number,
): void {
	sqlite.transaction(() => {
		const stored = readSnapshotMeta(sqlite);
		if (
			stored?.generation !== manifest.generation ||
			stored.manifest_json !== JSON.stringify(manifest) ||
			stored.next_chunk_index !== index
		) {
			throw new Error('Snapshot staging cursor changed before installation');
		}
		for (const entry of [...chunk.rows, ...chunk.bodies]) {
			if (
				entry.lastServerSequence < 1 ||
				entry.lastServerSequence > manifest.head
			) {
				throw new Error('Snapshot chunk entry exceeds its manifest head');
			}
		}
		for (const row of chunk.rows) {
			sqlite.run(
				`INSERT INTO "${SNAPSHOT_ROWS_TABLE}"(
					generation, table_key, row_id, payload, last_server_sequence
				) VALUES (?, ?, ?, ?, ?)`,
				[
					manifest.generation,
					row.table,
					row.rowId,
					JSON.stringify(row.value),
					row.lastServerSequence,
				],
			);
		}
		for (const body of chunk.bodies) {
			sqlite.run(
				`INSERT INTO "${SNAPSHOT_BODIES_TABLE}"(
					generation, table_name, row_id, update_b64, last_server_sequence
				) VALUES (?, ?, ?, ?, ?)`,
				[
					manifest.generation,
					body.table,
					body.rowId,
					body.update,
					body.lastServerSequence,
				],
			);
		}
		sqlite.run(
			`UPDATE "${SNAPSHOT_META_TABLE}" SET next_chunk_index = ? WHERE id = 1`,
			[index + 1],
		);
	});
}

function clearSnapshotStaging(sqlite: RecordSyncSqlite): void {
	sqlite.run(`DELETE FROM "${SNAPSHOT_ROWS_TABLE}"`);
	sqlite.run(`DELETE FROM "${SNAPSHOT_BODIES_TABLE}"`);
	sqlite.run(`DELETE FROM "${SNAPSHOT_META_TABLE}"`);
}

function readCanonical(
	sqlite: RecordSyncSqlite,
	table: string,
	rowId: string,
): JsonObject | null {
	const stored = sqlite.all<{ payload: string }>(
		`SELECT payload FROM "${RECORDS_TABLE}" WHERE table_key = ? AND row_id = ?`,
		[table, rowId],
	)[0];
	return stored ? (JSON.parse(stored.payload) as JsonObject) : null;
}

function assertCanonicalStore(sqlite: RecordSyncSqlite): void {
	const exists = sqlite.all<{ present: number }>(
		`SELECT 1 AS present FROM sqlite_master
		 WHERE type = 'table' AND name = ?`,
		[RECORDS_TABLE],
	)[0];
	if (!exists) {
		throw new Error('Canonical records must open before synchronization');
	}
}

function assertLimit(value: number, maximum: number, label: string): void {
	if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
		throw new TypeError(
			`${label} limit must be an integer from 1 through ${maximum}`,
		);
	}
}

function recordKey(table: string, rowId: string): string {
	return JSON.stringify([table, rowId]);
}
