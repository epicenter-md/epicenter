import { generateGuid, type WorkspaceDefinition } from '@epicenter/hq';
import { appLocalDataDir, join } from '@tauri-apps/api/path';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { createTaggedError } from 'wellcrafted/error';
import { Ok } from 'wellcrafted/result';
import { registry } from '$lib/docs/registry';
import { createHead } from '$lib/docs/head';
import { createWorkspaceClient } from '$lib/docs/workspace';
import { extractDefinitionFromYDoc } from '$lib/utils/extract-definition';
import { defineMutation, defineQuery, queryClient } from './client';

// ─────────────────────────────────────────────────────────────────────────────
// Error Types
// ─────────────────────────────────────────────────────────────────────────────

export const { WorkspaceError, WorkspaceErr } =
	createTaggedError('WorkspaceError');
export type WorkspaceError = ReturnType<typeof WorkspaceError>;

// ─────────────────────────────────────────────────────────────────────────────
// Query Keys
// ─────────────────────────────────────────────────────────────────────────────

const workspaceKeys = {
	all: ['workspaces'] as const,
	list: () => [...workspaceKeys.all, 'list'] as const,
	detail: (id: string) => [...workspaceKeys.all, 'detail', id] as const,
};

// ─────────────────────────────────────────────────────────────────────────────
// Queries & Mutations
// ─────────────────────────────────────────────────────────────────────────────

export const workspaces = {
	/**
	 * List all workspaces from the registry.
	 *
	 * Returns workspace GUIDs with minimal metadata. For full definition details,
	 * use getWorkspace() which loads from the workspace Y.Doc.
	 */
	listWorkspaces: defineQuery({
		queryKey: workspaceKeys.list(),
		queryFn: async () => {
			const guids = registry.getWorkspaceIds();

			// Return minimal workspace info (just GUIDs)
			// Full definition is loaded lazily when navigating to the workspace
			const workspaces = guids.map((id) => ({
				id,
				// Use GUID as placeholder name/slug until we have metadata in registry
				name: id,
				slug: id,
				tables: {},
				kv: {},
			}));

			return Ok(workspaces);
		},
	}),

	/**
	 * Get a single workspace by GUID.
	 *
	 * Uses the "empty definition" pattern: creates a client with empty definition,
	 * lets persistence load the real definition, then extracts it.
	 */
	getWorkspace: (workspaceId: string) =>
		defineQuery({
			queryKey: workspaceKeys.detail(workspaceId),
			queryFn: async () => {
				// Check if workspace exists in registry
				if (!registry.hasWorkspace(workspaceId)) {
					return WorkspaceErr({
						message: `Workspace "${workspaceId}" not found`,
					});
				}

				// Get epoch from head doc
				const head = createHead(workspaceId);
				await head.whenSynced;
				const epoch = head.getEpoch();

				// Create client with empty definition - persistence loads the real one
				const client = createWorkspaceClient(
					{
						id: workspaceId,
						slug: workspaceId,
						name: '',
						tables: {},
						kv: {},
					},
					epoch,
				);

				// Wait for persistence to finish loading existing data from disk
				await client.whenSynced;

				// Extract definition and clean up
				const definition = extractDefinitionFromYDoc(client.ydoc, workspaceId);
				await client.destroy();

				return Ok(definition);
			},
		}),

	/**
	 * Create a new workspace.
	 *
	 * 1. Generates a GUID for the workspace
	 * 2. Adds the GUID to the registry
	 * 3. Creates a head doc (epoch starts at 0)
	 * 4. Creates the workspace doc with initial definition
	 */
	createWorkspace: defineMutation({
		mutationKey: ['workspaces', 'create'],
		mutationFn: async (input: { name: string; slug: string }) => {
			// Generate GUID for sync coordination
			const guid = generateGuid();

			// Create definition
			const definition: WorkspaceDefinition = {
				id: guid,
				slug: input.slug,
				name: input.name,
				tables: {},
				kv: {},
			};

			// Add to registry (persisted automatically via registryPersistence)
			registry.addWorkspace(guid);

			// Initialize head doc at epoch 0
			const head = createHead(guid);
			await head.whenSynced;

			// Create workspace client to initialize the workspace doc
			// This writes the definition to the Y.Doc
			const client = createWorkspaceClient(definition, 0);

			// Wait for persistence to finish saving initial state to disk
			await client.whenSynced;
			await client.destroy();

			console.log(`[createWorkspace] Created workspace:`, {
				guid,
				slug: definition.slug,
				name: definition.name,
			});

			// Invalidate list query
			queryClient.invalidateQueries({ queryKey: workspaceKeys.list() });

			return Ok(definition);
		},
	}),

	/**
	 * Delete a workspace.
	 *
	 * Removes from registry and head doc cache. Does NOT delete files on disk.
	 * (File cleanup can be added later if needed)
	 */
	deleteWorkspace: defineMutation({
		mutationKey: ['workspaces', 'delete'],
		mutationFn: async (guid: string) => {
			// Check if workspace exists
			if (!registry.hasWorkspace(guid)) {
				return WorkspaceErr({
					message: `Workspace "${guid}" not found`,
				});
			}

			// Remove from registry
			registry.removeWorkspace(guid);

			// Note: Head doc cleanup happens automatically when navigating away
			// since head docs are now created per-navigation, not cached

			// Invalidate queries
			queryClient.invalidateQueries({ queryKey: workspaceKeys.list() });
			queryClient.removeQueries({ queryKey: workspaceKeys.detail(guid) });

			return Ok(undefined);
		},
	}),

	/**
	 * Open the workspaces directory in the file explorer.
	 */
	openWorkspacesDirectory: defineMutation({
		mutationKey: ['workspaces', 'openDirectory'],
		mutationFn: async () => {
			try {
				const baseDir = await appLocalDataDir();
				const workspacesPath = await join(baseDir, 'workspaces');
				await revealItemInDir(workspacesPath);
				return Ok(undefined);
			} catch (error) {
				return WorkspaceErr({
					message: `Failed to open workspaces directory: ${error}`,
				});
			}
		},
	}),

	// ───────────────────────────────────────────────────────────────────────────
	// Definition Modification (Temporary stubs - will be refactored)
	// In the new architecture, these should modify the live workspace client,
	// not the query layer. For now, they're stubs to keep the UI working.
	// ───────────────────────────────────────────────────────────────────────────

	/**
	 * Add a table to a workspace definition.
	 *
	 * TODO: This should modify the live workspace client's Y.Doc,
	 * not go through the query layer.
	 */
	addTable: defineMutation({
		mutationKey: ['workspaces', 'addTable'],
		mutationFn: async (_input: {
			workspaceId: string;
			name: string;
			id: string;
			icon?: string | null;
			description?: string;
		}) => {
			// TODO: Implement via workspace client
			return WorkspaceErr({
				message: 'Adding tables is not yet implemented in the new architecture',
			});
		},
	}),

	/**
	 * Remove a table from a workspace definition.
	 */
	removeTable: defineMutation({
		mutationKey: ['workspaces', 'removeTable'],
		mutationFn: async (_input: { workspaceId: string; tableName: string }) => {
			// TODO: Implement via workspace client
			return WorkspaceErr({
				message:
					'Removing tables is not yet implemented in the new architecture',
			});
		},
	}),

	/**
	 * Add a KV entry to a workspace definition.
	 */
	addKvEntry: defineMutation({
		mutationKey: ['workspaces', 'addKvEntry'],
		mutationFn: async (_input: {
			workspaceId: string;
			name: string;
			key: string;
		}) => {
			// TODO: Implement via workspace client
			return WorkspaceErr({
				message:
					'Adding KV entries is not yet implemented in the new architecture',
			});
		},
	}),

	/**
	 * Remove a KV entry from a workspace definition.
	 */
	removeKvEntry: defineMutation({
		mutationKey: ['workspaces', 'removeKvEntry'],
		mutationFn: async (_input: { workspaceId: string; key: string }) => {
			// TODO: Implement via workspace client
			return WorkspaceErr({
				message:
					'Removing KV entries is not yet implemented in the new architecture',
			});
		},
	}),
};
