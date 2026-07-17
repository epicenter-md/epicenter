/**
 * Schema-opaque canonical records and release-local workspace lenses.
 *
 * `runtime.open(definition)` binds release-local table and KV lenses to the
 * canonical row store. Every ordinary row owns one lazy document capability.
 */

export type { RowDocument } from './canonical-documents.js';
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
	RowLensError,
	type RowLensIssue,
	type RowFor,
	type TableLensDefinition,
	type TableLensDefinitions,
} from './lens-definition.js';
export type {
	OpenedWorkspace,
	WorkspaceKv,
	WorkspaceSql,
	WorkspaceRuntime,
	WorkspaceTables,
} from './runtime.js';
export {
	defineWorkspace,
	type WorkspaceDefinition,
} from './runtime-definition.js';
