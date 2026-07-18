import {
	type AcquiredRow,
	type AcquireRequest,
	type AcquireResponse,
	CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
	type CurrentStateWireRowIntent,
	currentStateRequestRefusal,
	encodedJsonBytes,
	foldFields,
	type JsonObject,
	type PullEntry,
	type PullRequest,
	type PullResponse,
	type PushRequest,
	type PushResponse,
	ROW_SYNC_ADMISSION_LIMITS,
	type RoundReceipt,
	rowRoundDigest,
} from '@epicenter/row-sync';
import type { SqliteDatabase } from '@epicenter/sqlite';
import * as Y from '@y/y';
import type { DocumentHubStore } from '../document-hub/core.js';

type DocumentAddress = Parameters<DocumentHubStore['openIfLive']>[0];

export type CurrentStateRowAuthority = {
	documents: DocumentHubStore;
	hasReplica(replicaId: string): boolean;
	push(request: PushRequest): PushResponse;
	pull(request: PullRequest): PullResponse;
	acquire(request: AcquireRequest): AcquireResponse;
	compactThrough(requestedFloor: number): number;
};

const STORAGE_VERSION = 10;

export const ACCOUNT_AUTHORITY_WALL = 10 * 1024 ** 3 - 64 * 1024 ** 2;

export const AUTHORITY_DOCUMENT_LIMITS = {
	updateBytes: 1_048_576,
	stateBytes: 1_048_576,
	updatesBeforeCompaction: 64,
	updateBytesBeforeCompaction: 524_288,
} as const;

const OLD_TABLE_PREFIX = 'row_sync_';
const CURRENT_TABLE_PREFIX = 'row_authority_';
const TABLES = {
	meta: 'row_authority_meta',
	replicas: 'row_authority_replicas',
	rows: 'row_authority_rows',
	changes: 'row_authority_row_changes',
	documentSnapshots: 'row_authority_document_snapshots',
	documentUpdates: 'row_authority_document_updates',
} as const;

type StoredMeta = {
	storage_version: number;
	protocol_major: number;
	server_sequence: number;
	retention_floor: number;
};

type StoredReplica = {
	accepted_round: number;
	request_digest: string | null;
	applied_through: number;
};

type StoredRow = {
	table_name: string;
	row_id: string;
	fields_json: string;
	changed_sequence: number;
};

type StoredPullMarker = {
	sequence: number;
	table_name: string;
	row_id: string;
	deleted: number;
	fields_json: string | null;
	changed_sequence: number | null;
};

function one<TRow extends Record<string, string | number | null>>(
	database: SqliteDatabase,
	sql: string,
	parameters: readonly (string | number | null)[] = [],
): TRow | undefined {
	return database.all<TRow>(sql, parameters)[0];
}

function dropTable(database: SqliteDatabase, name: string): void {
	const quoted = name.replaceAll('"', '""');
	database.run(`DROP TABLE IF EXISTS "${quoted}"`);
}

function dropIndex(database: SqliteDatabase, name: string): void {
	const quoted = name.replaceAll('"', '""');
	database.run(`DROP INDEX IF EXISTS "${quoted}"`);
}

const CURRENT_SCHEMA = [
	{
		type: 'table',
		name: TABLES.meta,
		sql: `
		CREATE TABLE IF NOT EXISTS row_authority_meta (
			workspace_id TEXT NOT NULL PRIMARY KEY,
			storage_version INTEGER NOT NULL,
			protocol_major INTEGER NOT NULL,
			server_sequence INTEGER NOT NULL CHECK(server_sequence >= 0),
			retention_floor INTEGER NOT NULL
				CHECK(retention_floor >= 0 AND retention_floor <= server_sequence)
		)
	`,
	},
	{
		type: 'table',
		name: TABLES.replicas,
		sql: `
		CREATE TABLE IF NOT EXISTS row_authority_replicas (
			workspace_id TEXT NOT NULL,
			replica_id TEXT NOT NULL,
			accepted_round INTEGER NOT NULL CHECK(accepted_round >= 0),
			request_digest TEXT,
			applied_through INTEGER NOT NULL CHECK(applied_through >= 0),
			CHECK(
				(accepted_round = 0 AND request_digest IS NULL AND applied_through = 0)
				OR
				(accepted_round > 0 AND request_digest IS NOT NULL AND applied_through > 0)
			),
			PRIMARY KEY(workspace_id, replica_id),
			FOREIGN KEY(workspace_id)
				REFERENCES row_authority_meta(workspace_id)
				ON DELETE CASCADE
		)
	`,
	},
	{
		type: 'table',
		name: TABLES.rows,
		sql: `
		CREATE TABLE IF NOT EXISTS row_authority_rows (
			workspace_id TEXT NOT NULL,
			table_name TEXT NOT NULL,
			row_id TEXT NOT NULL,
			fields_json TEXT NOT NULL CHECK(json_valid(fields_json)),
			changed_sequence INTEGER NOT NULL CHECK(changed_sequence > 0),
			PRIMARY KEY(workspace_id, table_name, row_id),
			FOREIGN KEY(workspace_id)
				REFERENCES row_authority_meta(workspace_id)
				ON DELETE CASCADE
		)
	`,
	},
	{
		type: 'table',
		name: TABLES.changes,
		sql: `
		CREATE TABLE IF NOT EXISTS row_authority_row_changes (
			workspace_id TEXT NOT NULL,
			sequence INTEGER NOT NULL CHECK(sequence > 0),
			table_name TEXT NOT NULL,
			row_id TEXT NOT NULL,
			deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0, 1)),
			PRIMARY KEY(workspace_id, sequence),
			FOREIGN KEY(workspace_id)
				REFERENCES row_authority_meta(workspace_id)
				ON DELETE CASCADE
		)
	`,
	},
	{
		type: 'table',
		name: TABLES.documentSnapshots,
		sql: `
		CREATE TABLE IF NOT EXISTS row_authority_document_snapshots (
			workspace_id TEXT NOT NULL,
			table_name TEXT NOT NULL,
			row_id TEXT NOT NULL,
			snapshot BLOB NOT NULL,
			PRIMARY KEY(workspace_id, table_name, row_id),
			FOREIGN KEY(workspace_id, table_name, row_id)
				REFERENCES row_authority_rows(workspace_id, table_name, row_id)
				ON DELETE CASCADE
		)
	`,
	},
	{
		type: 'table',
		name: TABLES.documentUpdates,
		sql: `
		CREATE TABLE IF NOT EXISTS row_authority_document_updates (
			workspace_id TEXT NOT NULL,
			table_name TEXT NOT NULL,
			row_id TEXT NOT NULL,
			update_sequence INTEGER NOT NULL CHECK(update_sequence > 0),
			update_bytes BLOB NOT NULL,
			PRIMARY KEY(workspace_id, table_name, row_id, update_sequence),
			FOREIGN KEY(workspace_id, table_name, row_id)
				REFERENCES row_authority_rows(workspace_id, table_name, row_id)
				ON DELETE CASCADE
		)
	`,
	},
	{
		type: 'index',
		name: 'row_authority_deletion_markers_address',
		sql: `
		CREATE INDEX IF NOT EXISTS row_authority_deletion_markers_address
			ON row_authority_row_changes(workspace_id, table_name, row_id)
			WHERE deleted = 1
	`,
	},
] as const;

function normalizedSchemaSql(sql: string): string {
	return sql
		.replace(/\bIF NOT EXISTS\b/gi, '')
		.replace(/\s+/g, ' ')
		.trim()
		.toLowerCase();
}

/**
 * Storage version alone cannot distinguish a partially created or manually
 * altered family. Compare every owned table and explicit index by normalized
 * SQLite DDL so a missing column, constraint, table, or index resets the whole
 * disposable authority instead of entering a migration path.
 */
function hasCompleteCurrentSchema(database: SqliteDatabase): boolean {
	const actual = database
		.all<{ type: string; name: string; sql: string | null }>(
			`SELECT type, name, sql FROM sqlite_master
			 WHERE type IN ('table', 'index') AND sql IS NOT NULL`,
		)
		.filter(({ name }) => name.startsWith(CURRENT_TABLE_PREFIX));
	if (actual.length !== CURRENT_SCHEMA.length) return false;
	return CURRENT_SCHEMA.every((expected) => {
		const stored = actual.find(
			({ type, name }) => type === expected.type && name === expected.name,
		);
		return (
			stored !== undefined &&
			stored.sql !== null &&
			normalizedSchemaSql(stored.sql) === normalizedSchemaSql(expected.sql)
		);
	});
}

function dropCurrentSchema(database: SqliteDatabase): void {
	const objects = database
		.all<{ type: string; name: string }>(
			`SELECT type, name FROM sqlite_master
			 WHERE type IN ('table', 'index')`,
		)
		.filter(({ name }) => name.startsWith(CURRENT_TABLE_PREFIX));
	for (const { type, name } of objects) {
		if (type === 'index') dropIndex(database, name);
	}
	const childTables = new Set<string>([
		TABLES.documentUpdates,
		TABLES.documentSnapshots,
	]);
	for (const { type, name } of objects) {
		if (type === 'table' && childTables.has(name)) dropTable(database, name);
	}
	for (const { type, name } of objects) {
		if (type === 'table' && !childTables.has(name)) dropTable(database, name);
	}
}

function createCurrentSchema(database: SqliteDatabase): void {
	for (const { sql } of CURRENT_SCHEMA) database.run(sql);
}

function initialize(database: SqliteDatabase): void {
	database.run('PRAGMA foreign_keys = ON');
	const foreignKeys = one<{ foreign_keys: number }>(
		database,
		'PRAGMA foreign_keys',
	);
	if (foreignKeys?.foreign_keys !== 1) {
		throw new Error('Account authority requires SQLite foreign keys');
	}
	database.transaction(() => {
		const oldTables = database.all<{ name: string }>(
			`SELECT name FROM sqlite_master
			 WHERE type = 'table' AND name LIKE 'row_sync_%'`,
		);
		for (const { name } of oldTables) {
			if (name.startsWith(OLD_TABLE_PREFIX)) dropTable(database, name);
		}

		const hasCurrentSchema = hasCompleteCurrentSchema(database);
		const incompatibleMeta = hasCurrentSchema
			? one<{ present: number }>(
					database,
					`SELECT 1 AS present FROM row_authority_meta
					 WHERE storage_version != ? OR protocol_major != ? LIMIT 1`,
					[STORAGE_VERSION, CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR],
				)
			: { present: 1 };
		if (incompatibleMeta) {
			dropCurrentSchema(database);
		}

		createCurrentSchema(database);
		if (!hasCompleteCurrentSchema(database)) {
			throw new Error('Current-state authority schema was not created exactly');
		}
	});
}

const EMPTY_META: StoredMeta = {
	storage_version: STORAGE_VERSION,
	protocol_major: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
	server_sequence: 0,
	retention_floor: 0,
};

function readMeta(database: SqliteDatabase, workspaceId: string): StoredMeta {
	const meta = one<StoredMeta>(
		database,
		`SELECT storage_version, protocol_major, server_sequence, retention_floor
		 FROM row_authority_meta WHERE workspace_id = ?`,
		[workspaceId],
	);
	return meta ?? EMPTY_META;
}

function readStoredReplica(
	database: SqliteDatabase,
	workspaceId: string,
	replicaId: string,
): StoredReplica | undefined {
	return one<StoredReplica>(
		database,
		`SELECT accepted_round, request_digest, applied_through
		 FROM row_authority_replicas
		 WHERE workspace_id = ? AND replica_id = ?`,
		[workspaceId, replicaId],
	);
}

function toReceipt(stored: StoredReplica): RoundReceipt {
	return {
		acceptedRound: stored.accepted_round,
		requestDigest: stored.request_digest,
		appliedThrough: stored.applied_through,
	};
}

function readRow(
	database: SqliteDatabase,
	workspaceId: string,
	table: string,
	rowId: string,
): StoredRow | undefined {
	return one<StoredRow>(
		database,
		`SELECT table_name, row_id, fields_json, changed_sequence
		 FROM row_authority_rows
		 WHERE workspace_id = ? AND table_name = ? AND row_id = ?`,
		[workspaceId, table, rowId],
	);
}

function writeRow(
	database: SqliteDatabase,
	workspaceId: string,
	table: string,
	rowId: string,
	fields: object,
	sequence: number,
): void {
	database.run(
		`INSERT INTO row_authority_rows(
			workspace_id, table_name, row_id, fields_json, changed_sequence
		) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(workspace_id, table_name, row_id) DO UPDATE SET
			fields_json = excluded.fields_json,
			changed_sequence = excluded.changed_sequence`,
		[workspaceId, table, rowId, JSON.stringify(fields), sequence],
	);
}

function markRowChange(
	database: SqliteDatabase,
	workspaceId: string,
	intent: CurrentStateWireRowIntent,
	sequence: number,
	deleted = false,
): void {
	database.run(
		`INSERT INTO row_authority_row_changes(
			workspace_id, sequence, table_name, row_id, deleted
		) VALUES (?, ?, ?, ?, ?)`,
		[workspaceId, sequence, intent.table, intent.rowId, deleted ? 1 : 0],
	);
}

function hasRetainedDeletionMarker(
	database: SqliteDatabase,
	workspaceId: string,
	table: string,
	rowId: string,
): boolean {
	return Boolean(
		one<{ present: number }>(
			database,
			`SELECT 1 AS present FROM row_authority_row_changes
			 WHERE workspace_id = ? AND table_name = ? AND row_id = ?
			   AND deleted = 1 LIMIT 1`,
			[workspaceId, table, rowId],
		),
	);
}

function deleteRow(
	database: SqliteDatabase,
	workspaceId: string,
	intent: Extract<CurrentStateWireRowIntent, { kind: 'delete' }>,
	sequence: number,
): void {
	database.run(
		`DELETE FROM row_authority_rows
		 WHERE workspace_id = ? AND table_name = ? AND row_id = ?`,
		[workspaceId, intent.table, intent.rowId],
	);
	markRowChange(database, workspaceId, intent, sequence, true);
}

function applyIntent(
	database: SqliteDatabase,
	workspaceId: string,
	intent: CurrentStateWireRowIntent,
	sequence: number,
): void {
	const current = readRow(database, workspaceId, intent.table, intent.rowId);
	const currentFields = current
		? (JSON.parse(current.fields_json) as JsonObject)
		: undefined;
	if (
		intent.kind === 'create' &&
		hasRetainedDeletionMarker(database, workspaceId, intent.table, intent.rowId)
	) {
		return;
	}
	switch (intent.kind) {
		case 'create': {
			const folded = foldFields(currentFields, intent);
			if (folded.kind !== 'fields') return;
			writeRow(
				database,
				workspaceId,
				intent.table,
				intent.rowId,
				folded.fields,
				sequence,
			);
			markRowChange(database, workspaceId, intent, sequence);
			return;
		}
		case 'update': {
			const folded = foldFields(currentFields, intent);
			if (folded.kind !== 'fields') return;
			writeRow(
				database,
				workspaceId,
				intent.table,
				intent.rowId,
				folded.fields,
				sequence,
			);
			markRowChange(database, workspaceId, intent, sequence);
			return;
		}
		case 'delete': {
			if (!current) return;
			deleteRow(database, workspaceId, intent, sequence);
			return;
		}
	}
}

function buildPullEntries(markers: readonly StoredPullMarker[]): PullEntry[] {
	if (markers.length === 0) return [];
	const entries: PullEntry[] = [];

	const unique = new Map<string, StoredPullMarker>();
	for (const marker of markers) {
		unique.set(`${marker.table_name}\u0000${marker.row_id}`, marker);
	}
	for (const marker of unique.values()) {
		if (marker.fields_json !== null && marker.changed_sequence !== null) {
			entries.push({
				kind: 'row',
				table: marker.table_name,
				rowId: marker.row_id,
				changedSequence: marker.changed_sequence,
				fields: JSON.parse(marker.fields_json),
			});
			continue;
		}
		if (marker.fields_json !== null || marker.changed_sequence !== null) {
			throw new Error('Joined authority row is only partially present');
		}
		if (marker.deleted === 1) {
			entries.push({
				kind: 'deleted',
				table: marker.table_name,
				rowId: marker.row_id,
				deletedSequence: marker.sequence,
			});
		}
	}
	return entries;
}

function buildAcquireRows(storedRows: readonly StoredRow[]): AcquiredRow[] {
	return storedRows.map((stored) => ({
		table: stored.table_name,
		rowId: stored.row_id,
		fields: JSON.parse(stored.fields_json),
		changedSequence: stored.changed_sequence,
	}));
}

function bytesFromSqlite(value: Uint8Array | ArrayBuffer): Uint8Array {
	return value instanceof Uint8Array
		? Uint8Array.from(value)
		: new Uint8Array(value.slice(0));
}

function readDocumentParts(
	database: SqliteDatabase,
	workspaceId: string,
	address: DocumentAddress,
): Uint8Array[] {
	const parts: Uint8Array[] = [];
	const snapshot = database.all<{ snapshot: Uint8Array | ArrayBuffer }>(
		`SELECT snapshot FROM row_authority_document_snapshots
		 WHERE workspace_id = ? AND table_name = ? AND row_id = ?`,
		[workspaceId, address.table, address.rowId],
	)[0];
	if (snapshot) parts.push(bytesFromSqlite(snapshot.snapshot));
	for (const stored of database.all<{
		update_bytes: Uint8Array | ArrayBuffer;
	}>(
		`SELECT update_bytes FROM row_authority_document_updates
		 WHERE workspace_id = ? AND table_name = ? AND row_id = ?
		 ORDER BY update_sequence`,
		[workspaceId, address.table, address.rowId],
	)) {
		parts.push(bytesFromSqlite(stored.update_bytes));
	}
	return parts;
}

function hydrateDocument(parts: readonly Uint8Array[]): Y.Doc {
	const document = new Y.Doc({ gc: true });
	try {
		for (const part of parts) Y.applyUpdateV2(document, part);
		return document;
	} catch (cause) {
		document.destroy();
		throw new TypeError(
			'Authority contains an invalid Yjs 14 document update',
			{
				cause,
			},
		);
	}
}

/** Synchronous document store over the same authority-owned SQLite schema. */
function createWorkspaceAuthorityDocumentStore(
	database: SqliteDatabase,
	workspaceId: string,
	readDatabaseSize?: () => number,
): DocumentHubStore {
	return {
		openIfLive(address) {
			return database.transaction(() =>
				readRow(database, workspaceId, address.table, address.rowId)
					? readDocumentParts(database, workspaceId, address)
					: undefined,
			);
		},
		appendIfLive(address, update) {
			if (readDatabaseSize && readDatabaseSize() >= ACCOUNT_AUTHORITY_WALL) {
				return 'refused';
			}
			const candidate = Uint8Array.from(update);
			return database.transaction(() => {
				if (!readRow(database, workspaceId, address.table, address.rowId)) {
					return 'refused';
				}

				const document = hydrateDocument(
					readDocumentParts(database, workspaceId, address),
				);
				try {
					try {
						Y.applyUpdateV2(document, candidate);
					} catch (cause) {
						throw new TypeError('Invalid Yjs 14 document update', { cause });
					}
					if (candidate.byteLength > AUTHORITY_DOCUMENT_LIMITS.updateBytes) {
						return 'too-large';
					}
					const snapshot = Y.encodeStateAsUpdateV2(document);
					if (snapshot.byteLength > AUTHORITY_DOCUMENT_LIMITS.stateBytes) {
						return 'too-large';
					}

					const stats = one<{ count: number; bytes: number }>(
						database,
						`SELECT COUNT(*) AS count,
						        COALESCE(SUM(length(update_bytes)), 0) AS bytes
						 FROM row_authority_document_updates
						 WHERE workspace_id = ? AND table_name = ? AND row_id = ?`,
						[workspaceId, address.table, address.rowId],
					);
					const nextSequence = (stats?.count ?? 0) + 1;
					database.run(
						`INSERT INTO row_authority_document_updates(
							workspace_id, table_name, row_id, update_sequence,
							update_bytes
						) VALUES (?, ?, ?, ?, ?)`,
						[
							workspaceId,
							address.table,
							address.rowId,
							nextSequence,
							candidate,
						],
					);

					if (
						nextSequence >= AUTHORITY_DOCUMENT_LIMITS.updatesBeforeCompaction ||
						(stats?.bytes ?? 0) + candidate.byteLength >=
							AUTHORITY_DOCUMENT_LIMITS.updateBytesBeforeCompaction
					) {
						database.run(
							`INSERT INTO row_authority_document_snapshots(
									workspace_id, table_name, row_id, snapshot
								) VALUES (?, ?, ?, ?)
								ON CONFLICT(workspace_id, table_name, row_id) DO UPDATE SET
									snapshot = excluded.snapshot`,
							[workspaceId, address.table, address.rowId, snapshot],
						);
						database.run(
							`DELETE FROM row_authority_document_updates
								 WHERE workspace_id = ? AND table_name = ? AND row_id = ?`,
							[workspaceId, address.table, address.rowId],
						);
					}
					return 'appended';
				} finally {
					document.destroy();
				}
			});
		},
	};
}

/** Open one account authority over caller-owned SQLite. */
export function openAccountRowAuthority({
	database,
	readDatabaseSize,
}: {
	database: SqliteDatabase;
	readDatabaseSize?: () => number;
}) {
	initialize(database);
	const workspaces = new Map<string, CurrentStateRowAuthority>();

	function workspace(workspaceId: string): CurrentStateRowAuthority {
		const cached = workspaces.get(workspaceId);
		if (cached) return cached;
		const documents = createWorkspaceAuthorityDocumentStore(
			database,
			workspaceId,
			readDatabaseSize,
		);
		const authority = {
			documents,
			hasReplica(replicaId: string): boolean {
				return (
					readStoredReplica(database, workspaceId, replicaId) !== undefined
				);
			},

			push(request: PushRequest): PushResponse {
				if (readDatabaseSize && readDatabaseSize() >= ACCOUNT_AUTHORITY_WALL) {
					return { result: 'storage-limit' };
				}
				const refusal = currentStateRequestRefusal(request);
				if (refusal) return { result: refusal };
				if (rowRoundDigest(request.intents) !== request.requestDigest) {
					throw new TypeError('Sealed round digest does not match its intents');
				}
				return database.transaction(() => {
					const stored = readStoredReplica(
						database,
						workspaceId,
						request.replicaId,
					);
					if (!stored && request.round !== 1) {
						return { result: 'recovery-required' } as const;
					}
					if (!stored) {
						database.run(
							`INSERT INTO row_authority_meta(
								workspace_id, storage_version, protocol_major,
								server_sequence, retention_floor
							) VALUES (?, ?, ?, 0, 0)
							ON CONFLICT(workspace_id) DO NOTHING`,
							[
								workspaceId,
								STORAGE_VERSION,
								CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
							],
						);
						database.run(
							`INSERT INTO row_authority_replicas(
								workspace_id, replica_id, accepted_round,
								request_digest, applied_through
							) VALUES (?, ?, 0, NULL, 0)`,
							[workspaceId, request.replicaId],
						);
					}
					const current = stored ?? {
						accepted_round: 0,
						request_digest: null,
						applied_through: 0,
					};
					if (request.round === current.accepted_round) {
						return request.requestDigest === current.request_digest
							? ({ result: 'accepted', receipt: toReceipt(current) } as const)
							: ({ result: 'recovery-required' } as const);
					}
					if (request.round !== current.accepted_round + 1) {
						return { result: 'recovery-required' } as const;
					}

					const meta = readMeta(database, workspaceId);
					let sequence = meta.server_sequence;
					for (const intent of request.intents) {
						sequence += 1;
						applyIntent(database, workspaceId, intent, sequence);
					}
					database.run(
						`UPDATE row_authority_meta SET server_sequence = ?
						 WHERE workspace_id = ?`,
						[sequence, workspaceId],
					);
					database.run(
						`UPDATE row_authority_replicas SET
							accepted_round = ?, request_digest = ?, applied_through = ?
						 WHERE workspace_id = ? AND replica_id = ?`,
						[
							request.round,
							request.requestDigest,
							sequence,
							workspaceId,
							request.replicaId,
						],
					);
					return {
						result: 'accepted',
						receipt: {
							acceptedRound: request.round,
							requestDigest: request.requestDigest,
							appliedThrough: sequence,
						},
					} as const;
				});
			},

			pull(request: PullRequest): PullResponse {
				const refusal = currentStateRequestRefusal(request);
				if (refusal) return { result: refusal };
				return database.transaction(() => {
					const stored = readStoredReplica(
						database,
						workspaceId,
						request.replicaId,
					);
					const receipt = stored
						? toReceipt(stored)
						: { acceptedRound: 0, requestDigest: null, appliedThrough: 0 };
					const meta = readMeta(database, workspaceId);
					if (request.after > meta.server_sequence) {
						throw new TypeError('Pull checkpoint is ahead of the authority');
					}
					const through = request.through ?? meta.server_sequence;
					if (through < request.after || through > meta.server_sequence) {
						throw new TypeError('Pull target is outside the authority history');
					}
					if (request.after < meta.retention_floor) {
						return {
							result: 'acquisition-required',
							receipt,
							retentionFloor: meta.retention_floor,
						} as const;
					}

					const pageLimit =
						request.pageLimit ?? ROW_SYNC_ADMISSION_LIMITS.pullEntriesPerPage;
					const available = database.all<StoredPullMarker>(
						`SELECT changes.sequence, changes.table_name,
						        changes.row_id, changes.deleted,
						        rows.fields_json, rows.changed_sequence
						 FROM row_authority_row_changes AS changes
						 LEFT JOIN row_authority_rows AS rows
						   ON rows.workspace_id = changes.workspace_id
						  AND rows.table_name = changes.table_name
						  AND rows.row_id = changes.row_id
						 WHERE changes.workspace_id = ? AND changes.sequence > ?
						   AND changes.sequence <= ?
						 ORDER BY changes.sequence
						 LIMIT ?`,
						[workspaceId, request.after, through, pageLimit + 1],
					);
					let selected = available.slice(0, pageLimit);
					let entries = buildPullEntries(selected);
					const responseSize = () =>
						encodedJsonBytes({
							result: 'page',
							receipt,
							through,
							// `through` is the largest possible checkpoint encoding and
							// therefore makes byte-limit trimming conservative.
							checkpoint: through,
							retentionFloor: meta.retention_floor,
							entries,
						});
					while (
						selected.length > 1 &&
						(entries.length > pageLimit ||
							entries.length > ROW_SYNC_ADMISSION_LIMITS.pullEntriesPerPage ||
							responseSize() > ROW_SYNC_ADMISSION_LIMITS.encodedPageBytes)
					) {
						selected = selected.slice(0, -1);
						entries = buildPullEntries(selected);
					}
					if (
						entries.length > ROW_SYNC_ADMISSION_LIMITS.pullEntriesPerPage ||
						responseSize() > ROW_SYNC_ADMISSION_LIMITS.encodedPageBytes
					) {
						throw new Error(
							'One authority sequence exceeds the pull page limits',
						);
					}

					const lastSelected = selected.at(-1)?.sequence;
					const hasMore =
						lastSelected !== undefined &&
						Boolean(
							one<{ present: number }>(
								database,
								`SELECT 1 AS present FROM row_authority_row_changes
								 WHERE workspace_id = ? AND sequence > ?
								   AND sequence <= ? LIMIT 1`,
								[workspaceId, lastSelected, through],
							),
						);
					return {
						result: 'page',
						receipt,
						through,
						checkpoint: hasMore ? (lastSelected ?? request.after) : through,
						retentionFloor: meta.retention_floor,
						entries,
					} as const;
				});
			},

			acquire(request: AcquireRequest): AcquireResponse {
				const refusal = currentStateRequestRefusal(request);
				if (refusal) return { result: refusal };
				return database.transaction(() => {
					const stored = readStoredReplica(
						database,
						workspaceId,
						request.replicaId,
					);
					const receipt = stored
						? toReceipt(stored)
						: { acceptedRound: 0, requestDigest: null, appliedThrough: 0 };
					const meta = readMeta(database, workspaceId);
					const pageLimit =
						request.pageLimit ?? ROW_SYNC_ADMISSION_LIMITS.acquiredRowsPerPage;
					const after = request.afterAddress;
					const available = database.all<StoredRow>(
						`SELECT table_name, row_id, fields_json, changed_sequence
						 FROM row_authority_rows
						 WHERE workspace_id = ? AND (
							(? IS NULL)
							OR (table_name > ?)
							OR (table_name = ? AND row_id > ?)
						 )
						 ORDER BY table_name, row_id
						 LIMIT ?`,
						[
							workspaceId,
							after ? 1 : null,
							after?.table ?? '',
							after?.table ?? '',
							after?.rowId ?? '',
							pageLimit + 1,
						],
					);
					let selected = available.slice(0, pageLimit);
					let rows = buildAcquireRows(selected);
					let hasMore = available.length > selected.length;
					const responseSize = () =>
						encodedJsonBytes({
							result: 'page',
							receipt,
							rows,
							head: meta.server_sequence,
							retentionFloor: meta.retention_floor,
							hasMore,
						});
					while (
						selected.length > 1 &&
						responseSize() > ROW_SYNC_ADMISSION_LIMITS.encodedPageBytes
					) {
						selected = selected.slice(0, -1);
						rows = buildAcquireRows(selected);
						hasMore = true;
					}
					if (responseSize() > ROW_SYNC_ADMISSION_LIMITS.encodedPageBytes) {
						throw new Error('One acquired row exceeds the page byte limit');
					}
					return {
						result: 'page',
						receipt,
						rows,
						head: meta.server_sequence,
						retentionFloor: meta.retention_floor,
						hasMore,
					} as const;
				});
			},

			compactThrough(requestedFloor: number): number {
				if (!Number.isSafeInteger(requestedFloor) || requestedFloor < 0) {
					throw new TypeError(
						'Compaction floor must be a non-negative integer',
					);
				}
				return database.transaction(() => {
					const meta = readMeta(database, workspaceId);
					const floor = Math.max(
						meta.retention_floor,
						Math.min(requestedFloor, meta.server_sequence),
					);
					database.run(
						`DELETE FROM row_authority_row_changes
						 WHERE workspace_id = ? AND sequence <= ?`,
						[workspaceId, floor],
					);
					database.run(
						`UPDATE row_authority_meta SET retention_floor = ?
						 WHERE workspace_id = ?`,
						[floor, workspaceId],
					);
					return floor;
				});
			},
		};
		workspaces.set(workspaceId, authority);
		return authority;
	}

	return {
		workspace,
		deleteWorkspace(workspaceId: string): void {
			database.transaction(() => {
				for (const table of [
					TABLES.documentUpdates,
					TABLES.documentSnapshots,
					TABLES.changes,
					TABLES.rows,
					TABLES.replicas,
					TABLES.meta,
				]) {
					database.run(`DELETE FROM ${table} WHERE workspace_id = ?`, [
						workspaceId,
					]);
				}
			});
		},
	};
}

export type AccountRowAuthority = ReturnType<typeof openAccountRowAuthority>;
