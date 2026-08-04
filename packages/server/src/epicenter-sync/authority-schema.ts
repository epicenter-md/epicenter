import {
	type SqliteDatabase,
	type SqliteRow,
	StorageUpgradeRequiredError,
} from '@epicenter/sqlite';

export const AUTHORITY_FORMAT_VERSION = 6;

/**
 * Every relation a current authority store owns.
 *
 * The scalar relations carry the reserved `_authority_` prefix so ownership is
 * readable straight from a schema dump and no unprefixed name can collide with
 * them. The two `document_` relations keep their current names because the row
 * document subsystem is being reworked separately.
 */
const AUTHORITY_TABLES = [
	'_authority_metadata',
	'_authority_replicas',
	'_authority_row_facts',
	'_authority_row_outbox',
	'document_updates',
	'document_versions',
] as const;

/**
 * One relation holds every current row fact. Presence is two-valued and
 * `absent` is a terminal tombstone.
 */
const SCHEMA = [
	`CREATE TABLE main._authority_metadata (
		singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
		format_version INTEGER NOT NULL,
		next_sequence INTEGER NOT NULL CHECK (next_sequence >= 1)
	) STRICT`,
	`CREATE TABLE main._authority_replicas (
		replica_id TEXT PRIMARY KEY CHECK (
			length(replica_id) BETWEEN 1 AND 128 AND
			replica_id NOT GLOB '*[^A-Za-z0-9._-]*' AND
			replica_id GLOB '[A-Za-z0-9]*'
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
	`CREATE TABLE main._authority_row_facts (
		namespace TEXT NOT NULL,
		table_name TEXT NOT NULL,
		row_id TEXT NOT NULL CHECK (
			length(row_id) BETWEEN 1 AND 128 AND
			row_id NOT GLOB '*[^A-Za-z0-9._-]*' AND
			row_id GLOB '[A-Za-z0-9]*'
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
	'CREATE UNIQUE INDEX main._authority_row_facts_authority_sequence ON _authority_row_facts(authority_sequence)',
	`CREATE TABLE main._authority_row_outbox (
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
	`CREATE TABLE document_updates (
		namespace TEXT NOT NULL,
		table_name TEXT NOT NULL,
		row_id TEXT NOT NULL CHECK (
			length(row_id) BETWEEN 1 AND 128 AND
			row_id NOT GLOB '*[^A-Za-z0-9._-]*' AND
			row_id GLOB '[A-Za-z0-9]*'
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
			length(row_id) BETWEEN 1 AND 128 AND
			row_id NOT GLOB '*[^A-Za-z0-9._-]*' AND
			row_id GLOB '[A-Za-z0-9]*'
		),
		version INTEGER NOT NULL CHECK (version > 0),
		PRIMARY KEY (namespace, table_name, row_id)
	) WITHOUT ROWID, STRICT`,
] as const;

type MetadataRow = SqliteRow & { format_version: number };

/** Initialize a fresh authority store or refuse a non-current physical format. */
export function initializeAuthoritySchema(database: SqliteDatabase): void {
	// "Fresh" must mean the store holds nothing, not merely nothing this format
	// recognizes. Matching only the current names would treat a store full of a
	// previous format's relations as empty and build a second schema beside it.
	const present = database
		.all<SqliteRow & { name: string }>(
			`SELECT name FROM main.sqlite_schema
			WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
		)
		.map((row) => row.name);
	if (present.length === 0) {
		database.transaction(() => {
			for (const statement of SCHEMA) database.run(statement);
			database.run(
				'INSERT INTO main._authority_metadata (singleton, format_version, next_sequence) VALUES (1, ?, 1)',
				[AUTHORITY_FORMAT_VERSION],
			);
		});
		return;
	}
	const expected = new Set<string>(AUTHORITY_TABLES);
	if (
		present.length !== expected.size ||
		!present.every((name) => expected.has(name))
	) {
		throw new StorageUpgradeRequiredError(
			'Epicenter sync authority',
			'authority schema is not the current format',
		);
	}
	const metadata = database.all<MetadataRow>(
		'SELECT format_version FROM main._authority_metadata WHERE singleton = 1',
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
