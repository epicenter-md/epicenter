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
	type DocumentParamsFor,
	type DocumentText,
	document,
} from './document-definition.js';
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
	WorkspaceRecords,
	WorkspaceRuntime,
	WorkspaceTables,
} from './runtime.js';
export {
	defineWorkspace,
	type WorkspaceDefinition,
} from './runtime-definition.js';
