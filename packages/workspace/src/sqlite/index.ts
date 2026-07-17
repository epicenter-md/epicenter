/**
 * Schema-opaque canonical records and release-local workspace lenses.
 *
 * `runtime.open(definition)` is the only public binding path. This subpath has
 * no KV plane, schema succession, user-data migrations, or raw SQL writes.
 */

export {
	type DocumentContentFor,
	type DocumentDefinition,
	type DocumentDefinitions,
	type DocumentKeyValue,
	DocumentKeyValueError,
	type DocumentKeyValueIssue,
	type DocumentParamsFor,
	type DocumentText,
	document,
} from './document-definition.js';
export {
	body,
	type BodyDefinition,
	type BodyFormat,
} from './body-definition.js';
export {
	type KvDefinitions,
	KvReadError,
	type KvValues,
	KvWriteError,
} from './kv-definition.js';
export {
	type ConstrainedPatch,
	type CreateInputFor,
	defineTable,
	type JsonObject,
	type JsonValue,
	RecordLensError,
	type RecordLensIssue,
	type RowFor,
	type TableLensDefinition,
	type TableLensDefinitions,
} from './lens-definition.js';
export type {
	OpenedWorkspace,
	OpenedWorkspaceBody,
	WorkspaceKv,
	WorkspaceRecords,
	WorkspaceRuntime,
	WorkspaceTables,
} from './runtime.js';
export {
	defineWorkspace,
	type WorkspaceDefinition,
} from './runtime-definition.js';
