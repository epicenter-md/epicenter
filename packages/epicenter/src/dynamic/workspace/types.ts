/**
 * Type definitions for the dynamic workspace builder pattern.
 *
 * These types enable the ergonomic builder API where `createWorkspace()` returns
 * a client that IS directly usable AND has `.withExtensions()` for optional chaining.
 *
 * ## Pattern Overview
 *
 * ```typescript
 * // Direct use (no extensions)
 * const workspace = createWorkspace(definition);
 * workspace.tables.get('posts').upsert({...});  // Works immediately!
 *
 * // With extensions (chained)
 * const workspace = createWorkspace(definition)
 *   .withExtensions({ sqlite, persistence });
 * workspace.extensions.sqlite;  // Typed!
 * ```
 *
 * @module
 */

import type * as Y from 'yjs';
import type { Lifecycle } from '../../shared/lifecycle';
import type { Kv } from '../kv/create-kv';
import type { KvField, TableDefinition } from '../schema/fields/types';
import type { WorkspaceDefinition } from '../schema/workspace-definition';
import type { Tables } from '../tables/create-tables';

// ════════════════════════════════════════════════════════════════════════════
// EXTENSION TYPES
// ════════════════════════════════════════════════════════════════════════════

/**
 * Context passed to extension factory functions.
 *
 * Extensions receive typed access to the workspace's Y.Doc, tables, kv,
 * and identity information. This enables extensions to attach functionality
 * like persistence, SQLite queries, or sync with full type safety.
 *
 * @typeParam TTableDefinitions - Array of table definitions for this workspace
 * @typeParam TKvFields - Array of KV field definitions for this workspace
 *
 * @example
 * ```typescript
 * // Destructure only what you need
 * const persistence: ExtensionFactory = ({ ydoc }) => { ... };
 * const sqlite: ExtensionFactory = ({ id, tables }) => { ... };
 * const markdown: ExtensionFactory = ({ ydoc, tables, id }) => { ... };
 * ```
 */
export type ExtensionContext<
	TTableDefinitions extends
		readonly TableDefinition[] = readonly TableDefinition[],
	TKvFields extends readonly KvField[] = readonly KvField[],
> = {
	/** The underlying Y.Doc instance */
	ydoc: Y.Doc;
	/** Workspace identifier (from definition.id) */
	id: string;
	/** The workspace definition with typed tables and kv fields */
	definition: WorkspaceDefinition<TTableDefinitions, TKvFields>;
	/** Typed table helpers */
	tables: Tables<TTableDefinitions>;
	/** Typed KV helper */
	kv: Kv<TKvFields>;
	/** This extension's key from `.withExtensions({ key: ... })` */
	extensionId: string;
};

/**
 * Factory function that creates an extension with lifecycle hooks.
 *
 * All extensions MUST return an object satisfying the Lifecycle protocol:
 * - `whenSynced`: Promise that resolves when the extension is ready
 * - `destroy`: Cleanup function called when workspace is destroyed
 *
 * Use `defineExports()` from `shared/lifecycle.ts` to easily create compliant exports.
 *
 * @typeParam TTableDefinitions - Table definitions this extension accepts
 * @typeParam TKvFields - KV fields this extension accepts
 * @typeParam TExports - The exports returned by this extension (must extend Lifecycle)
 *
 * @example
 * ```typescript
 * const persistence: ExtensionFactory = ({ ydoc }) => {
 *   const provider = new IndexeddbPersistence(ydoc.guid, ydoc);
 *   return defineExports({
 *     provider,
 *     whenSynced: provider.whenSynced,
 *     destroy: () => provider.destroy(),
 *   });
 * };
 * ```
 */
export type ExtensionFactory<
	TTableDefinitions extends
		readonly TableDefinition[] = readonly TableDefinition[],
	TKvFields extends readonly KvField[] = readonly KvField[],
	TExports extends Lifecycle = Lifecycle,
> = (context: ExtensionContext<TTableDefinitions, TKvFields>) => TExports;

/**
 * Map of extension factory functions.
 *
 * Each extension must return a `Lifecycle` (with `whenSynced` and `destroy`).
 * Use `defineExports()` from `shared/lifecycle.ts` to easily create compliant returns.
 */
export type ExtensionFactoryMap = Record<
	string,
	// biome-ignore lint/suspicious/noExplicitAny: extension factories are variadic
	(...args: any[]) => Lifecycle
>;

/**
 * Infer exports from an extension factory map.
 *
 * Extensions return `Lifecycle & CustomExports` via `defineExports()`.
 * This type extracts the full return type of each extension.
 *
 * @typeParam TExtensions - The extension map to infer exports from
 */
export type InferExtensionExports<TExtensions extends ExtensionFactoryMap> = {
	[K in keyof TExtensions]: ReturnType<TExtensions[K]>;
};

// ════════════════════════════════════════════════════════════════════════════
// WORKSPACE CLIENT TYPES
// ════════════════════════════════════════════════════════════════════════════

/**
 * The workspace client returned by createWorkspace().
 *
 * Contains all workspace resources plus extension exports.
 *
 * @typeParam TTableDefinitions - Table definitions for this workspace
 * @typeParam TKvFields - KV field definitions for this workspace
 * @typeParam TExtensions - Extension factory map (defaults to empty)
 */
export type WorkspaceClient<
	TTableDefinitions extends readonly TableDefinition[],
	TKvFields extends readonly KvField[],
	TExtensions extends ExtensionFactoryMap = Record<string, never>,
> = {
	/** Workspace identifier */
	id: string;
	/** The underlying Y.Doc instance */
	ydoc: Y.Doc;
	/** Typed table helpers */
	tables: Tables<TTableDefinitions>;
	/** Typed KV helper */
	kv: Kv<TKvFields>;
	/** Extension exports (empty object if no extensions) */
	extensions: InferExtensionExports<TExtensions>;
	/** Promise resolving when all extensions are synced */
	whenSynced: Promise<void>;
	/** Cleanup all resources */
	destroy(): Promise<void>;
	/** Async dispose support for `await using` */
	[Symbol.asyncDispose](): Promise<void>;
};

/**
 * Builder returned by createWorkspace() that IS a client AND has .withExtensions().
 *
 * This uses Object.assign pattern to merge the base client with the builder methods,
 * allowing both direct use and chaining:
 * - Direct: `createWorkspace(...).tables.get('posts').upsert(...)`
 * - Chained: `createWorkspace(...).withExtensions({ sqlite })`
 *
 * @typeParam TTableDefinitions - Table definitions for this workspace
 * @typeParam TKvFields - KV field definitions for this workspace
 */
export type WorkspaceClientBuilder<
	TTableDefinitions extends readonly TableDefinition[],
	TKvFields extends readonly KvField[],
> = WorkspaceClient<TTableDefinitions, TKvFields, Record<string, never>> & {
	/**
	 * Add extensions to the workspace client.
	 *
	 * Extensions receive typed access to ydoc, tables, kv, and workspace identity.
	 * They must return a Lifecycle object (via defineExports).
	 *
	 * @param extensions - Map of extension factories
	 * @returns New workspace client with typed extensions
	 *
	 * @example
	 * ```typescript
	 * const workspace = createWorkspace(definition)
	 *   .withExtensions({
	 *     sqlite: (ctx) => sqliteExtension(ctx),
	 *     persistence: (ctx) => persistenceExtension(ctx),
	 *   });
	 *
	 * await workspace.whenSynced;
	 * workspace.extensions.sqlite.db.select()...;
	 * ```
	 */
	withExtensions<TExtensions extends ExtensionFactoryMap>(
		extensions: TExtensions,
	): WorkspaceClient<TTableDefinitions, TKvFields, TExtensions>;
};
