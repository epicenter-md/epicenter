/**
 * Index type system for vault.
 * Indexes are synchronized snapshots of YJS data optimized for specific query patterns.
 */

import type { Db } from './db/core';
import type { WorkspaceSchema } from './schema';
import type { EpicenterDir, StorageDir } from './types';

/**
 * Index function type - receives IndexContext and returns IndexExports.
 *
 * An index is a function that sets up synchronization between YJS and some external storage
 * or query interface (SQLite, markdown files, vector database, etc.).
 *
 * Consistent with the Provider pattern, the function itself is called an "Index".
 *
 * @example
 * ```typescript
 * // Simple synchronous index
 * const myIndex: Index<MySchema, MyExports> = ({ id, db }) => {
 *   return defineIndex({
 *     destroy: () => { },
 *     // ... other exports
 *   });
 * };
 *
 * // Async index
 * const myAsyncIndex: Index<MySchema, MyExports> = async ({ id, db }) => {
 *   await setupSomething();
 *   return defineIndex({
 *     destroy: () => { },
 *     // ... other exports
 *   });
 * };
 * ```
 */
export type Index<
	TSchema extends WorkspaceSchema = WorkspaceSchema,
	TExports extends IndexExports = IndexExports,
> = (context: IndexContext<TSchema>) => TExports | Promise<TExports>;

/**
 * Context provided to each index factory function.
 *
 * Provides workspace metadata, schema, and database instance that indexes sync with.
 *
 * @property id - The workspace ID (e.g., 'blog', 'content-hub')
 * @property indexId - The index identifier from the workspace's `indexes` object (e.g., 'sqlite', 'markdown', 'markdownDocs')
 * @property schema - The workspace schema (table definitions)
 * @property db - The Epicenter database instance containing YJS-backed tables
 * @property storageDir - Absolute storage directory path resolved from epicenter config
 *   - Node.js: Resolved to absolute path (defaults to `process.cwd()` if not specified in config)
 *   - Browser: `undefined` (filesystem operations not available)
 * @property epicenterDir - Absolute path to the `.epicenter` directory
 *   - Computed as `path.join(storageDir, '.epicenter')`
 *   - `undefined` in browser environment
 *
 * @example Creating an index with IndexContext
 * ```typescript
 * export function sqliteIndex<TSchema extends WorkspaceSchema>(
 *   { id, indexId, schema, db, epicenterDir }: IndexContext<TSchema>
 * ) {
 *   // indexId: The identifier from indexes object (e.g., 'sqlite', 'markdownDocs')
 *   // Use schema for type conversions: convertWorkspaceSchemaToDrizzle(schema)
 *   // Use epicenterDir for file paths: path.join(epicenterDir, `${id}.db`)
 *   // Use db to observe table changes
 * }
 * ```
 */
export type IndexContext<TSchema extends WorkspaceSchema = WorkspaceSchema> = {
	id: string;
	indexId: string;
	schema: TSchema;
	db: Db<TSchema>;
	storageDir: StorageDir | undefined;
	epicenterDir: EpicenterDir | undefined;
};

/**
 * Index exports type - an object with cleanup function and any exported resources
 *
 * Indexes set up observers on YJS documents and export resources like:
 * - Database instances (SQLite, etc.)
 * - Query functions
 * - Table references
 * - Any other tools needed to interact with the indexed data
 *
 * All indexes must include destroy() for cleanup. The destroy function can be
 * sync or async; async destroys are properly awaited by the workspace client.
 *
 * You can export anything from an index and it will be fully typed in the actions context.
 * This pattern allows indexes to expose queryable interfaces, helper functions, or any
 * other resources needed by your actions.
 *
 * @example
 * ```typescript
 * // Creating an index - internal resources become exports
 * function sqliteIndex({ id, schema, db }: IndexContext) {
 *   // 1. Create internal resources
 *   const drizzleTables = convertWorkspaceSchemaToDrizzle(schema);
 *   const sqliteDb = drizzle({ client, schema: drizzleTables });
 *
 *   // 2. Set up YJS observers
 *   const unsubPosts = db.posts.observe({
 *     onAdd: (result) => {
 *       if (result.error) {
 *         // Handle validation errors
 *         return;
 *       }
 *       indexPost(result.data);
 *     },
 *     onUpdate: (result) => {
 *       if (result.error) return;
 *       reindexPost(result.data);
 *     },
 *     onDelete: (id) => { removePost(id); },
 *   });
 *
 *   // 3. Export resources via defineIndex()
 *   return defineIndex({
 *     async destroy() {
 *       unsubPosts();
 *       await flushLogs();
 *       cleanupIndex();
 *     },
 *     db: sqliteDb,        // Exported as indexes.sqlite.db
 *     posts: postsTable,   // Exported as indexes.sqlite.posts
 *   });
 * }
 *
 * // Using exported resources in actions
 * const workspace = defineWorkspace({
 *   indexes: {
 *     sqlite: (c) => sqliteIndex(c),
 *   },
 *
 *   exports: ({ indexes }) => ({
 *     getPost: defineQuery({
 *       handler: async ({ id }) => {
 *         // All exported properties are fully typed and available here
 *         return await indexes.sqlite.db
 *           .select()
 *           .from(indexes.sqlite.posts)
 *           .where(eq(indexes.sqlite.posts.id, id));
 *       }
 *     })
 *   })
 * });
 * ```
 */
export type IndexExports = {
	destroy: () => void | Promise<void>;
};

/**
 * A collection of workspace indexes indexed by index name.
 *
 * Each workspace can have multiple indexes (SQLite, markdown, vector, etc.)
 * that sync with the YJS document and provide different access patterns to the data.
 */
export type WorkspaceIndexMap = Record<string, IndexExports>;

/**
 * Define index exports with type safety (identity function)
 *
 * @example
 * ```typescript
 * const sqliteIndexExports = defineIndexExports({
 *   destroy: () => { ... },
 *   db: sqliteDb,
 *   findById: async (id: string) => { ... }
 * })
 * // Type is inferred as { destroy: () => void, db: typeof sqliteDb, findById: (id: string) => Promise<...> }
 * ```
 */
export function defineIndexExports<T extends IndexExports>(exports: T): T {
	return exports;
}
