/**
 * defineWorkspace() - Pure definition of a workspace schema.
 *
 * A passthrough for type inference and composability. The returned definition
 * can be reused across multiple createWorkspace() calls or shared between modules.
 *
 * @example
 * ```typescript
 * import { defineWorkspace, createWorkspace, defineTable } from 'epicenter/static';
 *
 * const posts = defineTable(type({ id: 'string', title: 'string' }));
 *
 * // Reusable definition with inferred types
 * const workspace = defineWorkspace({ id: 'my-app', tables: { posts } });
 * const client = createWorkspace(workspace);
 *
 * // Or pass config directly (same result, less composable)
 * const client = createWorkspace({ id: 'my-app', tables: { posts } });
 * ```
 */

import type {
	KvDefinitions,
	TableDefinitions,
	WorkspaceDefinition,
} from './types.js';

/**
 * Define a workspace schema for type inference and composability.
 *
 * This is a pure passthrough that returns the input with proper generic inference.
 * Use when you want to share a workspace definition across modules or need
 * TypeScript to infer the full generic signature.
 */
export function defineWorkspace<
	TId extends string,
	TTableDefinitions extends TableDefinitions = Record<string, never>,
	TKvDefinitions extends KvDefinitions = Record<string, never>,
>(config: {
	id: TId;
	tables?: TTableDefinitions;
	kv?: TKvDefinitions;
}): WorkspaceDefinition<TId, TTableDefinitions, TKvDefinitions> {
	return {
		id: config.id,
		tables: (config.tables ?? {}) as TTableDefinitions,
		kv: (config.kv ?? {}) as TKvDefinitions,
	};
}

// Re-export types for convenience
export type { WorkspaceDefinition };
