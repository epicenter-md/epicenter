/**
 * Node/Bun-specific workspace configuration.
 *
 * Uses Node Provider type which includes required filesystem paths.
 */

import type { ActionContracts } from '../actions';
import type { Provider } from '../provider.node';
import type { WorkspaceSchema } from '../schema';
import {
	type ActionsContext,
	type AnyWorkspaceConfig,
	validateWorkspaceConfig,
} from './config.shared';

// Re-export shared types
export type { AnyWorkspaceConfig, WorkspacesToActions } from './config.shared';

/**
 * Define a collaborative workspace with YJS-first architecture.
 *
 * ## What is a Workspace?
 *
 * A workspace is a self-contained domain module that gets composed into an Epicenter.
 * When you create an Epicenter client, each workspace becomes a property on that client:
 *
 * ```typescript
 * const blogWorkspace = defineWorkspace({ id: 'blog', ... });
 * const authWorkspace = defineWorkspace({ id: 'auth', ... });
 *
 * const epicenter = await createWorkspaceClient(blogWorkspace);
 *
 * // Each workspace is accessible by its id:
 * epicenter.createPost(...)  // blogWorkspace exports
 * ```
 *
 * ## Node/Bun-Specific Notes
 *
 * In Node/Bun environments, the exports factory has access to filesystem paths via `paths`:
 * - `paths.project`: Project root directory
 * - `paths.epicenter`: The `.epicenter` directory for internal data
 *
 * @see defineWorkspace in config.browser.ts for browser-specific version
 */
export function defineWorkspace<
	const TDeps extends readonly AnyWorkspaceConfig[],
	const TId extends string,
	TWorkspaceSchema extends WorkspaceSchema,
	const TProviders extends Record<string, Provider<TWorkspaceSchema>>,
	TActions extends ActionContracts,
>(
	workspace: WorkspaceConfig<
		TDeps,
		TId,
		TWorkspaceSchema,
		TProviders,
		TActions
	>,
): WorkspaceConfig<TDeps, TId, TWorkspaceSchema, TProviders, TActions> {
	validateWorkspaceConfig(workspace);
	return workspace;
}

/**
 * Node/Bun workspace configuration.
 *
 * Uses Node Provider type - the exports factory has access to filesystem paths via `paths`:
 * - `paths.project`: Project root directory
 * - `paths.epicenter`: The `.epicenter` directory for internal data
 *
 * ## Provider Type Inference
 *
 * The `TProviders` type parameter captures the actual provider functions you pass.
 * The `exports` factory receives provider exports derived via `InferProviders`:
 * - Provider returns `{ db: Db }` → exports receives `{ db: Db }`
 * - Provider returns `void` → exports receives `Record<string, never>` (empty object)
 * - Provider returns `Promise<{ db: Db }>` → exports receives `{ db: Db }` (unwrapped)
 */
export type WorkspaceConfig<
	TDeps extends readonly AnyWorkspaceConfig[] = readonly AnyWorkspaceConfig[],
	TId extends string = string,
	TWorkspaceSchema extends WorkspaceSchema = WorkspaceSchema,
	TProviders extends Record<string, Provider<TWorkspaceSchema>> = Record<
		string,
		Provider<TWorkspaceSchema>
	>,
	TActions extends ActionContracts = ActionContracts,
> = {
	id: TId;
	tables: TWorkspaceSchema;
	dependencies?: TDeps;
	providers: TProviders;
	/**
	 * Factory function that creates workspace actions (queries, mutations, utilities, etc.)
	 *
	 * @param context.tables - The workspace tables for direct table operations
	 * @param context.schema - The workspace schema (table definitions)
	 * @param context.providers - Provider-specific exports (queries, sync operations, etc.)
	 * @param context.workspaces - Actions from dependency workspaces (if any)
	 * @param context.paths - Filesystem paths (Node/Bun only, undefined in browser)
	 */
	actions: (
		context: ActionsContext<TWorkspaceSchema, TDeps, TProviders>,
	) => TActions;
};
