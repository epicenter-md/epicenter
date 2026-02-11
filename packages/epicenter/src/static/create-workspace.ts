/**
 * createWorkspace() - Instantiate a workspace client.
 *
 * Returns a client that IS usable directly AND has `.withExtensions()`.
 *
 * @example
 * ```typescript
 * // Direct use (no extensions)
 * const client = createWorkspace({ id: 'my-app', tables: { posts } });
 * client.tables.posts.set({ id: '1', title: 'Hello' });
 *
 * // With extensions
 * const client = createWorkspace({ id: 'my-app', tables: { posts } })
 *   .withExtensions({ sqlite, persistence });
 *
 * // From reusable definition
 * const def = defineWorkspace({ id: 'my-app', tables: { posts } });
 * const client = createWorkspace(def);
 * ```
 */

import * as Y from 'yjs';
import type { Actions } from '../shared/actions.js';
import type { Lifecycle } from '../shared/lifecycle.js';
import { createKv } from './create-kv.js';
import { createTables } from './create-tables.js';
import type {
	ExtensionFactory,
	ExtensionMap,
	InferExtensionExports,
	KvDefinitions,
	TableDefinitions,
	WorkspaceClient,
	WorkspaceClientBuilder,
	WorkspaceClientWithActions,
	WorkspaceDefinition,
} from './types.js';

/**
 * Create a workspace client.
 *
 * The returned client IS directly usable (no extensions) AND has `.withExtensions()`
 * for adding extensions like persistence or SQLite.
 *
 * @param config - Workspace config (or WorkspaceDefinition from defineWorkspace())
 * @returns WorkspaceClientBuilder - a client that can be used directly or chained with .withExtensions()
 */
export function createWorkspace<
	TId extends string,
	TTableDefinitions extends TableDefinitions = Record<string, never>,
	TKvDefinitions extends KvDefinitions = Record<string, never>,
>(
	config: WorkspaceDefinition<TId, TTableDefinitions, TKvDefinitions>,
): WorkspaceClientBuilder<TId, TTableDefinitions, TKvDefinitions> {
	const { id } = config;
	const ydoc = new Y.Doc({ guid: id });
	const tableDefs = (config.tables ?? {}) as TTableDefinitions;
	const kvDefs = (config.kv ?? {}) as TKvDefinitions;
	const tables = createTables(ydoc, tableDefs);
	const kv = createKv(ydoc, kvDefs);
	const definitions = { tables: tableDefs, kv: kvDefs };

	const destroy = async (): Promise<void> => {
		ydoc.destroy();
	};

	const baseClient = {
		id,
		ydoc,
		tables,
		kv,
		definitions,
		extensions: {} as InferExtensionExports<Record<string, never>>,
		destroy,
		[Symbol.asyncDispose]: destroy,
	};

	return {
		...baseClient,

		/**
		 * Attach extensions (persistence, SQLite, sync, etc.) to the workspace.
		 *
		 * Each extension factory receives { ydoc, id, tables, kv } and
		 * returns a Lifecycle object with exports. The returned client includes
		 * all extension exports under `.extensions`.
		 */
		withExtensions<TExtensions extends ExtensionMap>(extensions: TExtensions) {
			// Initialize each extension factory and collect their exports
			const extensionExports = Object.fromEntries(
				Object.entries(extensions).map(([name, factory]) => [
					name,
					(factory as ExtensionFactory<TTableDefinitions, TKvDefinitions>)({
						ydoc,
						id,
						tables,
						kv,
					}),
				]),
			) as Record<string, Lifecycle>;

			// Cleanup must destroy extensions first, then the Y.Doc
			const destroyWithExtensions = async (): Promise<void> => {
				await Promise.all(
					Object.values(extensionExports).map((c) => c.destroy()),
				);
				ydoc.destroy();
			};

			const clientWithExtensions = {
				id,
				ydoc,
				tables,
				kv,
				definitions,
				extensions: extensionExports as InferExtensionExports<TExtensions>,
				destroy: destroyWithExtensions,
				[Symbol.asyncDispose]: destroyWithExtensions,
			};

			return {
				...clientWithExtensions,

				withActions<TActions extends Actions>(
					factory: (
						client: WorkspaceClient<
							TId,
							TTableDefinitions,
							TKvDefinitions,
							TExtensions
						>,
					) => TActions,
				): WorkspaceClientWithActions<
					TId,
					TTableDefinitions,
					TKvDefinitions,
					TExtensions,
					TActions
				> {
					const actions = factory(
						clientWithExtensions as WorkspaceClient<
							TId,
							TTableDefinitions,
							TKvDefinitions,
							TExtensions
						>,
					);
					return {
						...clientWithExtensions,
						actions,
					} as WorkspaceClientWithActions<
						TId,
						TTableDefinitions,
						TKvDefinitions,
						TExtensions,
						TActions
					>;
				},
			};
		},

		/**
		 * Attach actions directly to the workspace client (without extensions).
		 *
		 * The factory receives the base client and returns an actions tree.
		 * Terminal — no more builder methods after this.
		 */
		withActions<TActions extends Actions>(
			factory: (
				client: WorkspaceClient<
					TId,
					TTableDefinitions,
					TKvDefinitions,
					Record<string, never>
				>,
			) => TActions,
		): WorkspaceClientWithActions<
			TId,
			TTableDefinitions,
			TKvDefinitions,
			Record<string, never>,
			TActions
		> {
			const actions = factory(
				baseClient as WorkspaceClient<
					TId,
					TTableDefinitions,
					TKvDefinitions,
					Record<string, never>
				>,
			);
			return { ...baseClient, actions } as WorkspaceClientWithActions<
				TId,
				TTableDefinitions,
				TKvDefinitions,
				Record<string, never>,
				TActions
			>;
		},
	};
}

export type { WorkspaceClient, WorkspaceClientBuilder };
