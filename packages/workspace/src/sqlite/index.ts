/**
 * Typed SQLite application records for the greenfield workspace API.
 *
 * This subpath deliberately excludes the legacy Yjs record implementation:
 * SQLite owns records, while Yjs remains a separate child-document concern.
 */

export {
	type ApplicationDatabase,
	type ApplicationDatabaseOptions,
	type ApplicationKv,
	type ApplicationLogicalSnapshot,
	type ApplicationMutationContext,
	type ApplicationMutationCoordinator,
	type ApplicationTable,
	type ApplicationTables,
	type ApplicationTransaction,
	createApplicationDatabase,
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
