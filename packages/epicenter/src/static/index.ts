/**
 * Static Workspace API for Epicenter
 *
 * A composable, type-safe API for defining and creating workspaces
 * with versioned tables and KV stores.
 *
 * **Versioning**: Supports field presence detection, asymmetric `_v` (recommended default),
 * and symmetric `_v` patterns. See `.agents/skills/static-workspace-api/SKILL.md` for
 * detailed comparison and best practices.
 *
 * @example
 * ```typescript
 * import { createWorkspace, defineTable, defineKv } from 'epicenter/static';
 * import { type } from 'arktype';
 *
 * // Tables: shorthand for single version
 * const users = defineTable(type({ id: 'string', email: 'string' }));
 *
 * // Tables: builder pattern for multiple versions with migration
 * const posts = defineTable()
 *   .version(type({ id: 'string', title: 'string' }))
 *   .version(type({ id: 'string', title: 'string', views: 'number', _v: '"2"' }))
 *   .migrate((row) => {
 *     if (!('_v' in row)) return { ...row, views: 0, _v: '2' };
 *     return row;
 *   });
 *
 * // KV: shorthand for single version
 * const sidebar = defineKv(type({ collapsed: 'boolean', width: 'number' }));
 *
 * // KV: builder pattern for multiple versions with migration (use _v discriminant)
 * const theme = defineKv()
 *   .version(type({ mode: "'light' | 'dark'" }))
 *   .version(type({ mode: "'light' | 'dark' | 'system'", fontSize: 'number', _v: '"2"' }))
 *   .migrate((v) => {
 *     if (!('_v' in v)) return { ...v, fontSize: 14, _v: '2' };
 *     return v;
 *   });
 *
 * // Create client (synchronous, directly usable)
 * const client = createWorkspace({
 *   id: 'my-app',
 *   tables: { users, posts },
 *   kv: { sidebar, theme },
 * });
 *
 * // Use tables and KV
 * client.tables.posts.set({ id: '1', title: 'Hello', views: 0, _v: '2' });
 * client.kv.set('theme', { mode: 'system', fontSize: 16, _v: '2' });
 *
 * // Or add extensions
 * const clientWithExt = createWorkspace({ id: 'my-app', tables: { posts } })
 *   .withExtensions({ sqlite, persistence });
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
export type { ExtensionError } from '../shared/errors.js';
export { ExtensionErr } from '../shared/errors.js';
// Lifecycle protocol
export {
	defineExports,
	type Lifecycle,
	type MaybePromise,
} from '../shared/lifecycle.js';

// ════════════════════════════════════════════════════════════════════════════
// Y.DOC STORAGE KEYS
// ════════════════════════════════════════════════════════════════════════════

export type { KvKey, TableKey as TableKeyType } from '../shared/ydoc-keys.js';
// Y.Doc array key conventions (for direct Y.Doc access / custom providers)
export { KV_KEY, TableKey } from '../shared/ydoc-keys.js';

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

export { createKv } from './create-kv.js';
export { createTables } from './create-tables.js';

// ════════════════════════════════════════════════════════════════════════════
// Validation Utilities
// ════════════════════════════════════════════════════════════════════════════

export { createUnionSchema } from './schema-union.js';

// ════════════════════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════════════════════

export type {
	DeleteResult,
	// Extension types
	ExtensionContext,
	ExtensionFactory,
	ExtensionMap,
	GetResult,
	InferExtensionExports,
	InferKvValue,
	InferTableRow,
	InvalidRowResult,
	KvBatchTransaction,
	KvChange,
	KvDefinition,
	KvDefinitions,
	KvGetResult,
	KvHelper,
	NotFoundResult,
	// Result types - composed
	RowResult,
	TableBatchTransaction,
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
