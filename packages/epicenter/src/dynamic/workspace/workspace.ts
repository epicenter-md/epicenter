/**
 * Workspace definition types for YJS-first collaborative workspaces.
 *
 * This module re-exports from ./schema for backwards compatibility.
 * The canonical definitions live in ./schema/workspace-definition.ts.
 *
 * This module provides:
 * - {@link defineWorkspace} - Type inference helper for workspace definitions
 * - {@link WorkspaceDefinition} - The workspace definition type (name, tables, kv)
 *
 * ## Usage
 *
 * Use `defineWorkspace` to create type-safe workspace definitions:
 *
 * ```typescript
 * const definition = defineWorkspace({
 *   name: 'My Blog',
 *   description: 'Personal blog workspace',
 *   icon: 'emoji:📝',
 *   tables: [
 *     table({ id: 'posts', name: 'Posts', fields: [id(), text({ id: 'title' })] }),
 *   ],
 *   kv: [
 *     select({ id: 'theme', options: ['light', 'dark'] }),
 *   ],
 * });
 * ```
 *
 * To create a workspace client, use `createWorkspace` from `@epicenter/hq/dynamic`:
 *
 * ```typescript
 * import { createWorkspace } from '@epicenter/hq/dynamic';
 *
 * const workspace = createWorkspace(definition).withExtensions({ persistence });
 * ```
 *
 * ## Related Modules
 *
 * - {@link ./types.ts} - WorkspaceClient type definition
 * - {@link ../../dynamic/index.ts} - Dynamic workspace API (createWorkspace)
 *
 * @module
 */

// Re-export from schema for backwards compatibility
export type { WorkspaceDefinition } from '../schema/workspace-definition';
export { defineWorkspace } from '../schema/workspace-definition';
export {
	validateWorkspaceDefinition,
	WorkspaceDefinitionSchema,
	WorkspaceDefinitionValidator,
} from '../schema/workspace-definition-validator';

// ─────────────────────────────────────────────────────────────────────────────
// Y.Doc Structure: YKeyValueLww Arrays
// ─────────────────────────────────────────────────────────────────────────────
//
// HEAD DOC (per workspace, all epochs)
// Y.Map('meta') - Workspace identity (name, icon, description)
// Y.Map('epochs') - Epoch tracking per client
//
// WORKSPACE DOC
// Uses YKeyValueLww for cell-level LWW conflict resolution:
//
// Y.Array('table:{tableName}') - Table data as LWW entries
//   └── { key: 'rowId:fieldId', val: value, ts: timestamp }
//   └── Cell-level timestamps enable clean concurrent field merges
//
// Y.Array('kv') - KV settings as LWW entries
//   └── { key: 'settingId', val: value, ts: timestamp }
//
// Note: Table/KV definitions are static (from code or definition.json),
// NOT stored in Y.Doc. This keeps documents lean and focused on data.
