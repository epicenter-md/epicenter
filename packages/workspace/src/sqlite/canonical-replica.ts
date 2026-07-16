import {
	encodedJsonBytes,
	foldRow,
	isAdmissibleCanonicalRow,
	isValidSnapshotChunk,
	isValidSnapshotManifest,
	type JsonObject,
	type PullRequest,
	type PushRequest,
	type PushResponse,
	parseMutation,
	parsePullResponse,
	parsePushRequest,
	parsePushResponse,
	parseSnapshotChunkResponse,
	RECORD_SYNC_ADMISSION_LIMITS,
	RECORD_SYNC_PROTOCOL_MAJOR,
	type RecordCommand,
	type RecordSyncSqlite,
	recordBatchChecksum,
	type Sha256,
	type SnapshotChunkRequest,
	type SnapshotManifest,
	type StateEntry,
} from '@epicenter/record-sync';

const STORAGE_VERSION = 1;
const RECORDS_TABLE = '__epicenter_records';
const META_TABLE = '__epicenter_replica_meta';
const OUTBOX_TABLE = '__epicenter_replica_outbox';
const QUARANTINE_TABLE = '__epicenter_replica_quarantine';
const SNAPSHOT_META_TABLE = '__epicenter_replica_snapshot_meta';
const SNAPSHOT_ROWS_TABLE = '__epicenter_replica_snapshot_rows';

type StoredMeta = {
	actor_id: string;
	next_actor_sequence: number;
	pull_cursor: number;
	inflight_first: number | null;
	inflight_last: number | null;
	requires_bootstrap: number;
};

type StoredOutbox = {
	actor_sequence: number;
	command_json: string;
	accepted_server_sequence: number | null;
};

type PushRefusalReason = Extract<PushResponse, { ok: false }>['reason'];
type PermanentPushRefusal = Extract<
	PushRefusalReason,
	'create-conflict' | 'row-too-large'
>;
type QuarantineReason = PermanentPushRefusal | 'depends-on-rejected-batch';

type StoredQuarantine = {
	actor_id: string;
	actor_sequence: number;
	reason: QuarantineReason;
	command_json: string;
};

export type QuarantinedRecordCommand = {
	actorId: string;
	actorSequence: number;
	reason: QuarantineReason;
	command: RecordCommand;
};

type StoredSnapshotMeta = {
	generation: number;
	manifest_json: string;
	next_chunk_index: number;
};

export type CanonicalReplicaTransport = {
	push(request: PushRequest): Promise<unknown>;
	pull(request: PullRequest): Promise<unknown>;
	snapshotChunk(request: SnapshotChunkRequest): Promise<unknown>;
};

export type CanonicalReplicaStatus = {
	pullCursor: number;
	pendingCommands: number;
	acceptedCommandsAwaitingPull: number;
	hasInflightPush: boolean;
};

/**
 * Open the private synchronization owner for one complete canonical replica.
 * The returned capability belongs to the workspace runtime, not applications.
 */
export function createCanonicalReplica({
	sqlite,
	transport,
	sha256,
	onRemoteCommit = () => undefined,
	pushLimit = RECORD_SYNC_ADMISSION_LIMITS.mutationsPerPush,
	pullLimit = RECORD_SYNC_ADMISSION_LIMITS.stateEntriesPerPull,
}: {
	sqlite: RecordSyncSqlite;
	transport: CanonicalReplicaTransport;
	sha256: Sha256;
	onRemoteCommit?: () => void;
	pushLimit?: number;
	pullLimit?: number;
}) {
	assertLimit(pushLimit, RECORD_SYNC_ADMISSION_LIMITS.mutationsPerPush, 'push');
	assertLimit(
		pullLimit,
		RECORD_SYNC_ADMISSION_LIMITS.stateEntriesPerPull,
		'pull',
	);
	initialize(sqlite);
	let activeSynchronization: Promise<CanonicalReplicaStatus> | undefined;
	let rerunRequested = false;

	function admit(command: RecordCommand): void {
		const meta = requireMeta(sqlite);
		const mutation = parseMutation({
			actorSequence: meta.next_actor_sequence,
			command,
		});
		const current = readCanonical(
			sqlite,
			mutation.command.table,
			mutation.command.rowId,
		);
		const folded = foldRow(current ?? undefined, mutation.command);
		if (folded.kind === 'create-conflict') {
			throw new Error(
				`Pending create conflicts with '${mutation.command.table}/${mutation.command.rowId}'`,
			);
		}
		if (
			folded.kind === 'row' &&
			!isAdmissibleCanonicalRow({
				table: mutation.command.table,
				rowId: mutation.command.rowId,
				value: folded.value,
			})
		) {
			throw new RangeError('Canonical row exceeds portable record-sync limits');
		}
		sqlite.run(
			`INSERT INTO "${OUTBOX_TABLE}"(
				actor_sequence, command_json, accepted_server_sequence
			) VALUES (?, ?, NULL)`,
			[mutation.actorSequence, JSON.stringify(mutation.command)],
		);
		sqlite.run(
			`UPDATE "${META_TABLE}" SET next_actor_sequence = ? WHERE id = 1`,
			[mutation.actorSequence + 1],
		);
		rerunRequested = true;
	}

	async function runSynchronization(): Promise<CanonicalReplicaStatus> {
		assertCanonicalStore(sqlite);
		const startsInBootstrap = requireMeta(sqlite).requires_bootstrap === 1;
		let quarantined:
			| { reason: PermanentPushRefusal; commandCount: number }
			| undefined;
		const targetActorSequence =
			sqlite.all<{ actor_sequence: number }>(
				`SELECT actor_sequence FROM "${OUTBOX_TABLE}"
				 WHERE accepted_server_sequence IS NULL
				 ORDER BY actor_sequence DESC LIMIT 1`,
			)[0]?.actor_sequence ?? 0;

		while (!startsInBootstrap) {
			const request = sealPush(sqlite, pushLimit, targetActorSequence);
			if (!request) break;
			const response = parsePushResponse(await transport.push(request));
			if (!response.ok) {
				if (isPermanentPushRefusal(response.reason)) {
					quarantined = {
						reason: response.reason,
						commandCount: recoverPermanentPushRefusal(
							sqlite,
							request,
							response.reason,
						),
					};
					break;
				}
				throw new Error(`Record push refused: ${response.reason}`);
			}
			markPushAccepted(sqlite, request, response.receipt);
		}

		while (true) {
			const cursor = requireMeta(sqlite).pull_cursor;
			const response = parsePullResponse(
				await transport.pull({
					protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
					kind: 'pull',
					cursor,
					limit: pullLimit,
				}),
			);
			if (!response.ok) {
				throw new Error(`Record pull refused: ${response.reason}`);
			}
			if (response.snapshotRequired) {
				await downloadAndInstallSnapshot(response.manifest);
				if (requireMeta(sqlite).requires_bootstrap !== 1) onRemoteCommit();
				continue;
			}
			if (response.entries.length > pullLimit) {
				throw new Error('Pull response exceeds the requested entry limit');
			}
			const installed = installPullPage(sqlite, cursor, response);
			if (
				installed &&
				response.entries.length > 0 &&
				requireMeta(sqlite).requires_bootstrap !== 1
			) {
				onRemoteCommit();
			}
			if (!response.hasMore) break;
		}
		if (requireMeta(sqlite).requires_bootstrap === 1) {
			finishBootstrap(sqlite);
			onRemoteCommit();
		}
		if (quarantined) {
			throw new Error(
				`Record push permanently refused; ${quarantined.commandCount} command${quarantined.commandCount === 1 ? '' : 's'} quarantined: ${quarantined.reason}`,
			);
		}

		return status();
	}

	async function downloadAndInstallSnapshot(
		manifest: SnapshotManifest,
	): Promise<void> {
		if (!(await isValidSnapshotManifest(sha256, manifest))) {
			throw new Error('Snapshot manifest checksum is invalid');
		}
		prepareSnapshot(sqlite, manifest);
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
			stageSnapshotChunk(sqlite, manifest, chunk.rows, index);
			staged = readSnapshotMeta(sqlite);
			if (!staged) throw new Error('Snapshot staging disappeared');
		}
		installStagedSnapshot(sqlite, manifest);
	}

	function status(): CanonicalReplicaStatus {
		const meta = requireMeta(sqlite);
		const counts = sqlite.all<{
			pending: number;
			accepted: number;
		}>(
			`SELECT
				COALESCE(SUM(accepted_server_sequence IS NULL), 0) AS pending,
				COALESCE(SUM(accepted_server_sequence IS NOT NULL), 0) AS accepted
			 FROM "${OUTBOX_TABLE}"`,
		)[0] ?? { pending: 0, accepted: 0 };
		return {
			pullCursor: meta.pull_cursor,
			pendingCommands: counts.pending,
			acceptedCommandsAwaitingPull: counts.accepted,
			hasInflightPush: meta.inflight_first !== null,
		};
	}

	return {
		admit,
		/** Inspect durable rejected intent without making it authoritative again. */
		inspectQuarantine(): QuarantinedRecordCommand[] {
			return sqlite
				.all<StoredQuarantine>(
					`SELECT actor_id, actor_sequence, reason, command_json
					 FROM "${QUARANTINE_TABLE}"
					 ORDER BY actor_id, actor_sequence`,
				)
				.map((entry) => ({
					actorId: entry.actor_id,
					actorSequence: entry.actor_sequence,
					reason: entry.reason,
					command: parseMutation({
						actorSequence: entry.actor_sequence,
						command: JSON.parse(entry.command_json),
					}).command,
				}));
		},
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

function initialize(sqlite: RecordSyncSqlite): void {
	sqlite.transaction(() => {
		sqlite.run(`
			CREATE TABLE IF NOT EXISTS "${META_TABLE}" (
				id INTEGER PRIMARY KEY CHECK(id = 1),
				storage_version INTEGER NOT NULL,
				protocol_major INTEGER NOT NULL,
				actor_id TEXT NOT NULL,
				next_actor_sequence INTEGER NOT NULL,
				pull_cursor INTEGER NOT NULL,
				inflight_first INTEGER,
				inflight_last INTEGER,
				requires_bootstrap INTEGER NOT NULL DEFAULT 0
			) STRICT;
			CREATE TABLE IF NOT EXISTS "${OUTBOX_TABLE}" (
				actor_sequence INTEGER PRIMARY KEY,
				command_json TEXT NOT NULL CHECK(json_valid(command_json)),
				accepted_server_sequence INTEGER
			) STRICT;
			CREATE TABLE IF NOT EXISTS "${QUARANTINE_TABLE}" (
				actor_id TEXT NOT NULL,
				actor_sequence INTEGER NOT NULL,
				reason TEXT NOT NULL CHECK(reason IN (
					'create-conflict',
					'row-too-large',
					'depends-on-rejected-batch'
				)),
				command_json TEXT NOT NULL CHECK(json_valid(command_json)),
				PRIMARY KEY(actor_id, actor_sequence)
			) WITHOUT ROWID, STRICT;
			CREATE TABLE IF NOT EXISTS "${SNAPSHOT_META_TABLE}" (
				id INTEGER PRIMARY KEY CHECK(id = 1),
				generation INTEGER NOT NULL,
				manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
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
		`);
		const metaColumns = new Set(
			sqlite
				.all<{ name: string }>(`PRAGMA table_info("${META_TABLE}")`)
				.map(({ name }) => name),
		);
		if (!metaColumns.has('requires_bootstrap')) {
			sqlite.run(
				`ALTER TABLE "${META_TABLE}" ADD COLUMN requires_bootstrap INTEGER NOT NULL DEFAULT 0`,
			);
		}
		const stored = sqlite.all<{
			storage_version: number;
			protocol_major: number;
		}>(
			`SELECT storage_version, protocol_major FROM "${META_TABLE}" WHERE id = 1`,
		)[0];
		if (!stored) {
			sqlite.run(
				`INSERT INTO "${META_TABLE}"(
					id, storage_version, protocol_major, actor_id,
					next_actor_sequence, pull_cursor, inflight_first, inflight_last,
					requires_bootstrap
				) VALUES (1, ?, ?, ?, 1, 0, NULL, NULL, 0)`,
				[STORAGE_VERSION, RECORD_SYNC_PROTOCOL_MAJOR, crypto.randomUUID()],
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

function requireMeta(sqlite: RecordSyncSqlite): StoredMeta {
	const meta = sqlite.all<StoredMeta>(
		`SELECT actor_id, next_actor_sequence, pull_cursor,
		        inflight_first, inflight_last, requires_bootstrap
		 FROM "${META_TABLE}" WHERE id = 1`,
	)[0];
	if (!meta) throw new Error('Canonical replica is not initialized');
	return meta;
}

function sealPush(
	sqlite: RecordSyncSqlite,
	limit: number,
	targetActorSequence: number,
): PushRequest | null {
	return sqlite.transaction(() => {
		const meta = requireMeta(sqlite);
		let first = meta.inflight_first;
		let last = meta.inflight_last;
		if ((first === null) !== (last === null)) {
			throw new Error('Canonical replica has a malformed in-flight push');
		}
		if (first === null || last === null) {
			const pending = sqlite.all<StoredOutbox>(
				`SELECT actor_sequence, command_json, accepted_server_sequence
				 FROM "${OUTBOX_TABLE}"
				 WHERE accepted_server_sequence IS NULL AND actor_sequence <= ?
				 ORDER BY actor_sequence LIMIT ?`,
				[targetActorSequence, limit],
			);
			while (
				pending.length > 1 &&
				encodedJsonBytes(pushRequest(meta.actor_id, pending)) >
					RECORD_SYNC_ADMISSION_LIMITS.encodedPushBytes
			) {
				pending.pop();
			}
			first = pending[0]?.actor_sequence ?? null;
			last = pending.at(-1)?.actor_sequence ?? null;
			if (first === null || last === null) return null;
			parsePushRequest(pushRequest(meta.actor_id, pending));
			sqlite.run(
				`UPDATE "${META_TABLE}" SET inflight_first = ?, inflight_last = ? WHERE id = 1`,
				[first, last],
			);
		}
		const stored = sqlite.all<StoredOutbox>(
			`SELECT actor_sequence, command_json, accepted_server_sequence
			 FROM "${OUTBOX_TABLE}"
			 WHERE actor_sequence BETWEEN ? AND ? ORDER BY actor_sequence`,
			[first, last],
		);
		if (
			stored.length !== last - first + 1 ||
			stored.some((entry) => entry.accepted_server_sequence !== null)
		) {
			throw new Error('In-flight push does not match the pending outbox');
		}
		return parsePushRequest(pushRequest(meta.actor_id, stored));
	});
}

function pushRequest(actorId: string, stored: StoredOutbox[]): PushRequest {
	return {
		protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
		kind: 'push',
		actorId,
		mutations: stored.map((entry) =>
			parseMutation({
				actorSequence: entry.actor_sequence,
				command: JSON.parse(entry.command_json),
			}),
		),
	};
}

function markPushAccepted(
	sqlite: RecordSyncSqlite,
	request: PushRequest,
	receipt: {
		actorId: string;
		batchChecksum: string;
		firstActorSequence: number;
		lastActorSequence: number;
		firstServerSequence: number;
		lastServerSequence: number;
	},
): void {
	const first = request.mutations[0];
	const last = request.mutations.at(-1);
	if (
		!first ||
		!last ||
		receipt.actorId !== request.actorId ||
		receipt.batchChecksum !== recordBatchChecksum(request) ||
		receipt.firstActorSequence !== first.actorSequence ||
		receipt.lastActorSequence !== last.actorSequence ||
		receipt.lastServerSequence - receipt.firstServerSequence !==
			last.actorSequence - first.actorSequence
	) {
		throw new Error('Push receipt does not match the sealed request');
	}
	sqlite.transaction(() => {
		const meta = requireMeta(sqlite);
		const stored = sqlite.all<StoredOutbox>(
			`SELECT actor_sequence, command_json, accepted_server_sequence
			 FROM "${OUTBOX_TABLE}"
			 WHERE actor_sequence BETWEEN ? AND ? ORDER BY actor_sequence`,
			[first.actorSequence, last.actorSequence],
		);
		const alreadyAccepted =
			stored.length === request.mutations.length &&
			stored.every(
				(entry, index) =>
					entry.actor_sequence === first.actorSequence + index &&
					entry.accepted_server_sequence ===
						receipt.firstServerSequence + index,
			);
		const alreadyPruned =
			stored.length === 0 && meta.pull_cursor >= receipt.lastServerSequence;
		if (alreadyAccepted || alreadyPruned) return;
		if (
			meta.inflight_first !== first.actorSequence ||
			meta.inflight_last !== last.actorSequence
		) {
			throw new Error('Push receipt does not match local in-flight state');
		}
		for (const mutation of request.mutations) {
			const serverSequence =
				receipt.firstServerSequence +
				(mutation.actorSequence - first.actorSequence);
			sqlite.run(
				`UPDATE "${OUTBOX_TABLE}" SET accepted_server_sequence = ?
				 WHERE actor_sequence = ? AND accepted_server_sequence IS NULL`,
				[serverSequence, mutation.actorSequence],
			);
		}
		sqlite.run(
			`UPDATE "${META_TABLE}" SET inflight_first = NULL, inflight_last = NULL WHERE id = 1`,
		);
	});
}

function isPermanentPushRefusal(
	reason: PushRefusalReason,
): reason is PermanentPushRefusal {
	return reason === 'create-conflict' || reason === 'row-too-large';
}

function recoverPermanentPushRefusal(
	sqlite: RecordSyncSqlite,
	request: PushRequest,
	reason: PermanentPushRefusal,
): number {
	return sqlite.transaction(() => {
		const first = request.mutations[0];
		const last = request.mutations.at(-1);
		if (!first || !last) throw new Error('Refused push must not be empty');
		const meta = requireMeta(sqlite);
		if (
			request.actorId !== meta.actor_id ||
			meta.inflight_first !== first.actorSequence ||
			meta.inflight_last !== last.actorSequence
		) {
			throw new Error('Permanent refusal does not match local in-flight state');
		}
		const rejected = sqlite.all<StoredOutbox>(
			`SELECT actor_sequence, command_json, accepted_server_sequence
			 FROM "${OUTBOX_TABLE}"
			 WHERE actor_sequence BETWEEN ? AND ?
			 ORDER BY actor_sequence`,
			[first.actorSequence, last.actorSequence],
		);
		if (
			rejected.length !== request.mutations.length ||
			rejected.some(
				(entry, index) =>
					entry.accepted_server_sequence !== null ||
					entry.actor_sequence !== request.mutations[index]?.actorSequence ||
					JSON.stringify(JSON.parse(entry.command_json)) !==
						JSON.stringify(request.mutations[index]?.command),
			)
		) {
			throw new Error(
				'Permanent refusal does not match the sealed outbox batch',
			);
		}
		const later = sqlite.all<StoredOutbox>(
			`SELECT actor_sequence, command_json, accepted_server_sequence
			 FROM "${OUTBOX_TABLE}"
			 WHERE actor_sequence > ? AND accepted_server_sequence IS NULL
			 ORDER BY actor_sequence`,
			[last.actorSequence],
		);
		const rejectedRowKeys = new Set(
			request.mutations.map(({ command }) =>
				recordKey(command.table, command.rowId),
			),
		);
		const retained: StoredOutbox[] = [];
		const dependent: StoredOutbox[] = [];
		for (const entry of later) {
			const command = parseMutation({
				actorSequence: entry.actor_sequence,
				command: JSON.parse(entry.command_json),
			}).command;
			if (rejectedRowKeys.has(recordKey(command.table, command.rowId))) {
				dependent.push(entry);
			} else {
				retained.push(entry);
			}
		}

		for (const entry of rejected) {
			quarantineCommand(sqlite, meta.actor_id, entry, reason);
		}
		for (const entry of dependent) {
			quarantineCommand(
				sqlite,
				meta.actor_id,
				entry,
				'depends-on-rejected-batch',
			);
		}
		sqlite.run(`DELETE FROM "${OUTBOX_TABLE}"`);
		for (const [index, entry] of retained.entries()) {
			sqlite.run(
				`INSERT INTO "${OUTBOX_TABLE}"(
					actor_sequence, command_json, accepted_server_sequence
				) VALUES (?, ?, NULL)`,
				[index + 1, entry.command_json],
			);
		}
		sqlite.run(
			`UPDATE "${META_TABLE}" SET
				actor_id = ?,
				next_actor_sequence = ?,
				pull_cursor = 0,
				inflight_first = NULL,
				inflight_last = NULL,
				requires_bootstrap = 1
			 WHERE id = 1`,
			[crypto.randomUUID(), retained.length + 1],
		);
		sqlite.run(`DELETE FROM "${RECORDS_TABLE}"`);
		clearSnapshotStaging(sqlite);
		return rejected.length + dependent.length;
	});
}

function quarantineCommand(
	sqlite: RecordSyncSqlite,
	actorId: string,
	entry: StoredOutbox,
	reason: QuarantineReason,
): void {
	sqlite.run(
		`INSERT INTO "${QUARANTINE_TABLE}"(
			actor_id, actor_sequence, reason, command_json
		) VALUES (?, ?, ?, ?)`,
		[actorId, entry.actor_sequence, reason, entry.command_json],
	);
}

function finishBootstrap(sqlite: RecordSyncSqlite): void {
	sqlite.transaction(() => {
		if (requireMeta(sqlite).requires_bootstrap !== 1) return;
		// A zero-entry bootstrap still has to restore retained optimistic intent.
		replayOutbox(sqlite);
		sqlite.run(
			`UPDATE "${META_TABLE}" SET requires_bootstrap = 0 WHERE id = 1`,
		);
	});
}

function installPullPage(
	sqlite: RecordSyncSqlite,
	expectedCursor: number,
	response: Extract<
		ReturnType<typeof parsePullResponse>,
		{ ok: true; snapshotRequired: false }
	>,
): boolean {
	if (
		response.fromCursor !== expectedCursor ||
		response.newCursor < expectedCursor ||
		(response.hasMore &&
			(response.entries.length === 0 ||
				response.newCursor <= expectedCursor ||
				response.newCursor !== response.entries.at(-1)?.lastServerSequence)) ||
		!hasMonotoneEntries(response.entries, expectedCursor, response.newCursor)
	) {
		throw new Error('Pull response does not continue the local cursor');
	}
	return sqlite.transaction(() => {
		const currentCursor = requireMeta(sqlite).pull_cursor;
		if (currentCursor > expectedCursor) return false;
		if (currentCursor !== expectedCursor) {
			throw new Error('Pull cursor changed before installation');
		}
		const affected = new Set<string>();
		for (const entry of response.entries) {
			applyStateEntry(sqlite, entry);
			affected.add(recordKey(entry.table, entry.rowId));
		}
		sqlite.run(`UPDATE "${META_TABLE}" SET pull_cursor = ? WHERE id = 1`, [
			response.newCursor,
		]);
		pruneAcceptedOutbox(sqlite, response.newCursor);
		replayOutbox(sqlite, affected);
		clearSnapshotStaging(sqlite);
		return true;
	});
}

function hasMonotoneEntries(
	entries: readonly StateEntry[],
	expectedCursor: number,
	newCursor: number,
): boolean {
	let previousSequence = expectedCursor;
	const keys = new Set<string>();
	for (const entry of entries) {
		const key = recordKey(entry.table, entry.rowId);
		if (
			entry.lastServerSequence <= previousSequence ||
			entry.lastServerSequence > newCursor ||
			keys.has(key)
		) {
			return false;
		}
		previousSequence = entry.lastServerSequence;
		keys.add(key);
	}
	return true;
}

function prepareSnapshot(
	sqlite: RecordSyncSqlite,
	manifest: SnapshotManifest,
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
				id, generation, manifest_json, next_chunk_index
			) VALUES (1, ?, ?, 0)`,
			[manifest.generation, JSON.stringify(manifest)],
		);
	});
}

function readSnapshotMeta(
	sqlite: RecordSyncSqlite,
): StoredSnapshotMeta | undefined {
	return sqlite.all<StoredSnapshotMeta>(
		`SELECT generation, manifest_json, next_chunk_index
		 FROM "${SNAPSHOT_META_TABLE}" WHERE id = 1`,
	)[0];
}

function stageSnapshotChunk(
	sqlite: RecordSyncSqlite,
	manifest: SnapshotManifest,
	rows: readonly {
		table: string;
		rowId: string;
		value: JsonObject;
		lastServerSequence: number;
	}[],
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
		for (const row of rows) {
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
		sqlite.run(
			`UPDATE "${SNAPSHOT_META_TABLE}" SET next_chunk_index = ? WHERE id = 1`,
			[index + 1],
		);
	});
}

function installStagedSnapshot(
	sqlite: RecordSyncSqlite,
	manifest: SnapshotManifest,
): void {
	sqlite.transaction(() => {
		const staged = readSnapshotMeta(sqlite);
		if (
			staged?.generation !== manifest.generation ||
			staged.manifest_json !== JSON.stringify(manifest) ||
			staged.next_chunk_index !== manifest.chunkChecksums.length
		) {
			throw new Error('Snapshot staging is incomplete');
		}
		const meta = requireMeta(sqlite);
		if (meta.pull_cursor > manifest.head) {
			clearSnapshotStaging(sqlite);
			return;
		}
		const outbox = readOutbox(sqlite);
		if (meta.inflight_first !== null && meta.inflight_last !== null) {
			const inflightFirst = meta.inflight_first;
			const inflightLast = meta.inflight_last;
			const inflight = outbox.filter(
				(entry) =>
					entry.actor_sequence >= inflightFirst &&
					entry.actor_sequence <= inflightLast,
			);
			const retained = inflight.filter((entry) =>
				shouldRetainAfterSnapshot(entry, manifest, meta.actor_id),
			);
			if (retained.length !== 0 && retained.length !== inflight.length) {
				throw new Error('Snapshot splits one sealed local push');
			}
			if (retained.length === 0) {
				sqlite.run(
					`UPDATE "${META_TABLE}" SET inflight_first = NULL, inflight_last = NULL WHERE id = 1`,
				);
			}
		}
		sqlite.run(`DELETE FROM "${RECORDS_TABLE}"`);
		sqlite.run(
			`INSERT INTO "${RECORDS_TABLE}"(table_key, row_id, payload)
			 SELECT table_key, row_id, payload FROM "${SNAPSHOT_ROWS_TABLE}"
			 WHERE generation = ?`,
			[manifest.generation],
		);
		for (const entry of outbox) {
			if (!shouldRetainAfterSnapshot(entry, manifest, meta.actor_id)) {
				sqlite.run(`DELETE FROM "${OUTBOX_TABLE}" WHERE actor_sequence = ?`, [
					entry.actor_sequence,
				]);
			}
		}
		replayOutbox(sqlite);
		sqlite.run(`UPDATE "${META_TABLE}" SET pull_cursor = ? WHERE id = 1`, [
			manifest.head,
		]);
		clearSnapshotStaging(sqlite);
	});
}

function shouldRetainAfterSnapshot(
	entry: StoredOutbox,
	manifest: SnapshotManifest,
	actorId: string,
): boolean {
	return (
		entry.actor_sequence > (manifest.actorHighWater[actorId] ?? 0) &&
		(entry.accepted_server_sequence === null ||
			entry.accepted_server_sequence > manifest.head)
	);
}

function clearSnapshotStaging(sqlite: RecordSyncSqlite): void {
	sqlite.run(`DELETE FROM "${SNAPSHOT_ROWS_TABLE}"`);
	sqlite.run(`DELETE FROM "${SNAPSHOT_META_TABLE}"`);
}

function applyStateEntry(sqlite: RecordSyncSqlite, entry: StateEntry): void {
	switch (entry.kind) {
		case 'row':
			sqlite.run(
				`INSERT INTO "${RECORDS_TABLE}"(table_key, row_id, payload)
				 VALUES (?, ?, ?)
				 ON CONFLICT(table_key, row_id) DO UPDATE SET payload = excluded.payload`,
				[entry.table, entry.rowId, JSON.stringify(entry.value)],
			);
			return;
		case 'deletion':
			sqlite.run(
				`DELETE FROM "${RECORDS_TABLE}" WHERE table_key = ? AND row_id = ?`,
				[entry.table, entry.rowId],
			);
	}
}

function replayOutbox(
	sqlite: RecordSyncSqlite,
	affected?: ReadonlySet<string>,
): void {
	for (const entry of readOutbox(sqlite)) {
		const command = parseMutation({
			actorSequence: entry.actor_sequence,
			command: JSON.parse(entry.command_json),
		}).command;
		if (affected && !affected.has(recordKey(command.table, command.rowId))) {
			continue;
		}
		applyCommand(sqlite, command);
	}
}

function applyCommand(sqlite: RecordSyncSqlite, command: RecordCommand): void {
	const current = readCanonical(sqlite, command.table, command.rowId);
	const folded = foldRow(current ?? undefined, command);
	switch (folded.kind) {
		case 'create-conflict':
			throw new Error(
				`Pending create conflicts with '${command.table}/${command.rowId}'`,
			);
		case 'noop':
			return;
		case 'row':
			sqlite.run(
				`INSERT INTO "${RECORDS_TABLE}"(table_key, row_id, payload) VALUES (?, ?, ?)
				 ON CONFLICT(table_key, row_id) DO UPDATE SET payload = excluded.payload`,
				[command.table, command.rowId, JSON.stringify(folded.value)],
			);
			return;
		case 'deletion':
			sqlite.run(
				`DELETE FROM "${RECORDS_TABLE}" WHERE table_key = ? AND row_id = ?`,
				[command.table, command.rowId],
			);
	}
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

function readOutbox(sqlite: RecordSyncSqlite): StoredOutbox[] {
	return sqlite.all<StoredOutbox>(
		`SELECT actor_sequence, command_json, accepted_server_sequence
		 FROM "${OUTBOX_TABLE}" ORDER BY actor_sequence`,
	);
}

function pruneAcceptedOutbox(sqlite: RecordSyncSqlite, cursor: number): void {
	sqlite.run(
		`DELETE FROM "${OUTBOX_TABLE}"
		 WHERE accepted_server_sequence IS NOT NULL
		   AND accepted_server_sequence <= ?`,
		[cursor],
	);
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
