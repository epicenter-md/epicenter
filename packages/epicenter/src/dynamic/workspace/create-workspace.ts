/**
 * createWorkspace() - Instantiate a dynamic workspace client.
 *
 * Returns a client that IS usable directly AND has `.withExtensions()`.
 *
 * @example
 * ```typescript
 * // Direct use (no extensions)
 * const workspace = createWorkspace(definition);
 * workspace.tables.get('posts').upsert({ id: '1', title: 'Hello' });
 *
 * // With extensions
 * const workspace = createWorkspace(definition)
 *   .withExtensions({ sqlite, persistence });
 *
 * await workspace.whenSynced;
 * workspace.extensions.sqlite.db.select()...;
 * ```
 */

import * as Y from 'yjs';
import { defineExports, type Lifecycle } from '../../shared/lifecycle';
import { createKv } from '../kv/create-kv';
import type { KvField, TableDefinition } from '../schema/fields/types';
import type { WorkspaceDefinition } from '../schema/workspace-definition';
import { createTables } from '../tables/create-tables';
import type {
	ExtensionContext,
	ExtensionFactoryMap,
	InferExtensionExports,
	WorkspaceClient,
	WorkspaceClientBuilder,
} from './types';

/**
 * Create a workspace client with optional extension chaining.
 *
 * Returns a client that IS directly usable AND has `.withExtensions()`
 * for adding extensions like persistence, SQLite, or sync.
 *
 * ## Y.Doc Structure
 *
 * ```
 * Y.Doc (guid = definition.id, gc: true)
 * +-- Y.Array('table:posts')  <- Table data (LWW entries)
 * +-- Y.Array('table:users')  <- Another table
 * +-- Y.Array('kv')           <- KV settings (LWW entries)
 * ```
 *
 * @example Direct use (no extensions)
 * ```typescript
 * const workspace = createWorkspace(definition);
 * workspace.tables.get('posts').upsert({ id: '1', title: 'Hello' });
 * ```
 *
 * @example With extensions
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
 *
 * @param definition - Workspace definition with id, tables, and kv
 * @returns WorkspaceClientBuilder - a client that can be used directly or chained with .withExtensions()
 */
export function createWorkspace<
	const TTableDefinitions extends readonly TableDefinition[],
	const TKvFields extends readonly KvField[],
>(
	definition: WorkspaceDefinition<TTableDefinitions, TKvFields>,
): WorkspaceClientBuilder<TTableDefinitions, TKvFields> {
	const id = definition.id;

	// Create Y.Doc with guid = definition.id
	// gc: true enables garbage collection for efficient YKeyValueLww storage
	const ydoc = new Y.Doc({ guid: id, gc: true });

	// Create table and KV helpers bound to Y.Doc
	const tables = createTables(ydoc, definition.tables ?? []);
	const kv = createKv(ydoc, definition.kv ?? []);

	// Base destroy (no extensions)
	const destroy = async (): Promise<void> => {
		ydoc.destroy();
	};

	// Build the base client (no extensions)
	const baseClient: WorkspaceClient<
		TTableDefinitions,
		TKvFields,
		Record<string, never>
	> = {
		id,
		ydoc,
		tables,
		kv,
		extensions: {} as InferExtensionExports<Record<string, never>>,
		whenSynced: Promise.resolve(), // No extensions = already synced
		destroy,
		[Symbol.asyncDispose]: destroy,
	};

	// Add withExtensions method to create builder
	return Object.assign(baseClient, {
		/**
		 * Add extensions to the workspace client.
		 *
		 * Each extension factory receives context and returns a Lifecycle object.
		 * The returned client has typed access to all extension exports.
		 */
		withExtensions<TExtensions extends ExtensionFactoryMap>(
			extensionFactories: TExtensions,
		) {
			// Initialize extensions synchronously; async work is in their whenSynced
			const extensions = {} as InferExtensionExports<TExtensions>;

			for (const [extensionId, factory] of Object.entries(extensionFactories)) {
				// Build context for this extension
				const context: ExtensionContext<TTableDefinitions, TKvFields> = {
					ydoc,
					id,
					definition,
					tables,
					kv,
					extensionId,
				};

				// Factory is sync; normalize exports at boundary
				const result = factory(context);
				const exports = defineExports(result as Record<string, unknown>);
				(extensions as Record<string, unknown>)[extensionId] = exports;
			}

			// Aggregate all extension whenSynced promises
			// Fail-fast: any rejection rejects the whole thing
			const whenSynced = Promise.all(
				Object.values(extensions).map((e) => (e as Lifecycle).whenSynced),
			).then(() => {});

			// Cleanup must destroy extensions first, then Y.Doc
			const destroyWithExtensions = async (): Promise<void> => {
				await Promise.allSettled(
					Object.values(extensions).map((e) => (e as Lifecycle).destroy()),
				);
				ydoc.destroy();
			};

			const clientWithExtensions = {
				id,
				ydoc,
				tables,
				kv,
				extensions,
				whenSynced,
				destroy: destroyWithExtensions,
				[Symbol.asyncDispose]: destroyWithExtensions,
			};

			return clientWithExtensions;
		},
	});
}

export type { WorkspaceClient, WorkspaceClientBuilder };
