import {
	encodedJsonBytes,
	ROW_SYNC_ADMISSION_LIMITS,
	roundRequestsGrowth,
} from './admission.js';
import { foldFields } from './fold.js';
import type {
	BaselineRow,
	BaselineScanRequest,
	BaselineScanResponse,
	EnrollRequest,
	EnrollResponse,
	JsonObject,
	RowOutcome,
	SyncRequest,
	SyncResponse,
	SyncToken,
	WireRowIntent,
} from './protocol.js';
import {
	decodeBase64,
	encodeBase64,
	ROW_SYNC_PROTOCOL_MAJOR,
	requestRefusal,
} from './protocol.js';
import { rowRoundDigest } from './round-digest.js';
import type { RowSyncSqlite } from './sqlite.js';

const STORAGE_VERSION = 4;

/**
 * The injected merge-aware document codec (ADR-0133). The sync core stays
 * CRDT-library-free; the codec hydrates ordered opaque updates into one
 * fresh garbage-collected document and returns its compact full state. The
 * authority uses it for two operations only: bounding a candidate merge
 * before commit, and folding a retained tail into a compacted baseline.
 */
export type DocumentCodec = {
	mergedCompactState(parts: readonly Uint8Array[]): Uint8Array;
};

/**
 * The deployment capacity admission fact for one exchange (ADR-0137). The
 * deployment resolves it before calling the authority; `allow` is the
 * policy-free default. When the deployment cannot load its projection it
 * must not call `sync` with a growth-bearing round at all; it fails that
 * request closed with a retryable transport error instead of a definitive
 * refusal.
 */
export type GrowthDecision = 'allow' | 'delete-only';

type StoredMeta = {
	storage_version: number;
	protocol_major: number;
	server_sequence: number;
	retention_floor: number;
};

type StoredReplica = {
	accepted_round: number;
	request_digest: string;
	submission_watermark: number;
};

type StoredOutcome = {
	kind: 'row' | 'deletion' | 'documentUpdate';
	table_name: string;
	row_id: string;
	value_json: string | null;
	sequence: number;
};

function one<TRow extends Record<string, string | number | null>>(
	database: RowSyncSqlite,
	sql: string,
	parameters: readonly (string | number | null)[] = [],
): TRow | undefined {
	return database.all<TRow>(sql, parameters)[0];
}

function initialize(database: RowSyncSqlite): void {
	database.transaction(() => {
		const hasLegacyStorage = Boolean(
			one<{ present: number }>(
				database,
				`SELECT 1 AS present FROM sqlite_master
				 WHERE type = 'table'
				   AND name IN ('record_sync_meta', 'record_sync_family', 'record_sync_actors')`,
			),
		);
		if (hasLegacyStorage) {
			throw new Error('Incompatible legacy row-sync authority storage');
		}
		database.run(`
			CREATE TABLE IF NOT EXISTS row_sync_meta (
				id INTEGER PRIMARY KEY CHECK(id = 1),
				storage_version INTEGER NOT NULL,
				protocol_major INTEGER NOT NULL,
				server_sequence INTEGER NOT NULL,
				retention_floor INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS row_sync_replicas (
				replica_id TEXT PRIMARY KEY,
				accepted_round INTEGER NOT NULL,
				request_digest TEXT NOT NULL,
				submission_watermark INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS row_sync_rows (
				table_name TEXT NOT NULL,
				row_id TEXT NOT NULL,
				fields_json TEXT NOT NULL CHECK(json_valid(fields_json)),
				sequence INTEGER NOT NULL,
				PRIMARY KEY(table_name, row_id)
			);
			CREATE TABLE IF NOT EXISTS row_sync_field_outcomes (
				sequence INTEGER PRIMARY KEY,
				table_name TEXT NOT NULL,
				row_id TEXT NOT NULL,
				fields_json TEXT NOT NULL CHECK(json_valid(fields_json))
			);
			CREATE TABLE IF NOT EXISTS row_sync_deletion_outcomes (
				table_name TEXT NOT NULL,
				row_id TEXT NOT NULL,
				sequence INTEGER NOT NULL,
				PRIMARY KEY(table_name, row_id)
			);
			CREATE INDEX IF NOT EXISTS row_sync_deletion_outcomes_sequence
				ON row_sync_deletion_outcomes(sequence);
			CREATE TABLE IF NOT EXISTS row_sync_document_baselines (
				table_name TEXT NOT NULL,
				row_id TEXT NOT NULL,
				baseline_b64 TEXT NOT NULL,
				through_sequence INTEGER NOT NULL,
				PRIMARY KEY(table_name, row_id)
			);
			CREATE TABLE IF NOT EXISTS row_sync_document_updates (
				table_name TEXT NOT NULL,
				row_id TEXT NOT NULL,
				update_b64 TEXT NOT NULL,
				sequence INTEGER NOT NULL,
				PRIMARY KEY(table_name, row_id, sequence)
			);
			CREATE INDEX IF NOT EXISTS row_sync_document_updates_sequence
				ON row_sync_document_updates(sequence);
		`);
		const stored = readMeta(database);
		if (!stored) {
			database.run(
				`INSERT INTO row_sync_meta(
					id, storage_version, protocol_major, server_sequence,
					retention_floor
				) VALUES (1, ?, ?, 0, 0)`,
				[STORAGE_VERSION, ROW_SYNC_PROTOCOL_MAJOR],
			);
			return;
		}
		if (
			stored.storage_version !== STORAGE_VERSION ||
			stored.protocol_major !== ROW_SYNC_PROTOCOL_MAJOR
		) {
			throw new Error('Incompatible row-sync authority storage');
		}
	});
}

function readMeta(database: RowSyncSqlite): StoredMeta | undefined {
	return one<StoredMeta>(
		database,
		`SELECT storage_version, protocol_major, server_sequence, retention_floor
		 FROM row_sync_meta WHERE id = 1`,
	);
}

function requireMeta(database: RowSyncSqlite): StoredMeta {
	const meta = readMeta(database);
	if (!meta) throw new Error('Row authority is not initialized');
	return meta;
}

function readRowFields(
	database: RowSyncSqlite,
	table: string,
	rowId: string,
): JsonObject | undefined {
	const stored = one<{ fields_json: string }>(
		database,
		`SELECT fields_json FROM row_sync_rows
		 WHERE table_name = ? AND row_id = ?`,
		[table, rowId],
	);
	return stored ? JSON.parse(stored.fields_json) : undefined;
}

function readDocumentParts(
	database: RowSyncSqlite,
	table: string,
	rowId: string,
): Uint8Array[] {
	const parts: Uint8Array[] = [];
	const baseline = one<{ baseline_b64: string }>(
		database,
		`SELECT baseline_b64 FROM row_sync_document_baselines
		 WHERE table_name = ? AND row_id = ?`,
		[table, rowId],
	);
	if (baseline) parts.push(decodeBase64(baseline.baseline_b64));
	for (const update of database.all<{ update_b64: string }>(
		`SELECT update_b64 FROM row_sync_document_updates
		 WHERE table_name = ? AND row_id = ?
		 ORDER BY sequence`,
		[table, rowId],
	)) {
		parts.push(decodeBase64(update.update_b64));
	}
	return parts;
}

function writeRowFields(
	database: RowSyncSqlite,
	table: string,
	rowId: string,
	fields: JsonObject,
	sequence: number,
): void {
	database.run(
		`INSERT INTO row_sync_rows(table_name, row_id, fields_json, sequence)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT(table_name, row_id) DO UPDATE SET
			fields_json = excluded.fields_json,
			sequence = excluded.sequence`,
		[table, rowId, JSON.stringify(fields), sequence],
	);
	database.run(
		`INSERT INTO row_sync_field_outcomes(
			sequence, table_name, row_id, fields_json
		) VALUES (?, ?, ?, ?)`,
		[sequence, table, rowId, JSON.stringify(fields)],
	);
	database.run(
		`DELETE FROM row_sync_deletion_outcomes
		 WHERE table_name = ? AND row_id = ?`,
		[table, rowId],
	);
}

/**
 * Fold one admitted RowIntent at one authority sequence. Never refuses:
 * every outcome is an application or a deterministic no-op (ADR-0131). The
 * intent is one lifecycle atom; on a live update its field and document
 * components fold under independent capacity laws.
 */
function applyIntent(
	database: RowSyncSqlite,
	codec: DocumentCodec,
	intent: WireRowIntent,
	sequence: number,
): boolean {
	const current = readRowFields(database, intent.table, intent.rowId);
	switch (intent.kind) {
		case 'create': {
			const folded = foldFields(current, intent);
			// A live address or over-cap fields no-op the whole create.
			if (folded.kind !== 'fields') return false;
			let documentUpdate: string | undefined;
			if (intent.documentUpdate !== undefined) {
				const bytes = decodeBase64(intent.documentUpdate);
				const compact = codec.mergedCompactState([bytes]);
				// An oversized initial document no-ops the create as a whole, so
				// document bytes cannot merge into another row lifetime.
				if (
					compact.byteLength > ROW_SYNC_ADMISSION_LIMITS.canonicalDocumentBytes
				) {
					return false;
				}
				documentUpdate = intent.documentUpdate;
			}
			writeRowFields(
				database,
				intent.table,
				intent.rowId,
				folded.fields,
				sequence,
			);
			if (documentUpdate !== undefined) {
				database.run(
					`INSERT INTO row_sync_document_updates(
						table_name, row_id, update_b64, sequence
					) VALUES (?, ?, ?, ?)`,
					[intent.table, intent.rowId, documentUpdate, sequence],
				);
			}
			return true;
		}
		case 'update': {
			const folded = foldFields(current, intent);
			const reservedKvFold = current === undefined && folded.kind === 'fields';
			// Update on an absent address no-ops as a whole; the reserved KV
			// address folds from `{}` (ADR-0132) and never has a document.
			if (current === undefined && !reservedKvFold) return false;
			let fieldsApplied = false;
			if (folded.kind === 'fields') {
				writeRowFields(
					database,
					intent.table,
					intent.rowId,
					folded.fields,
					sequence,
				);
				fieldsApplied = true;
			}
			let documentApplied = false;
			if (intent.documentUpdate !== undefined && current !== undefined) {
				const candidate = decodeBase64(intent.documentUpdate);
				const merged = codec.mergedCompactState([
					...readDocumentParts(database, intent.table, intent.rowId),
					candidate,
				]);
				// Client admission is not the authority bound: two valid bounded
				// documents can merge above the canonical maximum (ADR-0131).
				if (
					merged.byteLength <= ROW_SYNC_ADMISSION_LIMITS.canonicalDocumentBytes
				) {
					database.run(
						`INSERT INTO row_sync_document_updates(
							table_name, row_id, update_b64, sequence
						) VALUES (?, ?, ?, ?)`,
						[intent.table, intent.rowId, intent.documentUpdate, sequence],
					);
					documentApplied = true;
				}
			}
			return fieldsApplied || documentApplied;
		}
		case 'delete': {
			if (current === undefined) return false;
			database.run(
				`DELETE FROM row_sync_rows WHERE table_name = ? AND row_id = ?`,
				[intent.table, intent.rowId],
			);
			database.run(
				`INSERT INTO row_sync_deletion_outcomes(table_name, row_id, sequence)
				 VALUES (?, ?, ?)
				 ON CONFLICT(table_name, row_id) DO UPDATE SET
					sequence = excluded.sequence`,
				[intent.table, intent.rowId, sequence],
			);
			// Death removes all authoritative document state in one transaction;
			// late updates for the absent address fold to no-ops forever.
			database.run(
				`DELETE FROM row_sync_document_baselines
				 WHERE table_name = ? AND row_id = ?`,
				[intent.table, intent.rowId],
			);
			database.run(
				`DELETE FROM row_sync_document_updates
				 WHERE table_name = ? AND row_id = ?`,
				[intent.table, intent.rowId],
			);
			return true;
		}
	}
}

/**
 * Collect raw outcome parts above a checkpoint. One sequence may carry a row
 * postimage part and a document part from the same applied intent; the
 * caller coalesces them into one composite outcome and never splits one
 * sequence across pages.
 */
function collectOutcomeParts(
	database: RowSyncSqlite,
	checkpoint: number,
	limit: number,
): StoredOutcome[] {
	return database.all<StoredOutcome>(
		`SELECT kind, table_name, row_id, value_json, sequence
		 FROM (
			SELECT 'row' AS kind, table_name, row_id, fields_json AS value_json,
			       sequence
			FROM row_sync_field_outcomes
			UNION ALL
			SELECT 'deletion' AS kind, table_name, row_id, NULL AS value_json,
			       sequence
			FROM row_sync_deletion_outcomes
			UNION ALL
			SELECT 'documentUpdate' AS kind, table_name, row_id,
			       update_b64 AS value_json, sequence
			FROM row_sync_document_updates
		 )
		 WHERE sequence > ?
		 ORDER BY sequence, kind, table_name, row_id
		 LIMIT ?`,
		[checkpoint, limit],
	);
}

function coalesceOutcomes(parts: readonly StoredOutcome[]): RowOutcome[] {
	const outcomes: RowOutcome[] = [];
	for (const part of parts) {
		const previous = outcomes.at(-1);
		if (
			previous &&
			previous.kind === 'row' &&
			previous.sequence === part.sequence &&
			previous.table === part.table_name &&
			previous.rowId === part.row_id
		) {
			// The row and document parts of one applied intent share a sequence.
			if (part.kind === 'documentUpdate') {
				previous.documentUpdate = part.value_json as string;
				continue;
			}
			if (part.kind === 'row') {
				previous.fields = JSON.parse(part.value_json as string);
				continue;
			}
		}
		switch (part.kind) {
			case 'row':
				outcomes.push({
					kind: 'row',
					table: part.table_name,
					rowId: part.row_id,
					fields: JSON.parse(part.value_json as string),
					sequence: part.sequence,
				});
				break;
			case 'documentUpdate':
				outcomes.push({
					kind: 'row',
					table: part.table_name,
					rowId: part.row_id,
					documentUpdate: part.value_json as string,
					sequence: part.sequence,
				});
				break;
			case 'deletion':
				outcomes.push({
					kind: 'deletion',
					table: part.table_name,
					rowId: part.row_id,
					sequence: part.sequence,
				});
				break;
		}
	}
	return outcomes;
}

function mintReplicaId(): string {
	const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
	const bytes = new Uint8Array(24);
	globalThis.crypto.getRandomValues(bytes);
	let id = '';
	for (const byte of bytes) id += alphabet[byte % alphabet.length];
	return id;
}

export type RowAuthorityCompactionPolicy = {
	/**
	 * How many trailing authority sequences stay incrementally reachable. The
	 * retention window must let one baseline acquisition finish (ADR-0136);
	 * deployments size it generously from measured scan throughput.
	 */
	minimumRetainedSequences: number;
};

/** Open one schema-blind fold-never-refuse row authority over caller-owned SQLite. */
export function openRowAuthority({
	database,
	codec,
}: {
	database: RowSyncSqlite;
	codec: DocumentCodec;
}) {
	initialize(database);

	const authority = {
		/**
		 * Explicit replica enrollment (ADR-0131). Mints the protocol identity
		 * whose exact-retry receipt the authority retains until workspace
		 * deletion. Deployment capacity admission may refuse enrollment
		 * (ADR-0137); authentication is the caller's, outside this core.
		 */
		enroll(
			request: EnrollRequest,
			{ growth = 'allow' }: { growth?: GrowthDecision } = {},
		): EnrollResponse {
			const refusal = requestRefusal(request);
			if (refusal) return { result: refusal };
			if (growth === 'delete-only') {
				return { result: 'enrollment-refused' };
			}
			return database.transaction(() => {
				requireMeta(database);
				for (;;) {
					const replicaId = mintReplicaId();
					const exists = one<{ present: number }>(
						database,
						'SELECT 1 AS present FROM row_sync_replicas WHERE replica_id = ?',
						[replicaId],
					);
					if (exists) continue;
					database.run(
						`INSERT INTO row_sync_replicas(
							replica_id, accepted_round, request_digest, submission_watermark
						) VALUES (?, 0, '', 0)`,
						[replicaId],
					);
					return { result: 'enrolled', replicaId } as const;
				}
			});
		},

		/**
		 * One exchange (ADR-0131): evaluate an optional sealed round in the
		 * fixed order (protocol major, replica identity, submission watermark,
		 * retry head, deployment capacity admission, fold), then answer with
		 * ordered confirmed outcomes from the caller's checkpoint. Row
		 * effects, outcomes, the retry head, and the watermark commit in one
		 * transaction.
		 */
		sync(
			request: SyncRequest,
			{ growth = 'allow' }: { growth?: GrowthDecision } = {},
		): SyncResponse {
			const refusal = requestRefusal(request);
			if (refusal) return { result: refusal };
			const round = request.sealedRound;
			return database.transaction(() => {
				const facts = request.token;
				// Validate the token before folding anything so a corrupt
				// checkpoint can never roll back an accepted round.
				if (facts.checkpoint > requireMeta(database).server_sequence) {
					throw new TypeError('Sync checkpoint is ahead of the authority');
				}
				const stored = one<StoredReplica>(
					database,
					`SELECT accepted_round, request_digest, submission_watermark
					 FROM row_sync_replicas WHERE replica_id = ?`,
					[facts.replicaId],
				);
				// Ordinary sync never creates authority state for an unseen
				// client-supplied id; enrollment mints identity first.
				if (!stored) {
					return { result: 'unknown-replica' } as const;
				}

				if (round) {
					if (round.submission <= stored.submission_watermark) {
						// Inert: folds nothing, changes no receipt state, and is
						// never evaluated for capacity.
						return {
							result: 'stale-submission',
							submission: round.submission,
							watermark: stored.submission_watermark,
						} as const;
					}
					// Durably advance the watermark before evaluating the round,
					// in the same transaction that commits any fold.
					database.run(
						`UPDATE row_sync_replicas SET submission_watermark = ?
						 WHERE replica_id = ?`,
						[round.submission, facts.replicaId],
					);
					// After the stale gate: a corrupt digest is client-authored
					// corruption, refused as an invalid request. The throw rolls
					// this transaction (and the watermark advance) back.
					if (rowRoundDigest(round.intents) !== round.requestDigest) {
						throw new TypeError(
							'Sealed round digest does not match its intents',
						);
					}
					if (round.round === stored.accepted_round) {
						// Retry of the accepted round: digest must match; nothing
						// refolds and pages regenerate from current state. The
						// retry-head check runs before capacity admission, so an
						// exact retry returns its idempotent acceptance even in
						// delete-only state.
						if (round.requestDigest !== stored.request_digest) {
							return {
								result: 'replica-fork',
								submission: round.submission,
							} as const;
						}
					} else if (round.round === stored.accepted_round + 1) {
						if (
							growth === 'delete-only' &&
							roundRequestsGrowth(round.intents)
						) {
							// Definitive deployment refusal before semantic folding:
							// only the watermark advanced; the retry head does not
							// move, no rejection history persists, and no intent
							// folds. A mixed round is never partially accepted.
							return {
								result: 'capacity-refused',
								submission: round.submission,
							} as const;
						}
						const meta = requireMeta(database);
						let serverSequence = meta.server_sequence;
						for (const intent of round.intents) {
							serverSequence += 1;
							applyIntent(database, codec, intent, serverSequence);
						}
						database.run(
							'UPDATE row_sync_meta SET server_sequence = ? WHERE id = 1',
							[serverSequence],
						);
						database.run(
							`UPDATE row_sync_replicas SET
								accepted_round = ?, request_digest = ?
							 WHERE replica_id = ?`,
							[round.round, round.requestDigest, facts.replicaId],
						);
					} else {
						// A round from the past (or a skipped future) proves a fork
						// or a corrupted replica; one stored digest cannot judge it.
						return {
								result: 'replica-fork',
								submission: round.submission,
							} as const;
					}
				}

				const acceptedRound = round
					? Math.max(stored.accepted_round, round.round)
					: stored.accepted_round;
				const meta = requireMeta(database);
				const submission = round ? round.submission : undefined;

				// Round first, baseline second: the fold above already happened.
				if (facts.checkpoint < meta.retention_floor) {
					return {
						result: 'baseline-required',
						token: {
							replicaId: facts.replicaId,
							acceptedRound,
							checkpoint: facts.checkpoint,
						} satisfies SyncToken,
						retentionFloor: meta.retention_floor,
						...(submission === undefined ? {} : { submission }),
					} as const;
				}

				const pageLimit =
					request.pageLimit ?? ROW_SYNC_ADMISSION_LIMITS.outcomesPerPage;
				// Fetch two extra parts so a row+document pair sharing the last
				// included sequence is never split across pages.
				const parts = collectOutcomeParts(
					database,
					facts.checkpoint,
					pageLimit + 2,
				);
				let included = parts.slice(0, pageLimit);
				while (
					included.length > 0 &&
					included.length < parts.length &&
					parts[included.length]!.sequence === included.at(-1)!.sequence
				) {
					included = parts.slice(0, included.length + 1);
				}
				let outcomes = coalesceOutcomes(included);
				let hasMore = parts.length > included.length;
				const page = (): Extract<
					SyncResponse,
					{ result: 'page' }
				> => ({
					result: 'page',
					token: {
						replicaId: facts.replicaId,
						acceptedRound,
						checkpoint: hasMore
							? (outcomes.at(-1)?.sequence ?? facts.checkpoint)
							: meta.server_sequence,
					} satisfies SyncToken,
					outcomes,
					hasMore,
					retentionFloor: meta.retention_floor,
					...(submission === undefined ? {} : { submission }),
				});
				let response = page();
				while (
					encodedJsonBytes(response) >
					ROW_SYNC_ADMISSION_LIMITS.encodedPageBytes
				) {
					if (outcomes.length <= 1) {
						throw new Error(
							'One admitted composite outcome exceeds the page byte limit',
						);
					}
					outcomes = outcomes.slice(0, -1);
					hasMore = true;
					response = page();
				}
				return response;
			});
		},

		/**
		 * One stateless baseline-acquisition page (ADR-0136): complete live
		 * rows in stable address order, each read atomically with its full
		 * document composite. The response reports the head observed with the
		 * page and the retention floor so the client can anchor `S`, capture
		 * `E`, and detect a floor race. The authority stores nothing.
		 */
		baselineScan(request: BaselineScanRequest): BaselineScanResponse {
			const refusal = requestRefusal(request);
			if (refusal) {
				return { result: refusal };
			}
			return database.transaction(() => {
				const meta = requireMeta(database);
				const pageLimit =
					request.pageLimit ?? ROW_SYNC_ADMISSION_LIMITS.baselineRowsPerPage;
				const after = request.after;
				const storedRows = database.all<{
					table_name: string;
					row_id: string;
					fields_json: string;
				}>(
					`SELECT table_name, row_id, fields_json FROM row_sync_rows
					 WHERE (? IS NULL)
					    OR (table_name > ?)
					    OR (table_name = ? AND row_id > ?)
					 ORDER BY table_name, row_id
					 LIMIT ?`,
					[
						after ? 1 : null,
						after?.table ?? '',
						after?.table ?? '',
						after?.rowId ?? '',
						pageLimit + 1,
					],
				);
				let hasMore = storedRows.length > pageLimit;
				let rows: BaselineRow[] = storedRows
					.slice(0, pageLimit)
					.map((stored) => {
						const baseline = one<{ baseline_b64: string }>(
							database,
							`SELECT baseline_b64 FROM row_sync_document_baselines
							 WHERE table_name = ? AND row_id = ?`,
							[stored.table_name, stored.row_id],
						);
						const updates = database
							.all<{ update_b64: string }>(
								`SELECT update_b64 FROM row_sync_document_updates
								 WHERE table_name = ? AND row_id = ?
								 ORDER BY sequence`,
								[stored.table_name, stored.row_id],
							)
							.map((update) => update.update_b64);
						const document =
							baseline || updates.length > 0
								? {
										...(baseline ? { baseline: baseline.baseline_b64 } : {}),
										updates,
									}
								: undefined;
						return {
							table: stored.table_name,
							rowId: stored.row_id,
							fields: JSON.parse(stored.fields_json),
							...(document === undefined ? {} : { document }),
						};
					});
				const page = (): Extract<BaselineScanResponse, { result: 'page' }> => ({
					result: 'page',
					rows,
					head: meta.server_sequence,
					retentionFloor: meta.retention_floor,
					hasMore,
				});
				let response = page();
				while (
					encodedJsonBytes(response) >
					ROW_SYNC_ADMISSION_LIMITS.encodedPageBytes
				) {
					if (rows.length <= 1) {
						const only = rows[0];
						if (!only?.document || only.document.updates.length === 0) {
							throw new Error(
								'One live row composite exceeds the page byte limit',
							);
						}
						// A redundant retained tail can exceed the page even though
						// the merged compact state stays bounded by admission.
						// Collapse the composite through the codec for transport;
						// Yjs idempotence makes the compact form equivalent.
						const compact = codec.mergedCompactState([
							...(only.document.baseline
								? [decodeBase64(only.document.baseline)]
								: []),
							...only.document.updates.map(decodeBase64),
						]);
						rows = [
							{
								...only,
								document: { baseline: encodeBase64(compact), updates: [] },
							},
						];
						response = page();
						continue;
					}
					rows = rows.slice(0, -1);
					hasMore = true;
					response = page();
				}
				return response;
			});
		},

		/**
		 * Raise the retention floor (ADR-0133). Field and deletion outcomes at or
		 * below it are forgotten, and each live document's covered update prefix
		 * folds into one compacted baseline whose completeness sequence is the
		 * prefix's last sequence. Current rows and exact-retry receipts remain.
		 */
		compactOutcomesThrough(requestedFloor: number): number {
			if (!Number.isSafeInteger(requestedFloor) || requestedFloor < 0) {
				throw new TypeError('Compaction floor must be a non-negative integer');
			}
			return database.transaction(() => {
				const meta = requireMeta(database);
				const floor = Math.max(
					meta.retention_floor,
					Math.min(requestedFloor, meta.server_sequence),
				);
				database.run(
					'DELETE FROM row_sync_field_outcomes WHERE sequence <= ?',
					[floor],
				);
				database.run(
					'DELETE FROM row_sync_deletion_outcomes WHERE sequence <= ?',
					[floor],
				);
				const keys = database.all<{ table_name: string; row_id: string }>(
					`SELECT DISTINCT table_name, row_id FROM row_sync_document_updates
					 WHERE sequence <= ?`,
					[floor],
				);
				for (const key of keys) {
					const covered = database.all<{
						update_b64: string;
						sequence: number;
					}>(
						`SELECT update_b64, sequence FROM row_sync_document_updates
						 WHERE table_name = ? AND row_id = ? AND sequence <= ?
						 ORDER BY sequence`,
						[key.table_name, key.row_id, floor],
					);
					const baseline = one<{ baseline_b64: string }>(
						database,
						`SELECT baseline_b64 FROM row_sync_document_baselines
						 WHERE table_name = ? AND row_id = ?`,
						[key.table_name, key.row_id],
					);
					const parts = [
						...(baseline ? [decodeBase64(baseline.baseline_b64)] : []),
						...covered.map((update) => decodeBase64(update.update_b64)),
					];
					const merged = encodeBase64(codec.mergedCompactState(parts));
					const throughSequence = covered.at(-1)!.sequence;
					database.run(
						`INSERT INTO row_sync_document_baselines(
							table_name, row_id, baseline_b64, through_sequence
						) VALUES (?, ?, ?, ?)
						ON CONFLICT(table_name, row_id) DO UPDATE SET
							baseline_b64 = excluded.baseline_b64,
							through_sequence = excluded.through_sequence`,
						[key.table_name, key.row_id, merged, throughSequence],
					);
					database.run(
						`DELETE FROM row_sync_document_updates
						 WHERE table_name = ? AND row_id = ? AND sequence <= ?`,
						[key.table_name, key.row_id, floor],
					);
				}
				database.run(
					'UPDATE row_sync_meta SET retention_floor = ? WHERE id = 1',
					[floor],
				);
				return floor;
			});
		},

		/**
		 * Opportunistic bounded-history maintenance: keep the trailing
		 * retention window incrementally reachable and fold everything older.
		 */
		maybeCompact({
			minimumRetainedSequences,
		}: RowAuthorityCompactionPolicy): number | undefined {
			if (
				!Number.isSafeInteger(minimumRetainedSequences) ||
				minimumRetainedSequences < 0
			) {
				throw new TypeError('Invalid retained sequence count');
			}
			const meta = requireMeta(database);
			const target = meta.server_sequence - minimumRetainedSequences;
			if (target <= meta.retention_floor) return undefined;
			return authority.compactOutcomesThrough(target);
		},

		inspect() {
			const meta = requireMeta(database);
			return {
				head: meta.server_sequence,
				retentionFloor: meta.retention_floor,
				rows: database
					.all<{
						table_name: string;
						row_id: string;
						fields_json: string;
						sequence: number;
					}>(
						`SELECT table_name, row_id, fields_json, sequence
						 FROM row_sync_rows ORDER BY table_name, row_id`,
					)
					.map((row) => ({
						table: row.table_name,
						rowId: row.row_id,
						fields: JSON.parse(row.fields_json) as JsonObject,
						sequence: row.sequence,
					})),
				deletionOutcomes: database.all<{
					table: string;
					rowId: string;
					sequence: number;
				}>(
					`SELECT table_name AS "table", row_id AS rowId, sequence
					 FROM row_sync_deletion_outcomes ORDER BY table_name, row_id`,
				),
				documentBaselines: database.all<{
					table: string;
					rowId: string;
					throughSequence: number;
				}>(
					`SELECT table_name AS "table", row_id AS rowId,
					        through_sequence AS throughSequence
					 FROM row_sync_document_baselines ORDER BY table_name, row_id`,
				),
				documentUpdates: database.all<{
					table: string;
					rowId: string;
					sequence: number;
				}>(
					`SELECT table_name AS "table", row_id AS rowId, sequence
					 FROM row_sync_document_updates
					 ORDER BY table_name, row_id, sequence`,
				),
				replicas: Object.fromEntries(
					database
						.all<{
							replica_id: string;
							accepted_round: number;
							submission_watermark: number;
						}>(
							`SELECT replica_id, accepted_round, submission_watermark
							 FROM row_sync_replicas ORDER BY replica_id`,
						)
						.map((replica) => [
							replica.replica_id,
							{
								acceptedRound: replica.accepted_round,
								submissionWatermark: replica.submission_watermark,
							},
						]),
				),
			};
		},
	};

	return authority;
}

export type RowAuthority = ReturnType<typeof openRowAuthority>;
