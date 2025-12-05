import type { WorkspaceExports } from '../actions';
import type { WorkspaceBlobs } from '../blobs';
import type { Db } from '../db/core';
import type { Index, WorkspaceIndexMap } from '../indexes';
import type { Provider } from '../provider';
import type { WorkspaceSchema, WorkspaceValidators } from '../schema';
import type { EpicenterDir, StorageDir } from '../types';

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
 * const epicenter = await createEpicenterClient({
 *   workspaces: [blogWorkspace, authWorkspace]
 * });
 *
 * // Each workspace is accessible by its id:
 * epicenter.blog.createPost(...)  // blogWorkspace exports
 * epicenter.auth.login(...)       // authWorkspace exports
 * ```
 *
 * ## Workspace Structure
 *
 * Each workspace is a self-contained module with:
 * - **tables**: Column schemas (pure JSON, no Drizzle)
 * - **indexes**: Synchronized snapshots for querying (SQLite, markdown, vector, etc.)
 * - **exports**: Actions and utilities with access to tables and indexes
 *
 * ## Data Flow
 *
 * **Writes**: Go to YJS document → auto-sync to all indexes
 * ```typescript
 * db.posts.set({ id: '1', title: 'Hello' });
 * // YJS updated → SQLite synced → Markdown synced → Vector synced
 * ```
 *
 * **Reads**: Query indexes directly
 * ```typescript
 * await indexes.sqlite.posts.select().where(...);
 * await indexes.vector.search('semantic query');
 * ```
 *
 * @example
 * ```typescript
 * const blogWorkspace = defineWorkspace({
 *   id: 'blog',
 *
 *   schema: {
 *     posts: {
 *       // id is auto-included, no need to specify
 *       title: text(),
 *       content: ytext({ nullable: true }),
 *       category: select({ options: ['tech', 'personal'] }),
 *       views: integer({ default: 0 }),
 *     }
 *   },
 *
 *   indexes: {
 *     sqlite: (c) => sqliteIndex(c),
 *     markdown: markdownIndex,  // Uses all defaults! (directory defaults to './blog')
 *     // Or explicit: (context) => markdownIndex(context)
 *     // Or custom directory: (context) => markdownIndex(context, { directory: './data' })
 *     // Or custom serializers: (context) => markdownIndex(context, { serializers: {...} })
 *   },
 *
 *   providers: [
 *     ({ ydoc }) => {
 *       // Set up persistence
 *       new IndexeddbPersistence('blog', ydoc);
 *     },
 *   ],
 *
 *   exports: ({ db, indexes }) => ({
 *     getPublishedPosts: defineQuery({
 *       handler: async () => {
 *         return await indexes.sqlite.posts
 *           .select()
 *           .where(isNotNull(indexes.sqlite.posts.publishedAt))
 *       }
 *     }),
 *
 *     createPost: defineMutation({
 *       input: Type.Object({ title: Type.String() }),
 *       handler: async ({ title }) => {
 *         const post = {
 *           id: generateId(),
 *           title,
 *           content: null,
 *           category: 'tech',
 *           views: 0,
 *         };
 *         db.posts.set(post);
 *         return post;
 *       }
 *     })
 *   }),
 * });
 * ```
 */
export function defineWorkspace<
	const TDeps extends readonly AnyWorkspaceConfig[],
	const TId extends string,
	TWorkspaceSchema extends WorkspaceSchema,
	const TIndexResults extends WorkspaceIndexMap,
	TExports extends WorkspaceExports,
>(
	workspace: WorkspaceConfig<
		TDeps,
		TId,
		TWorkspaceSchema,
		TIndexResults,
		TExports
	>,
): WorkspaceConfig<TDeps, TId, TWorkspaceSchema, TIndexResults, TExports> {
	// Validate workspace ID
	if (!workspace.id || typeof workspace.id !== 'string') {
		throw new Error('Workspace must have a valid string ID');
	}

	// Validate dependencies
	if (workspace.dependencies) {
		if (!Array.isArray(workspace.dependencies)) {
			throw new Error('Dependencies must be an array of workspace configs');
		}

		for (const dep of workspace.dependencies) {
			if (!dep || typeof dep !== 'object' || !dep.id) {
				throw new Error(
					'Invalid dependency: dependencies must be workspace configs with id',
				);
			}
		}
	}

	return workspace;
}

/**
 * Workspace configuration
 *
 * Fully-featured workspace configuration used for defining workspaces and their dependencies.
 *
 * ## Dependency Constraint
 *
 * The `dependencies` field uses `AnyWorkspaceConfig[]` as a minimal constraint.
 * This prevents infinite type recursion while providing type information for action access.
 *
 * By using `AnyWorkspaceConfig` (which only includes `id` and `actions`), we stop
 * recursive type inference. Without this constraint, TypeScript would try to infer dependencies
 * of dependencies infinitely, causing "Type instantiation is excessively deep" errors.
 *
 * ## Runtime vs Type-level
 *
 * At runtime, all workspace configs have full properties (schema, indexes, etc.).
 * The minimal constraint is purely for type inference. The flat/hoisted dependency resolution
 * ensures all workspaces are initialized correctly.
 */
export type WorkspaceConfig<
	TDeps extends readonly AnyWorkspaceConfig[] = readonly AnyWorkspaceConfig[],
	TId extends string = string,
	TWorkspaceSchema extends WorkspaceSchema = WorkspaceSchema,
	TIndexResults extends WorkspaceIndexMap = WorkspaceIndexMap,
	TExports extends WorkspaceExports = WorkspaceExports,
> = {
	id: TId;
	schema: TWorkspaceSchema;
	dependencies?: TDeps;
	indexes: {
		[K in keyof TIndexResults]: Index<TWorkspaceSchema, TIndexResults[K]>;
	};
	providers?: Provider[];
	/**
	 * Factory function that creates workspace exports (actions, utilities, etc.)
	 *
	 * @param context.schema - The workspace schema (table definitions)
	 * @param context.db - Epicenter database API for direct table operations
	 * @param context.validators - Schema validators for runtime validation and arktype composition
	 * @param context.indexes - Index-specific exports (queries, sync operations, etc.)
	 * @param context.workspaces - Exports from dependency workspaces (if any)
	 * @param context.blobs - Blob storage for binary files, namespaced by table
	 *
	 * @example
	 * ```typescript
	 * exports: ({ schema, db, validators, indexes, blobs }) => ({
	 *   // Expose schema for type inference in external scripts
	 *   schema,
	 *
	 *   // Expose db for direct access
	 *   db,
	 *
	 *   // Expose validators for external validation (e.g., migration scripts)
	 *   validators,
	 *
	 *   // Define actions using db operations
	 *   createPost: db.posts.insert,
	 *   getPost: db.posts.get,
	 *
	 *   // Expose index operations
	 *   pullToMarkdown: indexes.markdown.pullToMarkdown,
	 *
	 *   // Store and retrieve binary files
	 *   uploadAttachment: (filename, data) => blobs.posts.put(filename, data),
	 *   getAttachment: (filename) => blobs.posts.get(filename),
	 * })
	 * ```
	 */
	exports: (context: {
		schema: TWorkspaceSchema;
		db: Db<TWorkspaceSchema>;
		validators: WorkspaceValidators<TWorkspaceSchema>;
		workspaces: WorkspacesToExports<TDeps>;
		indexes: TIndexResults;
		blobs: WorkspaceBlobs<TWorkspaceSchema>;
		storageDir: StorageDir | undefined;
		epicenterDir: EpicenterDir | undefined;
	}) => TExports;
};

/**
 * Minimal workspace constraint for generic bounds
 * Use this in `extends` clauses to avoid contravariance issues
 *
 * @example
 * ```typescript
 * function foo<T extends readonly AnyWorkspaceConfig[]>(configs: T) { ... }
 * ```
 */
export type AnyWorkspaceConfig = {
	id: string;
	exports: (context: any) => WorkspaceExports;
};

/**
 * Maps an array of workspace configs to an object of exports keyed by workspace id.
 *
 * Takes an array of workspace dependencies and merges them into a single object where:
 * - Each key is a dependency id
 * - Each value is the exports object from that dependency (actions and utilities)
 *
 * This allows accessing dependency exports as `workspaces.dependencyId.exportName()`.
 *
 * @example
 * ```typescript
 * // Given dependency configs:
 * const authWorkspace = defineWorkspace({ id: 'auth', exports: () => ({ login: ..., logout: ..., validateToken: ... }) })
 * const storageWorkspace = defineWorkspace({ id: 'storage', exports: () => ({ upload: ..., download: ..., MAX_FILE_SIZE: ... }) })
 *
 * // WorkspacesToExports<[typeof authWorkspace, typeof storageWorkspace]> produces:
 * {
 *   auth: { login: ..., logout: ..., validateToken: ... },
 *   storage: { upload: ..., download: ..., MAX_FILE_SIZE: ... }
 * }
 * ```
 */
export type WorkspacesToExports<WS extends readonly AnyWorkspaceConfig[]> = {
	[W in WS[number] as W extends { id: infer TId extends string }
		? TId
		: never]: W extends {
		exports: (context: any) => infer TExports extends WorkspaceExports;
	}
		? TExports
		: never;
};
