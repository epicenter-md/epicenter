/**
 * Schema-opaque canonical records and release-local workspace lenses.
 *
 * `runtime.open(definition)` binds release-local table and KV lenses to the
 * canonical row store. Browser and desktop runtimes return the stable handle
 * synchronously; its `opened` promise reports the one storage-opening attempt.
 * Every ordinary row owns one lazy document capability.
 */

export {
	type DocumentConnection,
	type DocumentConnectionStatus,
	rowDocumentConnection,
} from '../document-provider/connection/index.js';
export type { RowDocument } from '../document-provider/runtime/index.js';
export {
	isWorkspaceStorageHeldError,
	isWorkspaceStorageMovedError,
} from './browser-runtime-protocol.js';
export type {
	LogicalWorkspaceCopy,
	LogicalWorkspaceExport,
	LogicalWorkspaceRow,
} from './canonical-addition.js';
export type {
	WorkspaceSync,
	WorkspaceSyncPendingReason,
	WorkspaceSyncRecoveryReason,
	WorkspaceSyncSettlement,
	WorkspaceSyncStatus,
} from './canonical-sync-supervisor.js';
export { CurrentStateTransportInterruption } from './current-state-transport.js';
export {
	type KvDefinitions,
	KvReadError,
	type KvValues,
	KvWriteError,
} from './kv-definition.js';
export {
	type ConstrainedChanges,
	type CreateInputFor,
	defineTable,
	type JsonObject,
	type JsonValue,
	type RowFor,
	RowLensError,
	type RowLensIssue,
	type TableLensDefinition,
	type TableLensDefinitions,
} from './lens-definition.js';
export type {
	WorkspaceHandle,
	WorkspaceKv,
	WorkspaceRuntime,
	WorkspaceSql,
	WorkspaceTables,
} from './runtime.js';
export {
	defineWorkspace,
	type WorkspaceDefinition,
} from './runtime-definition.js';
