import type { SqliteDatabase } from '@epicenter/sqlite';

export const REPLICA_FORMAT_VERSION = 3;

const SCHEMA = [
	`CREATE TABLE metadata (
		singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
		format_version INTEGER NOT NULL,
		replica_id TEXT NOT NULL,
		attached_deployment TEXT,
		attached_principal TEXT,
		last_applied_authority_sequence INTEGER NOT NULL
			CHECK (last_applied_authority_sequence >= 0),
		CHECK (
			(attached_deployment IS NULL AND attached_principal IS NULL) OR
			(attached_deployment IS NOT NULL AND attached_principal IS NOT NULL)
		)
	) STRICT`,
	`CREATE TABLE state (
		address_kind TEXT NOT NULL CHECK (address_kind IN ('row', 'value')),
		qualified_key TEXT NOT NULL,
		row_id TEXT NOT NULL,
		status TEXT NOT NULL CHECK (status IN ('live', 'deleted', 'unset')),
		json_payload TEXT,
		changed_sequence INTEGER NOT NULL CHECK (changed_sequence >= 0),
		PRIMARY KEY (address_kind, qualified_key, row_id),
		CHECK (
			(address_kind = 'row' AND row_id <> '' AND status IN ('live', 'deleted')) OR
			(address_kind = 'value' AND row_id = '' AND status IN ('live', 'unset'))
		),
		CHECK (
			(status = 'live' AND json_payload IS NOT NULL AND json_valid(json_payload)) OR
			(status IN ('deleted', 'unset') AND json_payload IS NULL)
		)
	) WITHOUT ROWID, STRICT`,
	'CREATE INDEX state_changed_sequence ON state(changed_sequence)',
	`CREATE TABLE outbox (
		local_sequence INTEGER PRIMARY KEY,
		address_kind TEXT NOT NULL CHECK (address_kind IN ('row', 'value')),
		qualified_key TEXT NOT NULL,
		row_id TEXT NOT NULL,
		status TEXT NOT NULL CHECK (status IN ('live', 'deleted', 'unset')),
		json_payload TEXT,
		CHECK (
			(address_kind = 'row' AND row_id <> '' AND status IN ('live', 'deleted')) OR
			(address_kind = 'value' AND row_id = '' AND status IN ('live', 'unset'))
		),
		CHECK (
			(status = 'live' AND json_payload IS NOT NULL AND json_valid(json_payload)) OR
			(status IN ('deleted', 'unset') AND json_payload IS NULL)
		)
	) STRICT`,
	`CREATE TABLE document_updates (
		qualified_key TEXT NOT NULL,
		row_id TEXT NOT NULL,
		update_sequence INTEGER NOT NULL CHECK (update_sequence > 0),
		update_bytes BLOB NOT NULL,
		PRIMARY KEY (qualified_key, row_id, update_sequence)
	) WITHOUT ROWID, STRICT`,
	// The durable authority obligation for one row document (ADR-0171/0174):
	// `revision` advances with every locally authored append in the same
	// transaction; `accepted_revision` advances only when the authority
	// acknowledges accepting a captured revision, and never past a newer local
	// revision. `sync_issue` records the terminal `too-large` condition that
	// permanently removes the address from automatic publication.
	`CREATE TABLE document_publication (
		qualified_key TEXT NOT NULL,
		row_id TEXT NOT NULL,
		revision INTEGER NOT NULL CHECK (revision > 0),
		accepted_revision INTEGER NOT NULL
			CHECK (accepted_revision >= 0 AND accepted_revision <= revision),
		sync_issue TEXT CHECK (sync_issue IN ('too-large')),
		PRIMARY KEY (qualified_key, row_id)
	) WITHOUT ROWID, STRICT`,
] as const;

export function createReplicaSchema(
	database: SqliteDatabase,
	replicaId: string,
): void {
	for (const statement of SCHEMA) database.run(statement);
	database.run(
		`INSERT INTO metadata (
			singleton, format_version, replica_id, attached_deployment,
			attached_principal, last_applied_authority_sequence
		) VALUES (1, ?, ?, NULL, NULL, 0)`,
		[REPLICA_FORMAT_VERSION, replicaId],
	);
}
