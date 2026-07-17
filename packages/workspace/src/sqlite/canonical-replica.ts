import {
	type BaselineScanRequest,
	type EnrollRequest,
	foldFields,
	type JsonObject,
	parseEnrollResponse,
	parseRowIntent,
	parseSyncResponse,
	ROW_SYNC_ADMISSION_LIMITS,
	ROW_SYNC_PROTOCOL_MAJOR,
	type RowOutcome,
	type RowSyncSqlite,
	rowRoundDigest,
	type SyncRequest,
	type SyncResponse,
	type SyncToken,
	type WireRowIntent,
} from '@epicenter/row-sync';

/** Physical layout version, owned by `PRAGMA user_version` (ADR-0134). */
const USER_VERSION = 1;

const ROWS_TABLE = 'rows';
const DOCUMENTS_TABLE = 'documents';
const INTENTS_TABLE = 'intents';
const REPLICA_TABLE = 'replica';

/**
 * The workspace's Yjs update operations, injected so this owner stays
 * CRDT-library-free. `mergeUpdates` composes ordered opaque updates into one
 * update without loading a document; installs and open-intent compaction use
 * it.
 */
export type ReplicaCodec = {
	mergeUpdates(
		parts: readonly Uint8Array[],
		basePartCount?: number,
	): Uint8Array;
};

export type CanonicalReplicaTransport = {
	enroll(request: EnrollRequest): Promise<unknown>;
	sync(request: SyncRequest): Promise<unknown>;
	baselineScan(request: BaselineScanRequest): Promise<unknown>;
};

export type CanonicalReplicaStatus = {
	checkpoint: number;
	pendingIntents: number;
	hasInflightRound: boolean;
	/** True when a definitive delete-only refusal left growth intents queued. */
	capacityBlocked: boolean;
};

type StoredIntent = {
	table_key: string;
	row_id: string;
	sealed: number;
	kind: 'create' | 'update' | 'delete';
	fields_json: string | null;
	document_update: Uint8Array | null;
};

type StoredReplica = {
	replica_id: string;
	accepted_round: number;
	checkpoint: number;
	in_flight_round: number | null;
	in_flight_request_digest: string | null;
};

/**
 * Open the private synchronization owner for one canonical workspace file
 * (ADR-0134). Canonical user state is confirmed authority state plus
 * compacted sealed and open RowIntents; the four tables here are the only
 * canonical owners. The returned capability belongs to the workspace
 * runtime, not applications.
 *
 * This owner is the replica's single exclusive writer (ADR-0131): the
 * runtime enforces the lease physically (the browser's OPFS synchronous
 * access handle; process-local file ownership elsewhere), and the in-memory
 * submission counter is scoped to it. A crash costs one stale-submission
 * response, whose watermark the counter jumps past.
 */
export function createCanonicalReplica({
	sqlite,
	transport,
	codec,
	onRemoteCommit = () => undefined,
	onRowsDeleted = () => undefined,
	roundLimit = ROW_SYNC_ADMISSION_LIMITS.intentsPerRound,
	pageLimit = ROW_SYNC_ADMISSION_LIMITS.outcomesPerPage,
}: {
	sqlite: RowSyncSqlite;
	transport: CanonicalReplicaTransport;
	codec: ReplicaCodec;
	onRemoteCommit?: () => void;
	/** Confirmed deletions revoke document handles (ADR-0135). */
	onRowsDeleted?: (addresses: { table: string; rowId: string }[]) => void;
	roundLimit?: number;
	pageLimit?: number;
}) {
	assertLimit(roundLimit, ROW_SYNC_ADMISSION_LIMITS.intentsPerRound, 'round');
	assertLimit(pageLimit, ROW_SYNC_ADMISSION_LIMITS.outcomesPerPage, 'page');
	initializeCanonicalSchema(sqlite);
	let activeSynchronization: Promise<CanonicalReplicaStatus> | undefined;
	let rerunRequested = false;
	/** Strictly increasing per transmission; exclusive-writer scoped. */
	let nextSubmission = 1;
	/** The greatest submission issued for the current in-flight image. */
	let greatestIssuedSubmission = 0;
	/** Set by a definitive refusal; cleared when growth may retry. */
	let capacityBlocked = false;

	function readReplica(): StoredReplica | undefined {
		return sqlite.all<StoredReplica>(
			`SELECT replica_id, accepted_round, checkpoint,
			        in_flight_round, in_flight_request_digest
			 FROM "${REPLICA_TABLE}" WHERE id = 1`,
		)[0];
	}

	function requireReplica(): StoredReplica {
		const stored = readReplica();
		if (!stored) throw new Error('Replica is not enrolled');
		return stored;
	}

	function readStoredIntents(sealed: 0 | 1): StoredIntent[] {
		return sqlite.all<StoredIntent>(
			`SELECT table_key, row_id, sealed, kind, fields_json, document_update
			 FROM "${INTENTS_TABLE}" WHERE sealed = ?
			 ORDER BY table_key, row_id`,
			[sealed],
		);
	}

	const toWire = storedIntentToWire;

	function writeStoredIntent(intent: WireRowIntent, sealed: 0 | 1): void {
		const admitted = parseRowIntent(intent);
		const fieldsJson =
			admitted.kind === 'delete' || admitted.fields === undefined
				? null
				: JSON.stringify(admitted.fields);
		const documentUpdate =
			admitted.kind !== 'delete' && admitted.documentUpdate !== undefined
				? base64ToBytes(admitted.documentUpdate)
				: null;
		sqlite.run(
			`INSERT INTO "${INTENTS_TABLE}"(
				table_key, row_id, sealed, kind, fields_json, document_update
			) VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT(table_key, row_id, sealed) DO UPDATE SET
				kind = excluded.kind,
				fields_json = excluded.fields_json,
				document_update = excluded.document_update`,
			[
				admitted.table,
				admitted.rowId,
				sealed,
				admitted.kind,
				fieldsJson,
				documentUpdate,
			],
		);
	}

	/**
	 * Compact one newer intent into the existing open intent for its address
	 * (ADR-0134). Nothing compacts across the seal.
	 *
	 * ```txt
	 * create + update   -> create(final fields, merged document)
	 * create + delete   -> no intent
	 * update + update   -> update(final set/unset, merged document)
	 * update + delete   -> delete
	 * ```
	 */
	function compactIntoOpen(next: WireRowIntent): void {
		const existing = sqlite.all<StoredIntent>(
			`SELECT table_key, row_id, sealed, kind, fields_json, document_update
			 FROM "${INTENTS_TABLE}"
			 WHERE table_key = ? AND row_id = ? AND sealed = 0`,
			[next.table, next.rowId],
		)[0];
		if (!existing) {
			writeStoredIntent(withCompactedDocument(next), 0);
			return;
		}
		const open = toWire(existing);
		if (open.kind === 'delete') {
			throw new Error('A locally deleted row accepts no further intent');
		}
		if (next.kind === 'create') {
			throw new Error('A live open intent already exists for this address');
		}
		if (next.kind === 'delete') {
			if (open.kind === 'create') {
				// create + delete -> no intent: the row never existed remotely.
				sqlite.run(
					`DELETE FROM "${INTENTS_TABLE}"
					 WHERE table_key = ? AND row_id = ? AND sealed = 0`,
					[next.table, next.rowId],
				);
				return;
			}
			writeStoredIntent(next, 0);
			return;
		}
		const mergedDocument = compactDocumentComponent(
			next.table,
			next.rowId,
			open.documentUpdate,
			next.documentUpdate,
		);
		if (open.kind === 'create') {
			const folded = foldFields(open.fields, next);
			const fields =
				next.fields === undefined
					? open.fields
					: folded.kind === 'fields'
						? folded.fields
						: undefined;
			if (fields === undefined) {
				throw new Error('Local intent composition exceeded its capacity cap');
			}
			writeStoredIntent(
				{
					kind: 'create',
					table: next.table,
					rowId: next.rowId,
					fields,
					...(mergedDocument === undefined
						? {}
						: { documentUpdate: mergedDocument }),
				},
				0,
			);
			return;
		}
		const fields = composeFieldChanges(open.fields, next.fields);
		writeStoredIntent(
			{
				kind: 'update',
				table: next.table,
				rowId: next.rowId,
				...(fields === undefined ? {} : { fields }),
				...(mergedDocument === undefined
					? {}
					: { documentUpdate: mergedDocument }),
			},
			0,
		);
	}

	function compactDocumentComponent(
		table: string,
		rowId: string,
		older: string | undefined,
		newer: string | undefined,
	): string | undefined {
		if (newer === undefined) return older;
		const base = readDocumentBaseParts(table, rowId);
		const open = older === undefined ? [] : [base64ToBytes(older)];
		return bytesToBase64(
			codec.mergeUpdates([...base, ...open, base64ToBytes(newer)], base.length),
		);
	}

	function withCompactedDocument(intent: WireRowIntent): WireRowIntent {
		if (intent.kind === 'delete' || intent.documentUpdate === undefined) {
			return intent;
		}
		const base = readDocumentBaseParts(intent.table, intent.rowId);
		return {
			...intent,
			documentUpdate: bytesToBase64(
				codec.mergeUpdates(
					[...base, base64ToBytes(intent.documentUpdate)],
					base.length,
				),
			),
		};
	}

	function readDocumentBaseParts(table: string, rowId: string): Uint8Array[] {
		const parts: Uint8Array[] = [];
		const confirmed = sqlite.all<{ yjs_state: Uint8Array }>(
			`SELECT yjs_state FROM "${DOCUMENTS_TABLE}"
			 WHERE table_key = ? AND row_id = ?`,
			[table, rowId],
		)[0];
		if (confirmed) parts.push(toBytes(confirmed.yjs_state));
		const sealed = sqlite.all<{ document_update: Uint8Array | null }>(
			`SELECT document_update FROM "${INTENTS_TABLE}"
			 WHERE table_key = ? AND row_id = ? AND sealed = 1`,
			[table, rowId],
		)[0];
		if (sealed?.document_update) {
			parts.push(toBytes(sealed.document_update));
		}
		return parts;
	}

	/**
	 * Seal a deterministic bounded subset of open intents under the next round
	 * number (ADR-0131). At most one round is unresolved; it leaves disk only
	 * when its exchange completes or a definitive capacity refusal resolves
	 * it. While capacity-blocked, only delete intents seal.
	 */
	function sealRound(): void {
		sqlite.transaction(() => {
			const replica = requireReplica();
			if (replica.in_flight_round !== null) return;
			const openIntents = readStoredIntents(0).filter(
				(stored) => !capacityBlocked || stored.kind === 'delete',
			);
			if (openIntents.length === 0) return;
			let taken = openIntents.slice(0, roundLimit);
			let wire = taken.map(toWire);
			while (
				wire.length > 1 &&
				encodedRoundBytes(tokenOf(replica), wire, pageLimit) >
					ROW_SYNC_ADMISSION_LIMITS.encodedRoundBytes
			) {
				taken = taken.slice(0, -1);
				wire = wire.slice(0, -1);
			}
			if (
				wire.length === 1 &&
				encodedRoundBytes(tokenOf(replica), wire, pageLimit) >
					ROW_SYNC_ADMISSION_LIMITS.encodedRoundBytes
			) {
				throw new Error('One open intent exceeds the sealed round bound');
			}
			for (const stored of taken) {
				sqlite.run(
					`UPDATE "${INTENTS_TABLE}" SET sealed = 1
					 WHERE table_key = ? AND row_id = ? AND sealed = 0`,
					[stored.table_key, stored.row_id],
				);
			}
			sqlite.run(
				`UPDATE "${REPLICA_TABLE}" SET
					in_flight_round = ?, in_flight_request_digest = ?
				 WHERE id = 1`,
				[replica.accepted_round + 1, rowRoundDigest(wire)],
			);
		});
		greatestIssuedSubmission = 0;
	}

	/**
	 * Resolve a definitively refused sealed round (ADR-0131): in one local
	 * transaction, clear the in-flight metadata, return the refused intents
	 * to open state under ordinary compaction, and reseal any delete intents
	 * as the same round number with a new digest. Local edits are never
	 * discarded.
	 */
	function resolveCapacityRefusal(): void {
		sqlite.transaction(() => {
			const replica = requireReplica();
			if (replica.in_flight_round === null) return;
			const sealedIntents = readStoredIntents(1);
			sqlite.run(`DELETE FROM "${INTENTS_TABLE}" WHERE sealed = 1`);
			sqlite.run(
				`UPDATE "${REPLICA_TABLE}" SET
					in_flight_round = NULL, in_flight_request_digest = NULL
				 WHERE id = 1`,
			);
			// Reopen under ordinary compaction: the refused intent is older
			// than any open intent authored while the round was unresolved.
			for (const stored of sealedIntents) {
				const refused = toWire(stored);
				const newerOpen = sqlite.all<StoredIntent>(
					`SELECT table_key, row_id, sealed, kind, fields_json, document_update
					 FROM "${INTENTS_TABLE}"
					 WHERE table_key = ? AND row_id = ? AND sealed = 0`,
					[stored.table_key, stored.row_id],
				)[0];
				if (!newerOpen) {
					writeStoredIntent(refused, 0);
					continue;
				}
				const newer = toWire(newerOpen);
				sqlite.run(
					`DELETE FROM "${INTENTS_TABLE}"
					 WHERE table_key = ? AND row_id = ? AND sealed = 0`,
					[stored.table_key, stored.row_id],
				);
				writeStoredIntent(refused, 0);
				compactIntoOpen(newer);
			}
			// Reseal deletions first, reusing the still-unaccepted round
			// number; the submission watermark makes the reuse safe.
			const deletions = readStoredIntents(0).filter(
				(stored) => stored.kind === 'delete',
			);
			if (deletions.length === 0) return;
			const taken = deletions.slice(0, roundLimit);
			for (const stored of taken) {
				sqlite.run(
					`UPDATE "${INTENTS_TABLE}" SET sealed = 1
					 WHERE table_key = ? AND row_id = ? AND sealed = 0`,
					[stored.table_key, stored.row_id],
				);
			}
			sqlite.run(
				`UPDATE "${REPLICA_TABLE}" SET
					in_flight_round = ?, in_flight_request_digest = ?
				 WHERE id = 1`,
				[replica.accepted_round + 1, rowRoundDigest(taken.map(toWire))],
			);
		});
		greatestIssuedSubmission = 0;
	}

	async function ensureEnrolled(): Promise<void> {
		if (readReplica()) return;
		const response = parseEnrollResponse(
			await transport.enroll({
				protocolMajor: ROW_SYNC_PROTOCOL_MAJOR,
				kind: 'enroll',
			}),
		);
		if (response.result !== 'enrolled') {
			throw new Error(`Replica enrollment refused: ${response.result}`);
		}
		sqlite.run(
			`INSERT INTO "${REPLICA_TABLE}"(
				id, replica_id, accepted_round, checkpoint,
				in_flight_round, in_flight_request_digest
			) VALUES (1, ?, 0, 0, NULL, NULL)
			ON CONFLICT(id) DO NOTHING`,
			[response.replicaId],
		);
	}

	async function runSynchronization(): Promise<CanonicalReplicaStatus> {
		await ensureEnrolled();
		// Each pass retries growth once; a definitive refusal re-blocks it.
		capacityBlocked = false;
		synchronization: while (true) {
			sealRound();
			const replica = requireReplica();
			const token = tokenOf(replica);
			const sealedIntents =
				replica.in_flight_round === null ? undefined : readStoredIntents(1);
			let request: SyncRequest;
			if (sealedIntents && replica.in_flight_round !== null) {
				const wire = sealedIntents.map(toWire);
				const digest = rowRoundDigest(wire);
				if (digest !== replica.in_flight_request_digest) {
					throw new Error('Sealed round no longer matches its stored digest');
				}
				const submission = nextSubmission;
				nextSubmission += 1;
				greatestIssuedSubmission = submission;
				request = {
					protocolMajor: ROW_SYNC_PROTOCOL_MAJOR,
					kind: 'sync',
					token,
					sealedRound: {
						round: replica.in_flight_round,
						requestDigest: digest,
						submission,
						intents: wire,
					},
					...(pageLimit === ROW_SYNC_ADMISSION_LIMITS.outcomesPerPage
						? {}
						: { pageLimit }),
				};
			} else {
				request = {
					protocolMajor: ROW_SYNC_PROTOCOL_MAJOR,
					kind: 'sync',
					token,
					...(pageLimit === ROW_SYNC_ADMISSION_LIMITS.outcomesPerPage
						? {}
						: { pageLimit }),
				};
			}
			const sentRound = request.sealedRound?.round;
			const response = parseSyncResponse(await transport.sync(request));
			switch (response.result) {
				case 'stale-submission': {
					// Inert transmission: jump past the watermark and retry.
					nextSubmission = Math.max(nextSubmission, response.watermark + 1);
					continue;
				}
				case 'capacity-refused': {
					// Authoritative only when it answers the greatest issued
					// submission; an older refusal is superseded and ignored.
					if (response.submission !== greatestIssuedSubmission) continue;
					capacityBlocked = true;
					resolveCapacityRefusal();
					// Deletions reseal under the same round number; with none to
					// reseal, growth stays queued for a later pass.
					if (requireReplica().in_flight_round === null) {
						break synchronization;
					}
					continue;
				}
				case 'baseline-required':
					throw new Error(
						'Baseline acquisition is required but not yet implemented',
					);
				case 'protocol-mismatch':
				case 'unknown-replica':
				case 'replica-fork':
					throw new Error(`Row sync stopped: ${response.result}`);
				case 'page': {
					// The authority's acceptedRound must account exactly for what
					// this exchange submitted: a response that silently advances
					// (or ignores) a round is corrupt and must not retire intent.
					const expectedAcceptedRound = sentRound ?? token.acceptedRound;
					if (response.token.acceptedRound !== expectedAcceptedRound) {
						throw new Error('Sync page does not continue the local checkpoint');
					}
					const installed = installPage(token, response);
					if (installed && response.outcomes.length > 0) onRemoteCommit();
					if (!response.hasMore && requireReplica().in_flight_round === null) {
						// Growth intents held back by a definitive capacity refusal
						// stay queued for a later pass; nothing discards local edits.
						if (openIntentCount() === 0 || capacityBlocked) {
							break synchronization;
						}
					}
					continue;
				}
				default:
					response satisfies never;
					throw new Error('Unreachable sync response state');
			}
		}
		return status();
	}

	function installPage(
		expected: SyncToken,
		response: Extract<SyncResponse, { result: 'page' }>,
	): boolean {
		if (
			response.token.replicaId !== expected.replicaId ||
			response.token.checkpoint < expected.checkpoint ||
			response.token.acceptedRound < expected.acceptedRound ||
			(response.hasMore &&
				(response.outcomes.length === 0 ||
					response.token.checkpoint !== response.outcomes.at(-1)?.sequence)) ||
			!hasMonotoneOutcomes(
				response.outcomes,
				expected.checkpoint,
				response.token.checkpoint,
			)
		) {
			throw new Error('Sync page does not continue the local checkpoint');
		}
		const installation = sqlite.transaction(() => {
			const replica = requireReplica();
			if (replica.checkpoint > expected.checkpoint) {
				return { installed: false, deleted: [] } as const;
			}
			if (replica.checkpoint !== expected.checkpoint) {
				throw new Error('Sync checkpoint changed before installation');
			}
			const deleted: { table: string; rowId: string }[] = [];
			for (const outcome of response.outcomes) {
				installOutcome(outcome);
				if (outcome.kind === 'deletion') {
					deleted.push({ table: outcome.table, rowId: outcome.rowId });
				}
			}
			sqlite.run(
				`UPDATE "${REPLICA_TABLE}" SET accepted_round = ?, checkpoint = ?
				 WHERE id = 1`,
				[response.token.acceptedRound, response.token.checkpoint],
			);
			// The exchange completes when the round is accepted and the page
			// stream has reached head; only then do sealed intents retire.
			if (
				replica.in_flight_round !== null &&
				response.token.acceptedRound >= replica.in_flight_round &&
				!response.hasMore
			) {
				sqlite.run(`DELETE FROM "${INTENTS_TABLE}" WHERE sealed = 1`);
				sqlite.run(
					`UPDATE "${REPLICA_TABLE}" SET
						in_flight_round = NULL, in_flight_request_digest = NULL
					 WHERE id = 1`,
				);
			}
			return { installed: true, deleted } as const;
		});
		if (installation.deleted.length > 0) {
			onRowsDeleted([...installation.deleted]);
		}
		return installation.installed;
	}

	function installOutcome(outcome: RowOutcome): void {
		switch (outcome.kind) {
			case 'row': {
				if (outcome.fields !== undefined) {
					sqlite.run(
						`INSERT INTO "${ROWS_TABLE}"(table_key, row_id, fields_json)
						 VALUES (?, ?, ?)
						 ON CONFLICT(table_key, row_id) DO UPDATE SET
							fields_json = excluded.fields_json`,
						[outcome.table, outcome.rowId, JSON.stringify(outcome.fields)],
					);
				}
				if (outcome.documentUpdate !== undefined) {
					const incoming = base64ToBytes(outcome.documentUpdate);
					const existing = sqlite.all<{ yjs_state: Uint8Array }>(
						`SELECT yjs_state FROM "${DOCUMENTS_TABLE}"
						 WHERE table_key = ? AND row_id = ?`,
						[outcome.table, outcome.rowId],
					)[0];
					const merged = codec.mergeUpdates(
						existing ? [toBytes(existing.yjs_state), incoming] : [incoming],
					);
					sqlite.run(
						`INSERT INTO "${DOCUMENTS_TABLE}"(table_key, row_id, yjs_state)
						 VALUES (?, ?, ?)
						 ON CONFLICT(table_key, row_id) DO UPDATE SET
							yjs_state = excluded.yjs_state`,
						[outcome.table, outcome.rowId, merged],
					);
				}
				return;
			}
			case 'deletion': {
				sqlite.run(
					`DELETE FROM "${ROWS_TABLE}" WHERE table_key = ? AND row_id = ?`,
					[outcome.table, outcome.rowId],
				);
				sqlite.run(
					`DELETE FROM "${DOCUMENTS_TABLE}" WHERE table_key = ? AND row_id = ?`,
					[outcome.table, outcome.rowId],
				);
				// Sealed intents are an immutable retry image and open intents
				// remain durable desired state (ADR-0134); the authority's
				// ordinary deterministic no-op fold resolves both.
				return;
			}
		}
	}

	function openIntentCount(): number {
		return (
			sqlite.all<{ count: number }>(
				`SELECT COUNT(*) AS count FROM "${INTENTS_TABLE}" WHERE sealed = 0`,
			)[0]?.count ?? 0
		);
	}

	function sealedIntentCount(): number {
		return (
			sqlite.all<{ count: number }>(
				`SELECT COUNT(*) AS count FROM "${INTENTS_TABLE}" WHERE sealed = 1`,
			)[0]?.count ?? 0
		);
	}

	function status(): CanonicalReplicaStatus {
		const replica = readReplica();
		return {
			checkpoint: replica?.checkpoint ?? 0,
			pendingIntents: openIntentCount() + sealedIntentCount(),
			hasInflightRound: replica?.in_flight_round != null,
			capacityBlocked,
		};
	}

	function prepareLocalIntent(intent: WireRowIntent): WireRowIntent {
		if (intent.kind === 'delete' || intent.documentUpdate === undefined) {
			return parseRowIntent(intent);
		}
		const documentUpdate = intent.documentUpdate;
		const validated = parseRowIntent({ ...intent, documentUpdate: 'AA==' });
		if (validated.kind === 'delete') {
			throw new TypeError('Document updates cannot delete rows');
		}
		if (validated.kind === 'create') {
			return { ...validated, documentUpdate };
		}
		return {
			kind: 'update',
			table: validated.table,
			rowId: validated.rowId,
			...(validated.fields === undefined ? {} : { fields: validated.fields }),
			documentUpdate,
		};
	}

	return {
		/**
		 * Admit one locally authored intent: validate it, then compact it into
		 * the open intent for its address (ADR-0134). The caller's projection
		 * derives current state from confirmed rows plus sealed plus open.
		 */
		admit(intent: WireRowIntent): void {
			const admitted = prepareLocalIntent(intent);
			sqlite.transaction(() => {
				// The seal is immutable, but admission validity may consult it:
				// a sealed local delete ends the row lifetime for this replica.
				const sealed = sqlite.all<StoredIntent>(
					`SELECT table_key, row_id, sealed, kind, fields_json, document_update
					 FROM "${INTENTS_TABLE}"
					 WHERE table_key = ? AND row_id = ? AND sealed = 1`,
					[admitted.table, admitted.rowId],
				)[0];
				if (sealed?.kind === 'delete') {
					throw new Error('A locally deleted row accepts no further intent');
				}
				if (admitted.kind === 'create' && sealed) {
					throw new Error('A live open intent already exists for this address');
				}
				compactIntoOpen(admitted);
			});
			rerunRequested = true;
		},
		/**
		 * Project one current row: confirmed fields folded through the sealed
		 * intent, then the open intent (ADR-0134). Rebuildable, never stored.
		 */
		readCurrentRow(table: string, rowId: string): JsonObject | undefined {
			return readCurrentRow(sqlite, table, rowId);
		},
		listCurrentRows(table: string): { rowId: string; fields: JsonObject }[] {
			return listCurrentRows(sqlite, table);
		},
		/**
		 * The ordered document composite for one row: confirmed merged state,
		 * then the sealed and open document components (ADR-0134).
		 */
		readCurrentDocumentParts(table: string, rowId: string): Uint8Array[] {
			return readCurrentDocumentParts(sqlite, table, rowId);
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

/**
 * Compose two ordered field-change sets into their final absolute form: the
 * newer set wins key-wise, a newer set removes an older unset, and a newer
 * unset removes an older set.
 */
function composeFieldChanges(
	older: { set: JsonObject; unset: string[] } | undefined,
	newer: { set: JsonObject; unset: string[] } | undefined,
): { set: JsonObject; unset: string[] } | undefined {
	if (older === undefined) return newer;
	if (newer === undefined) return older;
	const set = Object.create(null) as JsonObject;
	for (const [key, value] of Object.entries(older.set)) {
		if (!newer.unset.includes(key) && !Object.hasOwn(newer.set, key)) {
			Object.defineProperty(set, key, {
				configurable: true,
				enumerable: true,
				value,
				writable: true,
			});
		}
	}
	for (const [key, value] of Object.entries(newer.set)) {
		Object.defineProperty(set, key, {
			configurable: true,
			enumerable: true,
			value,
			writable: true,
		});
	}
	const unset = [
		...older.unset.filter((key) => !Object.hasOwn(set, key)),
		...newer.unset.filter((key) => !older.unset.includes(key)),
	];
	return { set, unset };
}

/**
 * Fold one pending intent over a projected row (the ADR-0131 mirror rule).
 * A no-op keeps the current value: authority folding will reach the same
 * deterministic result.
 */
function projectIntent(
	current: JsonObject | undefined,
	intent: WireRowIntent,
): JsonObject | undefined {
	if (intent.kind === 'delete') return undefined;
	const folded = foldFields(current, intent);
	switch (folded.kind) {
		case 'fields':
			return folded.fields;
		case 'deletion':
			return undefined;
		case 'noop':
			return current;
	}
}

function storedIntentToWire(stored: StoredIntent): WireRowIntent {
	const documentUpdate = stored.document_update
		? bytesToBase64(toBytes(stored.document_update))
		: undefined;
	if (stored.kind === 'delete') {
		return { kind: 'delete', table: stored.table_key, rowId: stored.row_id };
	}
	if (stored.kind === 'create') {
		return {
			kind: 'create',
			table: stored.table_key,
			rowId: stored.row_id,
			fields: JSON.parse(stored.fields_json ?? '{}'),
			...(documentUpdate === undefined ? {} : { documentUpdate }),
		};
	}
	return {
		kind: 'update',
		table: stored.table_key,
		rowId: stored.row_id,
		...(stored.fields_json === null
			? {}
			: { fields: JSON.parse(stored.fields_json) }),
		...(documentUpdate === undefined ? {} : { documentUpdate }),
	};
}

/** Project one current row from confirmed state plus sealed and open intent. */
export function readCurrentRow(
	sqlite: RowSyncSqlite,
	table: string,
	rowId: string,
): JsonObject | undefined {
	const confirmed = sqlite.all<{ fields_json: string }>(
		`SELECT fields_json FROM "${ROWS_TABLE}"
		 WHERE table_key = ? AND row_id = ?`,
		[table, rowId],
	)[0];
	let current: JsonObject | undefined = confirmed
		? JSON.parse(confirmed.fields_json)
		: undefined;
	const intents = sqlite.all<StoredIntent>(
		`SELECT table_key, row_id, sealed, kind, fields_json, document_update
		 FROM "${INTENTS_TABLE}"
		 WHERE table_key = ? AND row_id = ?
		 ORDER BY sealed DESC`,
		[table, rowId],
	);
	for (const stored of intents) {
		current = projectIntent(current, storedIntentToWire(stored));
	}
	return current;
}

/** Project every current row of one table in stable row-id order. */
export function listCurrentRows(
	sqlite: RowSyncSqlite,
	table: string,
): { rowId: string; fields: JsonObject }[] {
	const projected = new Map<string, JsonObject | undefined>();
	for (const confirmed of sqlite.all<{ row_id: string; fields_json: string }>(
		`SELECT row_id, fields_json FROM "${ROWS_TABLE}"
		 WHERE table_key = ? ORDER BY row_id`,
		[table],
	)) {
		projected.set(confirmed.row_id, JSON.parse(confirmed.fields_json));
	}
	for (const stored of sqlite.all<StoredIntent>(
		`SELECT table_key, row_id, sealed, kind, fields_json, document_update
		 FROM "${INTENTS_TABLE}"
		 WHERE table_key = ?
		 ORDER BY row_id, sealed DESC`,
		[table],
	)) {
		projected.set(
			stored.row_id,
			projectIntent(projected.get(stored.row_id), storedIntentToWire(stored)),
		);
	}
	return [...projected.entries()]
		.filter((entry): entry is [string, JsonObject] => entry[1] !== undefined)
		.map(([rowId, fields]) => ({ rowId, fields }))
		.sort((a, b) => (a.rowId < b.rowId ? -1 : a.rowId > b.rowId ? 1 : 0));
}

/**
 * The ordered document composite for one row: confirmed merged state, then
 * the sealed and open document components (ADR-0134). Yjs application is
 * idempotent and ordered application converges.
 */
export function readCurrentDocumentParts(
	sqlite: RowSyncSqlite,
	table: string,
	rowId: string,
): Uint8Array[] {
	const parts: Uint8Array[] = [];
	const confirmed = sqlite.all<{ yjs_state: Uint8Array }>(
		`SELECT yjs_state FROM "${DOCUMENTS_TABLE}"
		 WHERE table_key = ? AND row_id = ?`,
		[table, rowId],
	)[0];
	if (confirmed) parts.push(toBytes(confirmed.yjs_state));
	for (const stored of sqlite.all<{ document_update: Uint8Array | null }>(
		`SELECT document_update FROM "${INTENTS_TABLE}"
		 WHERE table_key = ? AND row_id = ? AND document_update IS NOT NULL
		 ORDER BY sealed DESC`,
		[table, rowId],
	)) {
		if (stored.document_update) parts.push(toBytes(stored.document_update));
	}
	return parts;
}

function tokenOf(replica: StoredReplica): SyncToken {
	return {
		replicaId: replica.replica_id,
		acceptedRound: replica.accepted_round,
		checkpoint: replica.checkpoint,
	};
}

function encodedRoundBytes(
	token: SyncToken,
	intents: WireRowIntent[],
	pageLimit: number,
): number {
	const request: SyncRequest = {
		protocolMajor: ROW_SYNC_PROTOCOL_MAJOR,
		kind: 'sync',
		token,
		sealedRound: {
			round: token.acceptedRound + 1,
			requestDigest: '0'.repeat(64),
			submission: Number.MAX_SAFE_INTEGER,
			intents,
		},
		...(pageLimit === ROW_SYNC_ADMISSION_LIMITS.outcomesPerPage
			? {}
			: { pageLimit }),
	};
	return new TextEncoder().encode(JSON.stringify(request)).byteLength;
}

function hasMonotoneOutcomes(
	outcomes: readonly RowOutcome[],
	fromCheckpoint: number,
	newCheckpoint: number,
): boolean {
	let previousSequence = fromCheckpoint;
	for (const outcome of outcomes) {
		if (
			outcome.sequence <= previousSequence ||
			outcome.sequence > newCheckpoint
		) {
			return false;
		}
		previousSequence = outcome.sequence;
	}
	return true;
}

/**
 * Create the four canonical tables (ADR-0134) behind `PRAGMA user_version`.
 * Local-only and synchronized files use the same physical schema: in
 * local-only mode `intents` stays empty and the `replica` singleton is
 * absent.
 */
export function initializeCanonicalSchema(sqlite: RowSyncSqlite): void {
	sqlite.transaction(() => {
		const legacy = sqlite.all<{ name: string }>(
			`SELECT name FROM sqlite_master
			 WHERE type = 'table' AND name IN (
				'__epicenter_records', '__epicenter_replica_meta'
			 )`,
		);
		if (legacy.length > 0) {
			throw new Error('Incompatible canonical replica storage');
		}
		const version =
			sqlite.all<{ user_version: number }>('PRAGMA user_version')[0]
				?.user_version ?? 0;
		if (version === 0) {
			sqlite.run(`
				CREATE TABLE IF NOT EXISTS "${ROWS_TABLE}" (
					table_key   TEXT NOT NULL,
					row_id      TEXT NOT NULL,
					fields_json TEXT NOT NULL CHECK (json_valid(fields_json)),
					PRIMARY KEY (table_key, row_id)
				) WITHOUT ROWID, STRICT;
				CREATE TABLE IF NOT EXISTS "${DOCUMENTS_TABLE}" (
					table_key TEXT NOT NULL,
					row_id    TEXT NOT NULL,
					yjs_state BLOB NOT NULL,
					PRIMARY KEY (table_key, row_id)
				) WITHOUT ROWID, STRICT;
				CREATE TABLE IF NOT EXISTS "${INTENTS_TABLE}" (
					table_key       TEXT NOT NULL,
					row_id          TEXT NOT NULL,
					sealed          INTEGER NOT NULL CHECK (sealed IN (0, 1)),
					kind            TEXT NOT NULL CHECK (kind IN ('create', 'update', 'delete')),
					fields_json     TEXT CHECK (fields_json IS NULL OR json_valid(fields_json)),
					document_update BLOB,
					PRIMARY KEY (table_key, row_id, sealed),
					CHECK (kind != 'delete' OR (fields_json IS NULL AND document_update IS NULL)),
					CHECK (kind != 'create' OR fields_json IS NOT NULL),
					CHECK (kind != 'update' OR fields_json IS NOT NULL OR document_update IS NOT NULL)
				) WITHOUT ROWID, STRICT;
				CREATE TABLE IF NOT EXISTS "${REPLICA_TABLE}" (
					id                        INTEGER PRIMARY KEY CHECK (id = 1),
					replica_id                TEXT NOT NULL,
					accepted_round            INTEGER NOT NULL,
					checkpoint                INTEGER NOT NULL,
					in_flight_round           INTEGER,
					in_flight_request_digest  TEXT,
					CHECK ((in_flight_round IS NULL) =
					       (in_flight_request_digest IS NULL))
				) STRICT;
			`);
			sqlite.run(`PRAGMA user_version = ${USER_VERSION}`);
			return;
		}
		if (version !== USER_VERSION) {
			throw new Error('Incompatible canonical replica storage');
		}
	});
}

function assertLimit(value: number, maximum: number, label: string): void {
	if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
		throw new TypeError(
			`${label} limit must be an integer from 1 through ${maximum}`,
		);
	}
}

function toBytes(value: Uint8Array | ArrayBuffer): Uint8Array {
	return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function base64ToBytes(value: string): Uint8Array {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}
