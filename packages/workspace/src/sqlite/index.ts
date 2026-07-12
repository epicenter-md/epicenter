/**
 * Typed SQLite application records for the greenfield workspace API.
 *
 * This subpath deliberately excludes the legacy Yjs record implementation:
 * SQLite owns records, while Yjs remains a separate child-document concern.
 */

export {
	type AsyncTable,
	type AsyncTableDoc,
	type AsyncTableDocs,
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
	type Columns,
	type CompiledColumn,
	type DocLayout,
	defineKv,
	defineTable,
	defineWorkspace,
	type EpochMigration,
	type KvDefinition,
	type KvDefinitions,
	type LogicalRow,
	type MigrationStep,
	type MigrationTx,
	type RowFor,
	type RowRef,
	type TableDefinition,
	type TableDefinitions,
	type TableOptions,
	type WorkspaceDefinition,
} from './definition.js';
export type {
	OpenedWorkspace,
	StandaloneWorkspace,
	WorkspaceKvMount,
	WorkspaceReplica,
} from './open.js';
export type { ReplicaSyncPort } from './replica.js';
export {
	type CreateHttpReplicaSyncPortOptions,
	createHttpReplicaSyncPort,
} from './replica-http.js';
