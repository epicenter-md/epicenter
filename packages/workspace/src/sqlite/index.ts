/**
 * Typed SQLite application records for the greenfield workspace API.
 *
 * This subpath deliberately excludes the legacy Yjs record implementation:
 * SQLite owns records, while Yjs remains a separate child-document concern.
 */

export {
	type AsyncTable,
	type AsyncTables,
	type AsyncWorkspace,
	asyncWorkspaceHandle,
	type TableCommitDelta,
	type WorkspaceCommitDelta,
	type WorkspaceWriteBatch,
} from './client.js';
export {
	type ApplicationDatabase,
	type ApplicationDatabaseOptions,
	type ApplicationLogicalSnapshot,
	type ApplicationMutationContext,
	type ApplicationMutationCoordinator,
	type ApplicationTable,
	type ApplicationTables,
	type ApplicationTransaction,
	ReplicaInvariantViolationError,
} from './database.js';
export {
	type CompiledColumn,
	defineKv,
	defineTable,
	defineWorkspace,
	type Fields,
	type KvDefinition,
	type KvDefinitions,
	type RowFor,
	type TableDefinition,
	type TableDefinitions,
	type WorkspaceDefinition,
} from './definition.js';
export type {
	OpenedDocument,
	WorkspaceDocumentRuntime,
	WorkspaceDocumentSession,
	WorkspaceDocuments,
} from './document-client.js';
export {
	type DocumentFormat,
	type DocumentHandle,
	document,
} from './document-format.js';
export {
	type DocumentReference,
	type HistoricalDocumentDefinition,
	historicalDocument,
} from './document-reference.js';
export type {
	OpenedWorkspace,
	StandaloneWorkspace,
	WorkspaceKvMount,
	WorkspaceReplica,
} from './open.js';
export {
	defineRecordsMigration,
	defineRecordsMigrations,
} from './records-migration.js';
export { renderHistoricalSchemaModule } from './render-historical-schema.js';
export type { ReplicaSyncPort } from './replica.js';
export {
	type CreateHttpReplicaSyncPortOptions,
	createHttpReplicaSyncPort,
} from './replica-http.js';
