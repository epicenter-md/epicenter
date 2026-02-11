/**
 * Workspace Definition Types
 *
 * This module provides the core WorkspaceDefinition type that describes
 * the structure of a workspace (name, tables, kv).
 *
 * @module
 */

import type { Icon, KvField, TableDefinition } from './fields/types';

// ─────────────────────────────────────────────────────────────────────────────
// Workspace Definition Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Complete workspace definition using arrays for tables and kv.
 *
 * The standard format where:
 * - `id` is the unique workspace identifier (e.g., 'epicenter.whispering')
 * - `tables` is an array of `TableDefinition` (each with its own `id`)
 * - `kv` is an array of `KvField` (the field's `id` serves as the key)
 *
 * @example
 * ```typescript
 * const definition = defineWorkspace({
 *   id: 'epicenter.blog',
 *   name: 'My Blog',
 *   description: 'Personal blog workspace',
 *   icon: 'emoji:📝',
 *   tables: [
 *     table({ id: 'posts', name: 'Posts', fields: [id(), text({ id: 'title' }), select({ id: 'status', options: ['draft', 'published'] })] }),
 *   ],
 *   kv: [
 *     select({ id: 'theme', name: 'Theme', options: ['light', 'dark'] }),
 *     integer({ id: 'fontSize', name: 'Font Size', default: 14 }),
 *   ],
 * });
 * ```
 */
export type WorkspaceDefinition<
	TTableDefinitions extends readonly TableDefinition[] = TableDefinition[],
	TKvFields extends readonly KvField[] = KvField[],
> = {
	/** Unique workspace identifier (e.g., 'epicenter.whispering') */
	id: string;
	/** Display name of the workspace */
	name: string;
	/** Description of the workspace */
	description: string;
	/** Icon for the workspace - tagged string format 'type:value' or null */
	icon: Icon | null;
	/** Table definitions as array (each TableDefinition has its own id) */
	tables: TTableDefinitions;
	/** KV fields directly (no wrapper, field.id is the key) */
	kv: TKvFields;
};

/**
 * Type inference helper for workspace definitions.
 *
 * Applies defaults for optional fields:
 * - `description` defaults to empty string
 * - `icon` defaults to null
 *
 * @example
 * ```typescript
 * const definition = defineWorkspace({
 *   id: 'epicenter.blog',
 *   name: 'Blog',
 *   tables: [table({ id: 'posts', name: 'Posts', fields: [id(), text({ id: 'title' })] })],
 *   kv: [select({ id: 'theme', options: ['light', 'dark'] })],
 * });
 * ```
 */
export function defineWorkspace<
	const TTableDefinitions extends readonly TableDefinition[],
	const TKvFields extends readonly KvField[],
>(
	definition: WorkspaceDefinition<TTableDefinitions, TKvFields> & {
		description?: string;
	},
): WorkspaceDefinition<TTableDefinitions, TKvFields> {
	return {
		id: definition.id,
		name: definition.name,
		description: definition.description ?? '',
		icon: definition.icon ?? null,
		tables: definition.tables,
		kv: definition.kv,
	};
}
