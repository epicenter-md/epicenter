import type { SqliteDatabase } from '@epicenter/sqlite';

export const REPLICA_FORMAT_VERSION = 7;

/**
 * One relation holds every fact, because there is only one kind of fact
 * (ADR-0206).
 *
 * An earlier layout split rows from values, on the reading that their laws
 * differed. The difference was never a law: it was who supplied the third
 * coordinate. A row id now comes from whoever knows it, minted when nobody does
 * and chosen when an application does, so a value is a row you named and needs
 * no relation of its own. `presence` is two-valued and has exactly one meaning,
 * a terminal tombstone; a reversible unset is a field unset inside a patch,
 * which the outbox verb already carries.
 *
 * The `row_id` CHECK admits both origins and nothing else. Every admitted
 * character is safe verbatim in a URL path segment, because a row's bytes are
 * read through a path built from its address, and the first character excludes
 * `.`, `-`, and `_` so no id can be a relative path segment or a dotfile.
 *
 * The sealed batch sequence is replica metadata and lives in `metadata`, where
 * the previous layout had to smuggle it in as a negative-sequence pseudo-value.
 *
 * `authority_sequence` uniqueness is an authority property, not a local one:
 * local writes land at sequence 0 until an exchange assigns authority
 * sequences, so this index is non-unique here.
 */
const SCHEMA = [
	`CREATE TABLE main._replica_metadata (
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
	`CREATE TABLE main._replica_row_facts (
		namespace TEXT NOT NULL,
		table_name TEXT NOT NULL,
		row_id TEXT NOT NULL CHECK (
			length(row_id) BETWEEN 1 AND 128 AND
			row_id NOT GLOB '*[^A-Za-z0-9._-]*' AND
			row_id GLOB '[A-Za-z0-9]*'
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
	'CREATE INDEX main._replica_row_facts_authority_sequence ON _replica_row_facts(authority_sequence)',
	// One local intent queue with one strictly increasing local sequence, so a
	// sealed batch has a stable order without a cross-relation invariant to keep.
	`CREATE TABLE main._replica_row_outbox (
		local_sequence INTEGER PRIMARY KEY CHECK (local_sequence > 0),
		namespace TEXT NOT NULL,
		table_name TEXT NOT NULL,
		row_id TEXT NOT NULL CHECK (
			length(row_id) BETWEEN 1 AND 128 AND
			row_id NOT GLOB '*[^A-Za-z0-9._-]*' AND
			row_id GLOB '[A-Za-z0-9]*'
		),
		verb TEXT NOT NULL CHECK (verb IN ('patch', 'delete')),
		patch TEXT,
		CHECK (
			(verb = 'patch' AND patch IS NOT NULL AND json_valid(patch)) OR
			(verb = 'delete' AND patch IS NULL)
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

/**
 * Every relation a current replica file owns.
 *
 * The scalar relations live under the reserved `_replica_` prefix so no Lens
 * table can ever name one: a table name must start with a letter (ADR-0178), so
 * a leading underscore is unrepresentable in an address. That is what makes it
 * safe for a trusted inspection host to install connection-local TEMP views
 * named after Lens tables without any risk of shadowing internal storage.
 *
 * The two `document_` relations are the exception, and deliberately so: the row
 * document subsystem is being reworked separately, so its physical names stay
 * put for now. Until they move, the table-name grammar keeps a Lens
 * from claiming those bare names.
 */
export const REPLICA_TABLES = [
	'_replica_metadata',
	'_replica_row_facts',
	'_replica_row_outbox',
	'document_updates',
	'document_publication',
] as const;

export function createReplicaSchema(
	database: SqliteDatabase,
	replicaId: string,
): void {
	for (const statement of SCHEMA) database.run(statement);
	database.run(
		`INSERT INTO main._replica_metadata (
			singleton, format_version, replica_id, attached_deployment,
			attached_principal, last_applied_authority_sequence,
			last_sealed_batch_sequence
		) VALUES (1, ?, ?, NULL, NULL, 0, 0)`,
		[REPLICA_FORMAT_VERSION, replicaId],
	);
}
