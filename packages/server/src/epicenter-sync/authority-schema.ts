import {
	type SqliteDatabase,
	type SqliteRow,
	StorageUpgradeRequiredError,
} from '@epicenter/sqlite';

export const AUTHORITY_FORMAT_VERSION = 1;

const AUTHORITY_TABLES = [
	'metadata',
	'replicas',
	'state',
	'document_updates',
] as const;

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
	`CREATE TABLE state (
		address_kind TEXT NOT NULL CHECK (address_kind IN ('row', 'value')),
		qualified_key TEXT NOT NULL,
		row_id TEXT NOT NULL,
		status TEXT NOT NULL CHECK (status IN ('live', 'deleted', 'unset')),
		json_payload TEXT,
		changed_sequence INTEGER NOT NULL CHECK (changed_sequence >= 1),
		PRIMARY KEY (address_kind, qualified_key, row_id),
		CHECK (
			(address_kind = 'row' AND length(row_id) = 24 AND
				row_id NOT GLOB '*[^a-z0-9]*' AND status IN ('live', 'deleted')) OR
			(address_kind = 'value' AND row_id = '' AND status IN ('live', 'unset'))
		),
		CHECK (
			(status = 'live' AND json_payload IS NOT NULL AND json_valid(json_payload)) OR
			(status IN ('deleted', 'unset') AND json_payload IS NULL)
		)
	) WITHOUT ROWID, STRICT`,
	'CREATE UNIQUE INDEX state_changed_sequence ON state(changed_sequence)',
	`CREATE TABLE document_updates (
		qualified_key TEXT NOT NULL,
		row_id TEXT NOT NULL CHECK (
			length(row_id) = 24 AND row_id NOT GLOB '*[^a-z0-9]*'
		),
		update_sequence INTEGER NOT NULL CHECK (update_sequence > 0),
		update_bytes BLOB NOT NULL,
		PRIMARY KEY (qualified_key, row_id, update_sequence)
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
