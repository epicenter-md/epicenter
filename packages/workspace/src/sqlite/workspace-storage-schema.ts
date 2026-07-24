import {
	type SqliteDatabase,
	StorageUpgradeRequiredError,
} from '@epicenter/sqlite';
import {
	initializeSqliteDocumentLogSchema,
	inspectSqliteDocumentLogSchema,
	SQLITE_DOCUMENT_LOG_SCHEMA_OBJECTS,
} from '../document-provider/sqlite-document-log.js';
import {
	CURRENT_STATE_REPLICA_SCHEMA_OBJECTS,
	initializeCurrentStateReplicaSchema,
	inspectCurrentStateReplicaSchema,
} from './current-state-replica.js';
import {
	initializeLocalWorkspaceStorage,
	inspectLocalWorkspaceStorage,
	LOCAL_WORKSPACE_STORAGE_SCHEMA_OBJECTS,
} from './local-workspace-storage.js';

/** Validate every owner in one workspace store before changing any of them. */
export function initializeWorkspaceStorageSchema(
	database: SqliteDatabase,
	kind: 'device' | 'account',
): void {
	const scalarState =
		kind === 'account'
			? inspectCurrentStateReplicaSchema(database)
			: inspectLocalWorkspaceStorage(database);
	const documentState = inspectSqliteDocumentLogSchema(database);
	if (scalarState !== documentState) {
		throw new StorageUpgradeRequiredError(
			`${kind === 'account' ? 'Account' : 'Device'} workspace storage`,
			'scalar and document schemas do not describe the same store generation',
		);
	}
	const allowedObjects = new Set<string>();
	if (scalarState === 'current') {
		for (const { type, name } of SQLITE_DOCUMENT_LOG_SCHEMA_OBJECTS) {
			allowedObjects.add(`${type}:${name}`);
		}
		const scalarObjects =
			kind === 'account'
				? CURRENT_STATE_REPLICA_SCHEMA_OBJECTS
				: LOCAL_WORKSPACE_STORAGE_SCHEMA_OBJECTS;
		for (const { type, name } of scalarObjects) {
			allowedObjects.add(`${type}:${name}`);
		}
	}
	const extraObjects = database
		.all<{ type: string; name: string }>(
			`SELECT type, name FROM sqlite_master
			 WHERE type IN ('table', 'index', 'trigger', 'view')
			   AND name NOT LIKE 'sqlite_%'
			 ORDER BY type, name`,
		)
		.filter(({ type, name }) => !allowedObjects.has(`${type}:${name}`));
	if (extraObjects.length > 0) {
		throw new StorageUpgradeRequiredError(
			`${kind === 'account' ? 'Account' : 'Device'} workspace storage`,
			`unrecognized objects prevent opening: ${extraObjects
				.map(({ name }) => name)
				.join(', ')}`,
		);
	}

	database.transaction(() => {
		if (kind === 'account') initializeCurrentStateReplicaSchema(database);
		else initializeLocalWorkspaceStorage(database);
		initializeSqliteDocumentLogSchema(database);
	});
}
