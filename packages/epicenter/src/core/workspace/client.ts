import path from 'node:path';
import * as Y from 'yjs';
import type { WorkspaceActionMap, WorkspaceExports } from '../actions';
import { createWorkspaceBlobs } from '../blobs';
import { createEpicenterDb } from '../db/core';
import type { WorkspaceIndexMap } from '../indexes';
import { createWorkspaceValidators, type WorkspaceSchema } from '../schema';
import type { EpicenterDir, StorageDir } from '../types';
import type { AnyWorkspaceConfig, WorkspaceConfig } from './config';

/**
 * A workspace client is not a standalone concept. It's a single workspace extracted from an Epicenter client.
 *
 * An Epicenter client is an object of workspace clients: `{ workspaceId: WorkspaceClient }`.
 * `createEpicenterClient()` returns the full object. `createWorkspaceClient()` returns one workspace from that object.
 *
 * The client contains all workspace exports: actions, utilities, constants, and helpers.
 * Actions (queries and mutations) are identified at runtime via type guards for API/MCP mapping.
 */
export type WorkspaceClient<TExports extends WorkspaceExports> = TExports & {
	/**
	 * Async cleanup method for resource management
	 * - Destroys all indexes (awaiting any async cleanup)
	 * - Destroys the YJS document
	 *
	 * Call manually for explicit control:
	 * ```typescript
	 * const workspace = await createWorkspaceClient(config);
	 * // ... use workspace ...
	 * await workspace.destroy();
	 * ```
	 */
	destroy: () => Promise<void>;

	/**
	 * Async disposal for `await using` syntax (TC39 Explicit Resource Management)
	 *
	 * Use for automatic cleanup when scope exits:
	 * ```typescript
	 * await using workspace = await createWorkspaceClient(config);
	 * // ... use workspace ...
	 * // cleanup happens automatically when scope exits
	 * ```
	 */
	[Symbol.asyncDispose]: () => Promise<void>;
};

/**
 * Maps an array of workspace configs to an object of WorkspaceClients keyed by workspace id.
 *
 * Takes an array of workspace configs and merges them into a single object where:
 * - Each key is a workspace id
 * - Each value is a WorkspaceClient with all exports and lifecycle management
 *
 * This allows accessing workspace exports as `client.workspaceId.exportName()`.
 *
 * Note: Workspaces can export actions, utilities, constants, and helpers.
 * Actions (queries/mutations) get special treatment at the server/MCP level via iterActions().
 *
 * @example
 * ```typescript
 * // Given workspace configs:
 * const authWorkspace = defineWorkspace({ id: 'auth', exports: () => ({ login: ..., logout: ..., validateToken: ... }) })
 * const storageWorkspace = defineWorkspace({ id: 'storage', exports: () => ({ upload: ..., download: ..., MAX_FILE_SIZE: ... }) })
 *
 * // WorkspacesToClients<[typeof authWorkspace, typeof storageWorkspace]> produces:
 * {
 *   auth: WorkspaceClient<{ login: ..., logout: ... }>,  // Only actions exposed
 *   storage: WorkspaceClient<{ upload: ..., download: ... }>  // Only actions exposed
 * }
 * ```
 */
export type WorkspacesToClients<WS extends readonly AnyWorkspaceConfig[]> = {
	[W in WS[number] as W extends { id: infer TId extends string }
		? TId
		: never]: W extends {
		exports: (context: any) => infer TExports extends WorkspaceExports;
	}
		? WorkspaceClient<TExports>
		: never;
};

/**
 * Internal function that initializes multiple workspaces with shared dependency resolution.
 * Uses flat dependency resolution with VS Code-style peer dependency model.
 * All transitive dependencies must be present in the provided workspaces array (flat/hoisted).
 * Initialization uses topological sort for deterministic, predictable order.
 *
 * @param workspaceConfigs - Array of workspace configurations to initialize
 * @param storageDir - Absolute storage directory path (Node.js) or undefined (browser)
 * @returns Object mapping workspace ids to initialized workspace clients
 */
export async function initializeWorkspaces<
	const TConfigs extends readonly AnyWorkspaceConfig[],
>(
	workspaceConfigs: TConfigs,
	storageDir: StorageDir | undefined,
): Promise<WorkspacesToClients<TConfigs>> {
	// Compute epicenterDir once from storageDir
	// This is the `.epicenter` directory where all workspace data is stored
	const epicenterDir = storageDir
		? (path.join(storageDir, '.epicenter') as EpicenterDir)
		: undefined;

	// ═══════════════════════════════════════════════════════════════════════════
	// PHASE 1: REGISTRATION
	// Register all workspace configs
	// ═══════════════════════════════════════════════════════════════════════════

	/**
	 * Registry mapping workspace ID to workspace config.
	 * Each workspace ID should appear at most once in the workspaceConfigs array.
	 */
	const workspaceConfigsMap = new Map<string, WorkspaceConfig>();

	// Register all workspace configs
	for (const workspaceConfig of workspaceConfigs) {
		// At runtime, all workspace configs have full WorkspaceConfig properties
		// The AnyWorkspaceConfig constraint is only for type inference
		const config = workspaceConfig as unknown as WorkspaceConfig;
		const existing = workspaceConfigsMap.get(config.id);
		if (existing) {
			throw new Error(
				`Duplicate workspace ID detected: "${config.id}". Each workspace must have a unique ID.`,
			);
		}
		workspaceConfigsMap.set(config.id, config);
	}

	// ═══════════════════════════════════════════════════════════════════════════
	// PHASE 2: DEPENDENCY VERIFICATION
	// Verify that all dependencies exist in registered workspaces (flat/hoisted model)
	// ═══════════════════════════════════════════════════════════════════════════

	// Verify all dependencies for ALL registered workspace configs (not just root-level ones)
	// This ensures the flat/hoisted model is correctly followed at every level:
	// - If A depends on B and B depends on C, both B and C must be in rootWorkspaceConfigs
	// - By checking every workspace in the map, we verify the entire dependency tree
	//
	// Note: We only check direct dependencies (not recursive) because the flat/hoisted model
	// guarantees complete validation in a single pass. Example:
	// - Root config contains: [A, B, C]
	// - A.dependencies = [B]
	// - B.dependencies = [C]
	// - C.dependencies = []
	// Since each dependent workspace also has their transitive dependencies hoisted to the root,
	// we don't need recursion. Each workspace's direct dependencies are sufficient.
	// When we iterate:
	// - Check A: verify B exists ✓
	// - Check B: verify C exists ✓
	// - Check C: no dependencies ✓
	for (const [workspaceId, workspaceConfig] of workspaceConfigsMap) {
		if (workspaceConfig.dependencies) {
			for (const dep of workspaceConfig.dependencies) {
				// Verify the dependency exists in registered configs (flat/hoisted model)
				if (!workspaceConfigsMap.has(dep.id)) {
					throw new Error(
						`Missing dependency: workspace "${workspaceId}" depends on "${dep.id}", but it was not found in rootWorkspaceConfigs.\n\nFix: Add "${dep.id}" to rootWorkspaceConfigs array (flat/hoisted resolution).\nAll transitive dependencies must be declared at the root level.`,
					);
				}
			}
		}
	}

	// ═══════════════════════════════════════════════════════════════════════════
	// PHASE 3: BUILD DEPENDENCY GRAPH
	// Create adjacency list and in-degree map for topological sort
	// ═══════════════════════════════════════════════════════════════════════════

	/**
	 * Adjacency list mapping workspace ID to dependent workspace IDs.
	 * Example: If workspace B depends on workspace A, then dependents[A] contains [B]
	 * This represents the "outgoing edges" in the dependency graph.
	 */
	const dependents = new Map<string, string[]>();

	/**
	 * In-degree map tracking the number of dependencies for each workspace.
	 * In-degree is the count of "incoming edges" (dependencies).
	 * Example: If workspace C depends on A and B, then inDegree[C] = 2
	 * Workspaces with in-degree 0 have no dependencies and can be initialized first.
	 */
	const inDegree = new Map<string, number>();

	// Initialize structures for all registered workspaces
	for (const id of workspaceConfigsMap.keys()) {
		dependents.set(id, []);
		inDegree.set(id, 0);
	}

	// Build the graph by processing each workspace config's dependencies
	for (const [id, workspaceConfig] of workspaceConfigsMap) {
		if (
			workspaceConfig.dependencies &&
			workspaceConfig.dependencies.length > 0
		) {
			for (const dep of workspaceConfig.dependencies) {
				// Add edge: dep.id -> id (id depends on dep.id)
				// Note: Dependencies are already verified in Phase 2
				dependents.get(dep.id)?.push(id);

				// Increment in-degree for the dependent workspace
				inDegree.set(id, inDegree.get(id)! + 1);
			}
		}
	}

	// ═══════════════════════════════════════════════════════════════════════════
	// PHASE 4: TOPOLOGICAL SORT (Kahn's Algorithm)
	// Sort workspaces by dependency order
	// ═══════════════════════════════════════════════════════════════════════════

	/**
	 * Queue of workspace IDs ready to be added to the sorted list.
	 * Starts with all workspaces that have zero dependencies (in-degree = 0).
	 * As we process each workspace, we add new workspaces whose dependencies are satisfied.
	 */
	const queue: string[] = [];
	for (const [id, degree] of inDegree) {
		if (degree === 0) {
			queue.push(id);
		}
	}

	/**
	 * Sorted list of workspace IDs in topological order.
	 * This is the initialization order: dependencies come before their dependents.
	 * Example: If B depends on A, then sorted = [A, B] (not [B, A])
	 */
	const sorted: string[] = [];

	// Process the queue
	while (queue.length > 0) {
		const currentId = queue.shift()!;
		sorted.push(currentId);

		// For each workspace that depends on the current workspace
		for (const dependentId of dependents.get(currentId)!) {
			// Decrement in-degree (one dependency satisfied)
			const newDegree = inDegree.get(dependentId)! - 1;
			inDegree.set(dependentId, newDegree);

			// If all dependencies are satisfied, add to queue
			if (newDegree === 0) {
				queue.push(dependentId);
			}
		}
	}

	// Check for circular dependencies
	if (sorted.length !== workspaceConfigsMap.size) {
		const unsorted = Array.from(workspaceConfigsMap.keys()).filter(
			(id) => !sorted.includes(id),
		);
		throw new Error(
			`Circular dependency detected. The following workspaces form a cycle: ${unsorted.join(', ')}`,
		);
	}

	// ═══════════════════════════════════════════════════════════════════════════
	// PHASE 5: INITIALIZE IN TOPOLOGICAL ORDER
	// Initialize workspaces one by one in dependency order
	// ═══════════════════════════════════════════════════════════════════════════

	/**
	 * Map of workspace ID to initialized workspace client.
	 * Each client exposes all workspace exports (actions, utilities, constants).
	 * Populated as we initialize each workspace in topological order.
	 * When initializing workspace B that depends on A, we can safely
	 * inject clients[A] because A was initialized earlier in the sorted order.
	 */
	const clients = new Map<string, WorkspaceClient<any>>();

	/**
	 * Initialize a single workspace (non-recursive).
	 * All dependencies are guaranteed to be already initialized because we're
	 * processing workspaces in topological order. This function:
	 * 1. Injects already-initialized dependency clients
	 * 2. Creates YDoc, DB, indexes, and actions
	 * 3. Returns the initialized workspace client
	 */
	const initializeWorkspace = async (
		workspaceConfig: WorkspaceConfig,
	): Promise<WorkspaceClient<any>> => {
		// Build the workspaceClients object by injecting already-initialized dependencies
		// Key: dependency id, Value: full client with all exports (actions + utilities)
		const workspaceClients: Record<
			string,
			WorkspaceClient<WorkspaceExports>
		> = {};

		if (
			workspaceConfig.dependencies &&
			workspaceConfig.dependencies.length > 0
		) {
			// Inject dependency clients from the registered configs
			// Build set of unique dependency IDs
			const uniqueDepIds = new Set(
				workspaceConfig.dependencies.map((dep) => dep.id),
			);

			// Inject dependency clients
			for (const depId of uniqueDepIds) {
				// Get the workspace config
				const depConfig = workspaceConfigsMap.get(depId);
				if (!depConfig) {
					throw new Error(
						`Internal error: dependency "${depId}" not found in registered configs`,
					);
				}

				// Get the initialized client
				const depClient = clients.get(depId);
				if (!depClient) {
					throw new Error(
						`Internal error: dependency "${depId}" should have been initialized before "${workspaceConfig.id}"`,
					);
				}

				// Inject using the config's id
				workspaceClients[depConfig.id] = depClient;
			}
		}

		// Now that all dependencies are ready, initialize this workspace's core components

		// Create YJS document with workspace ID as the document GUID
		const ydoc = new Y.Doc({ guid: workspaceConfig.id });

		// Set up YDoc providers (persistence, synchronization, observability)
		// IMPORTANT: This must run BEFORE createEpicenterDb so that persisted data is loaded
		// into the YDoc before table initialization
		// Providers can be sync or async, so we await all of them in parallel
		if (workspaceConfig.providers) {
			await Promise.all(
				workspaceConfig.providers.map((provider) =>
					provider({ id: workspaceConfig.id, ydoc, storageDir, epicenterDir }),
				),
			);
		}

		// Initialize Epicenter database (wraps YJS with table/record API)
		const db = createEpicenterDb(ydoc, workspaceConfig.schema);

		// Create validators for runtime validation and arktype composition
		// Exposed via exports context for use in migration scripts, external validation, etc.
		const validators = createWorkspaceValidators(workspaceConfig.schema);

		// Initialize each index by calling its factory function with IndexContext
		// Each index function receives { id, indexId, schema, db, storageDir, epicenterDir } and returns an index object
		// Initialize all indexes in parallel for better performance
		const indexes = Object.fromEntries(
			await Promise.all(
				Object.entries(workspaceConfig.indexes).map(
					async ([indexId, indexFn]) => [
						indexId,
						await indexFn({
							id: workspaceConfig.id,
							indexId,
							schema: workspaceConfig.schema,
							db,
							storageDir,
							epicenterDir,
						}),
					],
				),
			),
		) as {
			[K in keyof typeof workspaceConfig.indexes]: Awaited<
				ReturnType<(typeof workspaceConfig.indexes)[K]>
			>;
		};

		// Initialize blob stores for each table in the schema
		// Storage layout: {storageDir}/{workspaceId}/{tableName}/{filename}
		const blobs = await createWorkspaceBlobs({
			id: workspaceConfig.id,
			schema: workspaceConfig.schema,
			storageDir,
		});

		// Call the exports factory to get workspace exports (actions + utilities), passing:
		// - schema: The workspace schema (table definitions)
		// - db: Epicenter database API
		// - validators: Schema validators for runtime validation and arktype composition
		// - indexes: exported resources from each index (db, queries, etc.)
		// - workspaces: full clients from dependencies (all exports, not filtered!)
		// - blobs: blob storage for binary files, namespaced by table
		// - storageDir: Absolute storage directory path (undefined in browser)
		// - epicenterDir: Absolute path to .epicenter directory (undefined in browser)
		const exports = workspaceConfig.exports({
			schema: workspaceConfig.schema,
			db,
			validators,
			indexes,
			workspaces: workspaceClients,
			blobs,
			storageDir,
			epicenterDir,
		});

		// Create async cleanup function
		const cleanup = async () => {
			// Clean up indexes first, awaiting any async destroy operations
			await Promise.all(
				Object.values(indexes).map((index) => index.destroy?.()),
			);

			// Clean up YDoc (disconnects providers, cleans up observers)
			ydoc.destroy();
		};

		// Create the workspace client with all exports (actions + utilities)
		// Filtering to just actions happens at the server/MCP level via iterActions()
		const client: WorkspaceClient<any> = {
			...exports,
			destroy: cleanup,
			[Symbol.asyncDispose]: cleanup,
		};

		return client;
	};

	// Initialize all workspaces in topological order
	for (const workspaceId of sorted) {
		const workspaceConfig = workspaceConfigsMap.get(workspaceId)!;
		const client = await initializeWorkspace(workspaceConfig);
		clients.set(workspaceId, client);
	}

	// Convert Map to typed object keyed by workspace id
	const initializedWorkspaces: Record<
		string,
		WorkspaceClient<WorkspaceActionMap>
	> = {};
	for (const [workspaceId, client] of clients) {
		initializedWorkspaces[workspaceId] = client;
	}

	return initializedWorkspaces as WorkspacesToClients<TConfigs>;
}

/**
 * Creates a workspace client by initializing the workspace and its dependencies.
 *
 * This collects the workspace plus its dependencies, calls `initializeWorkspaces()` to create
 * the full object of clients (`{ workspaceA: clientA, workspaceB: clientB, ... }`), then
 * returns only the specified workspace's client. All dependencies are initialized but not exposed.
 *
 * Contrast with `createEpicenterClient()` which returns the full object of all workspace clients.
 *
 * **Note**: storageDir defaults to process.cwd(). For custom storage paths, wrap the workspace
 * in an epicenter config with defineEpicenter({ storageDir, workspaces: [workspace] }) and use
 * createEpicenterClient() instead.
 */
export async function createWorkspaceClient<
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
): Promise<WorkspaceClient<TExports>> {
	// Resolve storageDir with environment detection
	// In Node.js: resolve to absolute path (defaults to process.cwd())
	// In browser: undefined (filesystem operations not available)
	const isNode =
		typeof process !== 'undefined' &&
		process.versions != null &&
		process.versions.node != null;

	let resolvedStorageDir: StorageDir | undefined;
	if (isNode) {
		resolvedStorageDir = path.resolve(process.cwd()) as StorageDir;
	}

	// Collect all workspace configs (target + dependencies) for flat/hoisted initialization
	const allWorkspaceConfigs: WorkspaceConfig[] = [];

	if (workspace.dependencies) {
		// Add all dependencies first
		// Dependencies are constrained to AnyWorkspaceConfig at the type level to prevent
		// infinite recursion, but at runtime they're full WorkspaceConfig objects
		allWorkspaceConfigs.push(
			...(workspace.dependencies as unknown as WorkspaceConfig[]),
		);
	}

	// Add target workspace last
	// This cast is safe because WorkspaceConfig<...generics...> is structurally compatible
	// with WorkspaceConfig (the type with default generics). We use unknown as intermediate
	// to satisfy TypeScript's strict checking while maintaining runtime safety.
	allWorkspaceConfigs.push(workspace as unknown as WorkspaceConfig);

	// Use the shared initialization logic with flat dependency array
	// This initializes ALL workspaces and returns an object keyed by workspace id
	const clients = await initializeWorkspaces(
		allWorkspaceConfigs,
		resolvedStorageDir,
	);

	// Return the specified workspace's client from the initialized workspaces object
	const workspaceClient = clients[workspace.id as keyof typeof clients];
	if (!workspaceClient) {
		throw new Error(
			`Internal error: workspace "${workspace.id}" was not initialized`,
		);
	}

	// Type assertion is safe because we know the workspace was initialized with the correct exports
	// and extractActions() was called to filter to just actions
	return workspaceClient as WorkspaceClient<TExports>;
}
