/**
 * Dynamic Workspace - Row-Level YKeyValueLww API
 *
 * A unified workspace implementation with:
 * - Row-level LWW (Last-Write-Wins) CRDT storage via YKeyValueLww
 * - External schema with validation (definition passed in)
 * - Extension system for persistence, sync, and SQLite
 *
 * Y.Doc structure:
 * ```
 * Y.Doc (guid = definition.id, gc: true)
 * +-- Y.Array('table:posts')  <- Table data (rows as LWW entries)
 * +-- Y.Array('table:users')  <- Another table
 * +-- Y.Array('kv')           <- Workspace-level key-values
 * ```
 *
 * @packageDocumentation
 */

// ════════════════════════════════════════════════════════════════════════════
// WORKSPACE API (builder pattern)
// ════════════════════════════════════════════════════════════════════════════

export type { WorkspaceDefinition } from './schema/workspace-definition';
// The builder pattern API
export { createWorkspace } from './workspace/create-workspace';
export type {
	ExtensionContext,
	ExtensionFactory,
	ExtensionFactoryMap,
	InferExtensionExports,
	WorkspaceClient,
	WorkspaceClientBuilder,
} from './workspace/types';
// Workspace definition helpers
export { defineWorkspace } from './workspace/workspace';

// ════════════════════════════════════════════════════════════════════════════
// SHARED UTILITIES (also exported from root for convenience)
// ════════════════════════════════════════════════════════════════════════════

// Action system
export type { Action, Actions, Mutation, Query } from '../shared/actions';
export {
	defineMutation,
	defineQuery,
	isAction,
	isMutation,
	isQuery,
	iterateActions,
} from '../shared/actions';
// Error types
export type { ExtensionError } from '../shared/errors';
export { ExtensionErr } from '../shared/errors';
// Lifecycle utilities (re-exported for extension authors)
export {
	defineExports,
	type Lifecycle,
	type MaybePromise,
} from '../shared/lifecycle';
// Core field factories for programmatic schema creation
export {
	boolean,
	date,
	id,
	integer,
	json,
	real,
	select,
	table,
	tags,
	text,
} from './schema/fields/factories';
export { isNullableField } from './schema/fields/helpers';
// ID type and helpers (needed for type assertions with browser converters)
export type { Id } from './schema/fields/id';
export { generateId, Id as createId } from './schema/fields/id';
// Row and field types
export type {
	CellValue,
	Field,
	Icon,
	IconType,
	KvField,
	KvValue,
	PartialRow,
	Row,
} from './schema/fields/types';
export {
	createIcon,
	isIcon,
	normalizeIcon,
	parseIcon,
} from './schema/fields/types';

// ════════════════════════════════════════════════════════════════════════════
// Y.DOC STORAGE KEYS
// ════════════════════════════════════════════════════════════════════════════

export type { KvKey, TableKey as TableKeyType } from '../shared/ydoc-keys';
// Y.Doc array key conventions (for direct Y.Doc access / custom providers)
export { KV_KEY, TableKey } from '../shared/ydoc-keys';

// ════════════════════════════════════════════════════════════════════════════
// TABLES & KV
// ════════════════════════════════════════════════════════════════════════════

// KV store (YKeyValueLww-based)
export { createKv, type Kv } from './kv/create-kv';
export { createKvHelper, type KvHelper } from './kv/kv-helper';

// Tables API (YKeyValueLww-based row-level storage)
export {
	createTables,
	type GetResult,
	type InvalidRowResult,
	type RowResult,
	type TableHelper,
	type Tables,
	type TablesFunction,
	type ValidRowResult,
} from './tables/create-tables';

export {
	type ChangedRowIds,
	createTableHelper,
	type DeleteManyResult,
	type DeleteResult,
	type NotFoundResult,
	type UpdateManyResult,
	type UpdateResult,
	type ValidationError,
} from './tables/table-helper';
