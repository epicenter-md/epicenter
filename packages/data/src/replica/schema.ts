import type { SqliteDatabase } from '@epicenter/sqlite';

export const REPLICA_FORMAT_VERSION = 5;

/**
 * Row facts and value facts are separate relations because their laws differ,
 * not because their payloads happen to differ (ADR-0163, ADR-0164).
 *
 * A row fact has a runtime-minted row id, an object payload, a terminal
 * tombstone, and owns documents and blobs. A value fact has no row id, holds any
 * JSON, and its absence is a reversible unset. One shared `state` relation could
 * only express that by carrying a nullable row id plus a three-way status and
 * then re-asserting, in CHECK constraints, which combinations are legal. Two
 * relations let each law be a column constraint instead: `presence` is two-valued
 * in both tables and means "terminal tombstone" in one and "reversible unset" in
 * the other, and only `row_facts` has a `row_id` at all.
 *
 * The local intent queues split for the same reason. It also removes the last
 * two conflations of the single-table layout: an `address_kind = 'value'` row
 * forced to carry `row_id = ''` as a sentinel, and the sealed batch sequence
 * smuggled in as a negative-sequence pseudo-value at a reserved internal
 * address. The batch sequence is replica metadata, so it lives in `metadata`.
 *
 * `authority_sequence` uniqueness across both fact relations is an authority
 * property, not a local one: local writes land at sequence 0 until an exchange
 * assigns authority sequences, so these indexes are non-unique here.
 */
const SCHEMA = [
	`CREATE TABLE metadata (
		singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
		format_version INTEGER NOT NULL,
		replica_id TEXT NOT NULL,
		attached_deployment TEXT,
		attached_principal TEXT,
		last_applied_authority_sequence INTEGER NOT NULL
			CHECK (last_applied_authority_sequence >= 0),
		last_sealed_batch_sequence INTEGER NOT NULL
			CHECK (last_sealed_batch_sequence >= 0),
		CHECK (
			(attached_deployment IS NULL AND attached_principal IS NULL) OR
			(attached_deployment IS NOT NULL AND attached_principal IS NOT NULL)
		)
	) STRICT`,
	`CREATE TABLE row_facts (
		namespace TEXT NOT NULL,
		table_name TEXT NOT NULL,
		row_id TEXT NOT NULL CHECK (
			length(row_id) = 24 AND row_id NOT GLOB '*[^a-z0-9]*'
		),
		presence TEXT NOT NULL CHECK (presence IN ('present', 'absent')),
		fields TEXT,
		authority_sequence INTEGER NOT NULL CHECK (authority_sequence >= 0),
		PRIMARY KEY (namespace, table_name, row_id),
		CHECK (
			(presence = 'present' AND fields IS NOT NULL AND json_valid(fields)) OR
			(presence = 'absent' AND fields IS NULL)
		)
	) WITHOUT ROWID, STRICT`,
	'CREATE INDEX row_facts_authority_sequence ON row_facts(authority_sequence)',
	`CREATE TABLE value_facts (
		namespace TEXT NOT NULL,
		value_name TEXT NOT NULL,
		presence TEXT NOT NULL CHECK (presence IN ('present', 'absent')),
		content TEXT,
		authority_sequence INTEGER NOT NULL CHECK (authority_sequence >= 0),
		PRIMARY KEY (namespace, value_name),
		CHECK (
			(presence = 'present' AND content IS NOT NULL AND json_valid(content)) OR
			(presence = 'absent' AND content IS NULL)
		)
	) WITHOUT ROWID, STRICT`,
	'CREATE INDEX value_facts_authority_sequence ON value_facts(authority_sequence)',
	// The two local intent queues share one strictly increasing local sequence
	// space so a sealed batch has a stable order across both address kinds.
	// Cross-table uniqueness is the single local writer's invariant; each table
	// still refuses a duplicate of its own.
	`CREATE TABLE row_outbox (
		local_sequence INTEGER PRIMARY KEY CHECK (local_sequence > 0),
		namespace TEXT NOT NULL,
		table_name TEXT NOT NULL,
		row_id TEXT NOT NULL CHECK (
			length(row_id) = 24 AND row_id NOT GLOB '*[^a-z0-9]*'
		),
		verb TEXT NOT NULL CHECK (verb IN ('patch', 'delete')),
		patch TEXT,
		CHECK (
			(verb = 'patch' AND patch IS NOT NULL AND json_valid(patch)) OR
			(verb = 'delete' AND patch IS NULL)
		)
	) STRICT`,
	`CREATE TABLE value_outbox (
		local_sequence INTEGER PRIMARY KEY CHECK (local_sequence > 0),
		namespace TEXT NOT NULL,
		value_name TEXT NOT NULL,
		verb TEXT NOT NULL CHECK (verb IN ('set', 'unset')),
		content TEXT,
		CHECK (
			(verb = 'set' AND content IS NOT NULL AND json_valid(content)) OR
			(verb = 'unset' AND content IS NULL)
		)
	) STRICT`,
	// Documents and blobs are owned by a row address, so they key on the exact
	// row coordinates rather than on a second address vocabulary (ADR-0174).
	`CREATE TABLE document_updates (
		namespace TEXT NOT NULL,
		table_name TEXT NOT NULL,
		row_id TEXT NOT NULL,
		update_sequence INTEGER NOT NULL CHECK (update_sequence > 0),
		update_bytes BLOB NOT NULL,
		PRIMARY KEY (namespace, table_name, row_id, update_sequence)
	) WITHOUT ROWID, STRICT`,
	// The durable authority obligation for one row document (ADR-0171/0174):
	// `revision` advances with every locally authored append in the same
	// transaction; `accepted_revision` advances only when the authority
	// acknowledges accepting a captured revision, and never past a newer local
	// revision. `sync_issue` records the terminal `too-large` condition that
	// permanently removes the address from automatic publication.
	`CREATE TABLE document_publication (
		namespace TEXT NOT NULL,
		table_name TEXT NOT NULL,
		row_id TEXT NOT NULL,
		revision INTEGER NOT NULL CHECK (revision > 0),
		accepted_revision INTEGER NOT NULL
			CHECK (accepted_revision >= 0 AND accepted_revision <= revision),
		sync_issue TEXT CHECK (sync_issue IN ('too-large')),
		PRIMARY KEY (namespace, table_name, row_id)
	) WITHOUT ROWID, STRICT`,
] as const;

/** Every relation a current replica file owns. */
export const REPLICA_TABLES = [
	'metadata',
	'row_facts',
	'value_facts',
	'row_outbox',
	'value_outbox',
	'document_updates',
	'document_publication',
] as const;

export function createReplicaSchema(
	database: SqliteDatabase,
	replicaId: string,
): void {
	for (const statement of SCHEMA) database.run(statement);
	database.run(
		`INSERT INTO metadata (
			singleton, format_version, replica_id, attached_deployment,
			attached_principal, last_applied_authority_sequence,
			last_sealed_batch_sequence
		) VALUES (1, ?, ?, NULL, NULL, 0, 0)`,
		[REPLICA_FORMAT_VERSION, replicaId],
	);
}
