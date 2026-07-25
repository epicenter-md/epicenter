import {
	type SqliteDatabase,
	type SqliteRow,
	StorageUpgradeRequiredError,
} from '@epicenter/sqlite';

export const AUTHORITY_FORMAT_VERSION = 4;

const AUTHORITY_TABLES = [
	'metadata',
	'replicas',
	'row_facts',
	'value_facts',
	'document_updates',
	'document_versions',
] as const;

/**
 * The authority mirrors the replica's split fact relations (ADR-0163,
 * ADR-0164): row facts carry a row id, an object payload, and a terminal
 * tombstone; value facts carry any JSON and a reversible unset. Neither relation
 * needs an `address_kind` column or an empty-string row id to say which laws
 * apply, because the relation itself says it.
 *
 * One invariant does span both relations: `authority_sequence` is globally unique
 * and increasing across every fact this authority stores, because the exchange
 * page is a single sequence-ordered stream over the union of the two. SQLite
 * cannot express a cross-relation unique constraint, and the guarantee does not
 * come from one: it comes from `metadata.next_sequence`, which this authority is
 * the only writer of and only ever advances. The per-relation unique indexes
 * below still refuse a duplicate within one relation, which is the failure a
 * paging or fold bug would actually produce.
 */
const SCHEMA = [
	`CREATE TABLE metadata (
		singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
		format_version INTEGER NOT NULL,
		next_sequence INTEGER NOT NULL CHECK (next_sequence >= 1)
	) STRICT`,
	`CREATE TABLE replicas (
		replica_id TEXT PRIMARY KEY CHECK (
			length(replica_id) = 24 AND replica_id NOT GLOB '*[^a-z0-9]*'
		),
		accepted_batch INTEGER NOT NULL CHECK (accepted_batch >= 0),
		request_digest TEXT,
		receipt_sequence INTEGER NOT NULL CHECK (receipt_sequence >= 0),
		CHECK (
			(accepted_batch = 0 AND request_digest IS NULL) OR
			(accepted_batch > 0 AND request_digest IS NOT NULL AND
				length(request_digest) = 64 AND
				request_digest NOT GLOB '*[^a-f0-9]*')
		)
	) WITHOUT ROWID, STRICT`,
	`CREATE TABLE row_facts (
		namespace TEXT NOT NULL,
		table_name TEXT NOT NULL,
		row_id TEXT NOT NULL CHECK (
			length(row_id) = 24 AND row_id NOT GLOB '*[^a-z0-9]*'
		),
		presence TEXT NOT NULL CHECK (presence IN ('present', 'absent')),
		fields TEXT,
		authority_sequence INTEGER NOT NULL CHECK (authority_sequence >= 1),
		PRIMARY KEY (namespace, table_name, row_id),
		CHECK (
			(presence = 'present' AND fields IS NOT NULL AND json_valid(fields)) OR
			(presence = 'absent' AND fields IS NULL)
		)
	) WITHOUT ROWID, STRICT`,
	'CREATE UNIQUE INDEX row_facts_authority_sequence ON row_facts(authority_sequence)',
	`CREATE TABLE value_facts (
		namespace TEXT NOT NULL,
		value_name TEXT NOT NULL,
		presence TEXT NOT NULL CHECK (presence IN ('present', 'absent')),
		content TEXT,
		authority_sequence INTEGER NOT NULL CHECK (authority_sequence >= 1),
		PRIMARY KEY (namespace, value_name),
		CHECK (
			(presence = 'present' AND content IS NOT NULL AND json_valid(content)) OR
			(presence = 'absent' AND content IS NULL)
		)
	) WITHOUT ROWID, STRICT`,
	'CREATE UNIQUE INDEX value_facts_authority_sequence ON value_facts(authority_sequence)',
	`CREATE TABLE document_updates (
		namespace TEXT NOT NULL,
		table_name TEXT NOT NULL,
		row_id TEXT NOT NULL CHECK (
			length(row_id) = 24 AND row_id NOT GLOB '*[^a-z0-9]*'
		),
		update_sequence INTEGER NOT NULL CHECK (update_sequence > 0),
		update_bytes BLOB NOT NULL,
		PRIMARY KEY (namespace, table_name, row_id, update_sequence)
	) WITHOUT ROWID, STRICT`,
	// The per-address acceptance counter behind conditional pulls: it advances
	// with every accepted append, so an unchanged value proves an unchanged
	// document without hydrating or transferring it (ADR-0174).
	`CREATE TABLE document_versions (
		namespace TEXT NOT NULL,
		table_name TEXT NOT NULL,
		row_id TEXT NOT NULL CHECK (
			length(row_id) = 24 AND row_id NOT GLOB '*[^a-z0-9]*'
		),
		version INTEGER NOT NULL CHECK (version > 0),
		PRIMARY KEY (namespace, table_name, row_id)
	) WITHOUT ROWID, STRICT`,
] as const;

type MetadataRow = SqliteRow & { format_version: number };

/** Initialize a fresh authority store or refuse a non-current physical format. */
export function initializeAuthoritySchema(database: SqliteDatabase): void {
	const tables = database.all<SqliteRow & { name: string }>(
		`SELECT name FROM sqlite_schema
		WHERE type = 'table' AND name IN (${AUTHORITY_TABLES.map(() => '?').join(', ')})`,
		AUTHORITY_TABLES,
	);
	if (tables.length === 0) {
		database.transaction(() => {
			for (const statement of SCHEMA) database.run(statement);
			database.run(
				'INSERT INTO metadata (singleton, format_version, next_sequence) VALUES (1, ?, 1)',
				[AUTHORITY_FORMAT_VERSION],
			);
		});
		return;
	}
	if (tables.length !== AUTHORITY_TABLES.length) {
		throw new StorageUpgradeRequiredError(
			'Epicenter sync authority',
			'authority schema is incomplete',
		);
	}
	const metadata = database.all<MetadataRow>(
		'SELECT format_version FROM metadata WHERE singleton = 1',
	)[0];
	if (metadata?.format_version !== AUTHORITY_FORMAT_VERSION) {
		throw new StorageUpgradeRequiredError(
			'Epicenter sync authority',
			metadata === undefined
				? 'metadata singleton is missing'
				: `format ${metadata.format_version} is not supported`,
		);
	}
}
