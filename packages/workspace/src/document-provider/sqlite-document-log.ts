import { sha256HexBytes } from '@epicenter/row-sync';
import {
	type SqliteDatabase,
	StorageUpgradeRequiredError,
} from '@epicenter/sqlite';
import * as Y from '@y/y';
import { assertRowAddress, type RowAddress } from './persistence.js';

const LOG_TABLE = 'workspace_document_updates';
const LOG_INDEX = 'workspace_document_updates_address';
const PUBLICATION_TABLE = 'workspace_document_publication';
export const SQLITE_DOCUMENT_LOG_SCHEMA_OBJECTS = [
	{ type: 'table', name: LOG_TABLE },
	{ type: 'index', name: LOG_INDEX },
	{ type: 'table', name: PUBLICATION_TABLE },
] as const;
const DEFAULT_COMPACTION_THRESHOLD = 64;

const CREATE_LOG_TABLE = `CREATE TABLE ${LOG_TABLE} (
	sequence INTEGER PRIMARY KEY AUTOINCREMENT,
	table_name TEXT NOT NULL,
	row_id TEXT NOT NULL,
	update_bytes BLOB NOT NULL
)`;

const CREATE_LOG_INDEX = `CREATE INDEX ${LOG_INDEX}
	ON ${LOG_TABLE}(table_name, row_id, sequence)`;

// The durable authority obligation for one row document (ADR-0171/0174):
// `revision` advances with every locally authored append in the same
// transaction; `accepted_revision` advances only on an exact publication
// receipt; the optional inflight columns freeze one immutable retry image.
// `parked_revision` records a bound refusal so one failing address does not
// spin; a later local edit advances `revision` past it and re-arms the drain.
const CREATE_PUBLICATION_TABLE = `CREATE TABLE ${PUBLICATION_TABLE} (
	table_name TEXT NOT NULL,
	row_id TEXT NOT NULL,
	revision INTEGER NOT NULL CHECK(revision > 0),
	accepted_revision INTEGER NOT NULL
		CHECK(accepted_revision >= 0 AND accepted_revision <= revision),
	parked_revision INTEGER
		CHECK(parked_revision IS NULL OR parked_revision <= revision),
	inflight_revision INTEGER
		CHECK(inflight_revision IS NULL OR inflight_revision <= revision),
	inflight_digest TEXT,
	inflight_update BLOB,
	PRIMARY KEY(table_name, row_id),
	CHECK((inflight_revision IS NULL) = (inflight_digest IS NULL)),
	CHECK((inflight_revision IS NULL) = (inflight_update IS NULL))
) WITHOUT ROWID, STRICT`;

function normalizeSql(sql: string | null): string {
	return (sql ?? '').replaceAll(/\s+/g, ' ').trim();
}

/** Read-only classification of the document-log-owned SQLite objects. */
export function inspectSqliteDocumentLogSchema(
	database: SqliteDatabase,
): 'empty' | 'current' {
	const objects = database.all<{ name: string; sql: string | null }>(
		`SELECT name, sql FROM sqlite_schema
		 WHERE tbl_name IN (?, ?) OR name = ?
		 ORDER BY name`,
		[LOG_TABLE, PUBLICATION_TABLE, LOG_INDEX],
	);
	if (objects.length === 0) return 'empty';

	const expected = new Map([
		[LOG_TABLE, normalizeSql(CREATE_LOG_TABLE)],
		[LOG_INDEX, normalizeSql(CREATE_LOG_INDEX)],
		[PUBLICATION_TABLE, normalizeSql(CREATE_PUBLICATION_TABLE)],
	]);
	if (
		objects.length !== expected.size ||
		objects.some(({ name, sql }) => expected.get(name) !== normalizeSql(sql))
	) {
		throw new StorageUpgradeRequiredError(
			'SQLite document log',
			'document update table or index does not match the current format',
		);
	}
	return 'current';
}

/** Create the document log only after a read-only classification accepts it. */
export function initializeSqliteDocumentLogSchema(
	database: SqliteDatabase,
): void {
	if (inspectSqliteDocumentLogSchema(database) === 'current') return;
	database.transaction(() => {
		database.run(CREATE_LOG_TABLE);
		database.run(CREATE_LOG_INDEX);
		database.run(CREATE_PUBLICATION_TABLE);
	});
}

/**
 * Error name stamped on an append refused because its row is no longer live.
 * The refusal is address-scoped: it fails that document's durability tail
 * without poisoning the log, and the name survives Worker and HTTP carriers.
 */
export const DOCUMENT_ROW_ABSENT_ERROR_NAME = 'DocumentRowAbsentError';

/** True when an error means one append lost its race with row deletion. */
export function isDocumentRowAbsentError(cause: unknown): boolean {
	return (
		cause instanceof Error && cause.name === DOCUMENT_ROW_ABSENT_ERROR_NAME
	);
}

type StoredUpdate = {
	sequence: number;
	update: Uint8Array | ArrayBuffer;
};

/**
 * Who authored one appended update. `local` work advances the durable
 * publication revision in the append transaction; `accepted` bytes already
 * carry authority proof and leave no new obligation (ADR-0174).
 */
export type DocumentUpdateSource = 'local' | 'accepted';

/** One immutable frozen publication attempt (ADR-0171 retry image). */
export type DocumentPublicationImage = {
	update: Uint8Array;
	digest: string;
	revision: number;
};

export type DocumentPublicationStatus = {
	revision: number;
	acceptedRevision: number;
	parkedRevision: number | undefined;
	inflightDigest: string | undefined;
};

type StoredPublication = {
	revision: number;
	accepted_revision: number;
	parked_revision: number | null;
	inflight_revision: number | null;
	inflight_digest: string | null;
	inflight_update: Uint8Array | ArrayBuffer | null;
};

function asError(cause: unknown, fallback: string): Error {
	return cause instanceof Error ? cause : new Error(fallback, { cause });
}

function updateBytes(value: Uint8Array | ArrayBuffer): Uint8Array {
	return value instanceof Uint8Array
		? new Uint8Array(value)
		: new Uint8Array(value.slice(0));
}

/**
 * Own one workspace's durable Yjs 14 update log inside its SQLite store.
 *
 * This is the owner side of row-document persistence: it runs where the
 * workspace's SQLite file lives (records Worker, Bun host, or in-process
 * runtime) and owns schema, append admission, liveness enforcement,
 * compaction, capture, and durable deletion. Live `Y.Doc` objects never live
 * here; renderer-facing code reaches this log through an asynchronous
 * load/append seam.
 */
export function createSqliteDocumentLog({
	database,
	isRowLive,
	compactionThreshold = DEFAULT_COMPACTION_THRESHOLD,
}: {
	database: SqliteDatabase;
	/**
	 * Row liveness read inside every append transaction. Returning false
	 * refuses the append with the named address-scoped absence error, so a
	 * late append can never resurrect a deleted row's durable content.
	 */
	isRowLive(address: RowAddress): boolean;
	compactionThreshold?: number;
}) {
	if (!Number.isSafeInteger(compactionThreshold) || compactionThreshold < 2) {
		throw new TypeError('Document compaction threshold must be at least two');
	}

	initializeSqliteDocumentLogSchema(database);

	let failure: Error | undefined;

	function requireHealthy(): void {
		if (failure !== undefined) throw failure;
	}

	function poison(cause: unknown): Error {
		failure ??= asError(cause, 'Workspace document log failed');
		return failure;
	}

	function readUpdates(address: RowAddress): StoredUpdate[] {
		return database.all<StoredUpdate>(
			`SELECT sequence, update_bytes AS "update"
			 FROM ${LOG_TABLE}
			 WHERE table_name = ? AND row_id = ?
			 ORDER BY sequence`,
			[address.table, address.rowId],
		);
	}

	function readPublication(address: RowAddress): StoredPublication | undefined {
		return database.all<StoredPublication>(
			`SELECT revision, accepted_revision, parked_revision,
			        inflight_revision, inflight_digest, inflight_update
			 FROM ${PUBLICATION_TABLE}
			 WHERE table_name = ? AND row_id = ?`,
			[address.table, address.rowId],
		)[0];
	}

	/** Replay stored updates into one fresh gc-enabled document. */
	function replay(updates: readonly StoredUpdate[]): Y.Doc {
		const document = new Y.Doc({ gc: true });
		try {
			for (const stored of updates) {
				Y.applyUpdateV2(document, updateBytes(stored.update));
			}
			return document;
		} catch (cause) {
			document.destroy();
			throw cause;
		}
	}

	return {
		/** Read one document's ordered durable updates for hydration. */
		load(address: RowAddress): Uint8Array[] {
			requireHealthy();
			assertRowAddress(address);
			try {
				return readUpdates(address).map((stored) => updateBytes(stored.update));
			} catch (cause) {
				throw poison(cause);
			}
		},
		/**
		 * Append one observed updateV2 and compact at the bounded threshold.
		 * Liveness, insertion, publication-revision advance, and compaction
		 * share one transaction: a row deleted concurrently refuses the append
		 * explicitly instead of committing durable state for a dead address,
		 * and a crash can never separate durable local work from its
		 * publication obligation.
		 */
		append(
			address: RowAddress,
			update: Uint8Array,
			source: DocumentUpdateSource = 'local',
		): void {
			requireHealthy();
			assertRowAddress(address);
			try {
				database.transaction(() => {
					if (!isRowLive({ table: address.table, rowId: address.rowId })) {
						const absent = new Error(
							`Cannot append document update for absent row '${address.table}.${address.rowId}'`,
						);
						absent.name = DOCUMENT_ROW_ABSENT_ERROR_NAME;
						throw absent;
					}
					database.run(
						`INSERT INTO ${LOG_TABLE}(table_name, row_id, update_bytes)
						 VALUES (?, ?, ?)`,
						[address.table, address.rowId, update],
					);
					if (source === 'local') {
						database.run(
							`INSERT INTO ${PUBLICATION_TABLE}(
								table_name, row_id, revision, accepted_revision
							) VALUES (?, ?, 1, 0)
							ON CONFLICT(table_name, row_id) DO UPDATE SET
								revision = revision + 1`,
							[address.table, address.rowId],
						);
					}
					const covered = readUpdates(address);
					if (covered.length < compactionThreshold) return;

					// Compact through a fresh gc-enabled document: merging update
					// blocks alone never garbage-collects, so only full replay plus
					// re-encoding shrinks replaced content back to a compact state.
					const lastCovered = covered.at(-1);
					if (lastCovered === undefined) {
						throw new Error('Document compaction read an empty covered set');
					}
					const compacted = replay(covered);
					try {
						const baseline = new Uint8Array(Y.encodeStateAsUpdateV2(compacted));
						database.run(
							`DELETE FROM ${LOG_TABLE}
							 WHERE table_name = ? AND row_id = ? AND sequence <= ?`,
							[address.table, address.rowId, lastCovered.sequence],
						);
						database.run(
							`INSERT INTO ${LOG_TABLE}(table_name, row_id, update_bytes)
							 VALUES (?, ?, ?)`,
							[address.table, address.rowId, baseline],
						);
					} finally {
						compacted.destroy();
					}
				});
			} catch (cause) {
				if (isDocumentRowAbsentError(cause)) throw cause;
				throw poison(cause);
			}
		},
		/**
		 * Capture one row's compact document state, or undefined when the log
		 * holds nothing for its address. Callers own the durability barrier:
		 * capture reads whatever has committed when it runs.
		 */
		capture(address: RowAddress): Uint8Array | undefined {
			requireHealthy();
			assertRowAddress(address);
			try {
				const updates = readUpdates(address);
				if (updates.length === 0) return undefined;
				const captured = replay(updates);
				try {
					return new Uint8Array(Y.encodeStateAsUpdateV2(captured));
				} finally {
					captured.destroy();
				}
			} catch (cause) {
				throw poison(cause);
			}
		},
		/**
		 * Delete the durable update logs and publication obligations of rows
		 * whose scalar life ended. Runs bare statements: the caller invokes
		 * this inside the same transaction that removes the row, so scalar
		 * death, document death, and obligation death commit together.
		 */
		deleteRows(addresses: readonly RowAddress[]): void {
			requireHealthy();
			try {
				for (const address of addresses) {
					assertRowAddress(address);
					database.run(
						`DELETE FROM ${LOG_TABLE}
						 WHERE table_name = ? AND row_id = ?`,
						[address.table, address.rowId],
					);
					database.run(
						`DELETE FROM ${PUBLICATION_TABLE}
						 WHERE table_name = ? AND row_id = ?`,
						[address.table, address.rowId],
					);
				}
			} catch (cause) {
				throw poison(cause);
			}
		},
		/**
		 * Delete every durable update log and publication obligation. Runs bare
		 * statements inside the caller's workspace-reset or workspace-delete
		 * transaction.
		 */
		deleteAllRows(): void {
			requireHealthy();
			try {
				database.run(`DELETE FROM ${LOG_TABLE}`);
				database.run(`DELETE FROM ${PUBLICATION_TABLE}`);
			} catch (cause) {
				throw poison(cause);
			}
		},
		/**
		 * The durable authority-publication obligation for row documents
		 * (ADR-0171). Owned here because obligation state must commit in the
		 * same SQLite transactions as the update chain it describes; the
		 * runtime-owned drain reads and settles it through these operations
		 * and never through an open document handle.
		 */
		publication: {
			/** Addresses owing publication, oldest-address order, parked excluded. */
			listDirty(): RowAddress[] {
				requireHealthy();
				try {
					return database
						.all<{ table_name: string; row_id: string }>(
							`SELECT table_name, row_id FROM ${PUBLICATION_TABLE}
							 WHERE revision > accepted_revision
							   AND (parked_revision IS NULL OR revision > parked_revision)
							 ORDER BY table_name, row_id`,
						)
						.map(({ table_name, row_id }) => ({
							table: table_name,
							rowId: row_id,
						}));
				} catch (cause) {
					throw poison(cause);
				}
			},
			/**
			 * Freeze one immutable publication attempt for a dirty address, or
			 * return the already frozen image so a lost response retries the
			 * exact same bytes. Chain read, hydration, and freeze share one
			 * transaction; a racing local edit lands as a newer revision and
			 * never mutates the frozen image.
			 */
			freeze(address: RowAddress): DocumentPublicationImage | undefined {
				requireHealthy();
				assertRowAddress(address);
				try {
					return database.transaction(() => {
						const record = readPublication(address);
						if (!record || record.revision <= record.accepted_revision) {
							return undefined;
						}
						if (
							record.inflight_revision !== null &&
							record.inflight_digest !== null &&
							record.inflight_update !== null
						) {
							return {
								update: updateBytes(record.inflight_update),
								digest: record.inflight_digest,
								revision: record.inflight_revision,
							};
						}
						if (
							record.parked_revision !== null &&
							record.revision <= record.parked_revision
						) {
							return undefined;
						}
						const updates = readUpdates(address);
						if (updates.length === 0) return undefined;
						const hydrated = replay(updates);
						let complete: Uint8Array;
						try {
							complete = new Uint8Array(Y.encodeStateAsUpdateV2(hydrated));
						} finally {
							hydrated.destroy();
						}
						const image: DocumentPublicationImage = {
							update: complete,
							digest: sha256HexBytes(complete),
							revision: record.revision,
						};
						database.run(
							`UPDATE ${PUBLICATION_TABLE} SET
								inflight_revision = ?, inflight_digest = ?, inflight_update = ?
							 WHERE table_name = ? AND row_id = ?`,
							[image.revision, image.digest, image.update, address.table, address.rowId],
						);
						return image;
					});
				} catch (cause) {
					throw poison(cause);
				}
			},
			/**
			 * Clear the frozen image only when the post-commit receipt matches
			 * its digest exactly, and mark the address clean only when no newer
			 * local revision arrived after the freeze. A stale or foreign
			 * receipt changes nothing; a lost receipt retries the same bytes.
			 */
			settle(address: RowAddress, receipt: { digest: string }): void {
				requireHealthy();
				assertRowAddress(address);
				try {
					database.transaction(() => {
						const record = readPublication(address);
						if (!record || record.inflight_digest !== receipt.digest) return;
						database.run(
							`UPDATE ${PUBLICATION_TABLE} SET
								accepted_revision = max(accepted_revision, inflight_revision),
								parked_revision = NULL,
								inflight_revision = NULL,
								inflight_digest = NULL,
								inflight_update = NULL
							 WHERE table_name = ? AND row_id = ?`,
							[address.table, address.rowId],
						);
					});
				} catch (cause) {
					throw poison(cause);
				}
			},
			/**
			 * Record a bound refusal for the current revision. The address
			 * stays durably owed but leaves the drain until a later local edit
			 * advances past the parked revision (ADR-0174 parked work).
			 */
			park(address: RowAddress): void {
				requireHealthy();
				assertRowAddress(address);
				try {
					database.run(
						`UPDATE ${PUBLICATION_TABLE} SET
							parked_revision = revision,
							inflight_revision = NULL,
							inflight_digest = NULL,
							inflight_update = NULL
						 WHERE table_name = ? AND row_id = ?`,
						[address.table, address.rowId],
					);
				} catch (cause) {
					throw poison(cause);
				}
			},
			/**
			 * Drop the frozen retry image without settling, keeping the address
			 * dirty. Used when the authority reports the row not live; the
			 * scalar plane delivers the deletion that removes the whole record.
			 */
			clearInflight(address: RowAddress): void {
				requireHealthy();
				assertRowAddress(address);
				try {
					database.run(
						`UPDATE ${PUBLICATION_TABLE} SET
							inflight_revision = NULL,
							inflight_digest = NULL,
							inflight_update = NULL
						 WHERE table_name = ? AND row_id = ?`,
						[address.table, address.rowId],
					);
				} catch (cause) {
					throw poison(cause);
				}
			},
			/** Durable obligation state for one address, or undefined if none. */
			status(address: RowAddress): DocumentPublicationStatus | undefined {
				requireHealthy();
				assertRowAddress(address);
				try {
					const record = readPublication(address);
					if (!record) return undefined;
					return {
						revision: record.revision,
						acceptedRevision: record.accepted_revision,
						parkedRevision: record.parked_revision ?? undefined,
						inflightDigest: record.inflight_digest ?? undefined,
					};
				} catch (cause) {
					throw poison(cause);
				}
			},
		},
	};
}

export type SqliteDocumentLog = ReturnType<typeof createSqliteDocumentLog>;
