/**
 * Workspace API for Epicenter
 *
 * A composable, type-safe API for defining and creating workspaces
 * with versioned tables and KV stores.
 *
 * Tables use `_v: number` as a discriminant field for versioning and migration.
 * KV stores use `defineKv(schema, defaultValue)` with validate-or-default semantics.
 *
 * @example
 * ```typescript
 * import { createWorkspace, defineTable, defineKv } from '@epicenter/workspace';
 * import { type } from 'arktype';
 *
 * // Tables: shorthand for single version
 * const users = defineTable(type({ id: 'string', email: 'string', _v: '1' }));
 *
 * // Tables: variadic for multiple versions with migration
 * const posts = defineTable(
 *   type({ id: 'string', title: 'string', _v: '1' }),
 *   type({ id: 'string', title: 'string', views: 'number', _v: '2' }),
 * ).migrate((row) => {
 *   switch (row._v) {
 *     case 1: return { ...row, views: 0, _v: 2 };
 *     case 2: return row;
 *   }
 * });
 *
 * // KV: schema + default value (no versioning)
 * const sidebar = defineKv(type('boolean'), false);
 * const fontSize = defineKv(type('number'), 14);
 *
 * // Create client (synchronous, directly usable)
 * const client = createWorkspace({
 *   id: 'my-app',
 *   tables: { users, posts },
 *   kv: { sidebar, fontSize },
 * });
 *
 * // Use tables and KV
 * client.tables.posts.set({ id: '1', title: 'Hello', views: 0, _v: 2 });
 * client.kv.set('fontSize', 16);
 *
 * // Or add extensions
 * const clientWithExt = createWorkspace({ id: 'my-app', tables: { posts } })
 *   .withExtension('sqlite', sqlite)
 *   .withExtension('persistence', persistence);
 *
 * // Cleanup
 * await client.destroy();
 * ```
 *
 * @packageDocumentation
 */

// ════════════════════════════════════════════════════════════════════════════
// SHARED UTILITIES (also exported from root for convenience)
// ════════════════════════════════════════════════════════════════════════════

// Action system
export type { Action, Actions, Mutation, Query } from '../shared/actions.js';
export {
	defineMutation,
	defineQuery,
	isAction,
	isMutation,
	isQuery,
	iterateActions,
} from '../shared/actions.js';
// Error types
export { ExtensionError } from '../shared/errors.js';
// Lifecycle protocol
export type {
	DocumentContext,
	Extension,
	Lifecycle,
	MaybePromise,
} from './lifecycle.js';

// ════════════════════════════════════════════════════════════════════════════
// Y.DOC STORAGE KEYS
// ════════════════════════════════════════════════════════════════════════════

export type { KvKey, TableKey as TableKeyType } from './ydoc-keys.js';
// Y.Doc array key conventions (for direct Y.Doc access / custom providers)
export { KV_KEY, TableKey } from './ydoc-keys.js';

// ════════════════════════════════════════════════════════════════════════════
// Schema Definitions (Pure)
// ════════════════════════════════════════════════════════════════════════════

export { defineKv } from './define-kv.js';
export { defineTable } from './define-table.js';
export { defineWorkspace } from './define-workspace.js';

// ════════════════════════════════════════════════════════════════════════════
// Workspace Creation
// ════════════════════════════════════════════════════════════════════════════

export { createWorkspace } from './create-workspace.js';

// ════════════════════════════════════════════════════════════════════════════
// Lower-Level APIs (Bring Your Own Y.Doc)
// ════════════════════════════════════════════════════════════════════════════

export { createAwareness } from './create-awareness.js';
export { createKv } from './create-kv.js';
export { createTables } from './create-tables.js';

// ════════════════════════════════════════════════════════════════════════════
// Introspection
// ════════════════════════════════════════════════════════════════════════════

export type {
	ActionDescriptor,
	SchemaDescriptor,
	WorkspaceDescriptor,
} from './describe-workspace.js';
export { describeWorkspace } from './describe-workspace.js';

// ════════════════════════════════════════════════════════════════════════════
// Validation Utilities
// ════════════════════════════════════════════════════════════════════════════

export { createUnionSchema } from './schema-union.js';

// ════════════════════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════════════════════

export type {
	// Any-typed client (for duck-typing in CLI/server)
	AnyWorkspaceClient,
	// Awareness types
	AwarenessDefinitions,
	AwarenessHelper,
	AwarenessState,
	// Base row type
	BaseRow,
	DeleteResult,
	// Document types
	DocumentConfig,
	DocumentHandle,
	Documents,
	DocumentsHelper,
	// Extension types
	ExtensionContext,
	ExtensionFactory,
	GetResult,
	InferAwarenessValue,
	InferKvValue,
	InferTableRow,
	InvalidRowResult,
	// JSON types (re-exported from wellcrafted/json)
	JsonObject,
	JsonValue,
	KvChange,
	KvDefinition,
	KvDefinitions,
	KvHelper,
	NotFoundResult,
	// Result types - composed
	RowResult,
	// Definition types
	TableDefinition,
	// Map types
	TableDefinitions,
	// Helper types
	TableHelper,
	TablesHelper,
	UpdateResult,
	// Result types - building blocks
	ValidRowResult,
	WorkspaceClient,
	WorkspaceClientBuilder,
	WorkspaceClientWithActions,
	// Workspace types
	WorkspaceDefinition,
} from './types.js';
