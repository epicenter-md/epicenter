import { appLocalDataDir, join } from '@tauri-apps/api/path';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { createTaggedError } from 'wellcrafted/error';
import { Ok } from 'wellcrafted/result';
import { defineMutation, defineQuery, queryClient } from '$lib/query/client';
import type { WorkspaceTemplate } from '$lib/templates';
import {
	createWorkspaceDefinition,
	deleteWorkspace,
	getWorkspace,
	listWorkspaces,
	updateWorkspaceDefinition,
} from './service';

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
	 * List all workspaces from JSON definition files.
	 */
	listWorkspaces: defineQuery({
		queryKey: workspaceKeys.list(),
		queryFn: async () => {
			const definitions = await listWorkspaces();
			return Ok(definitions);
		},
	}),

	/**
	 * Get a single workspace definition by ID.
	 */
	getWorkspace: (workspaceId: string) =>
		defineQuery({
			queryKey: workspaceKeys.detail(workspaceId),
			queryFn: async () => {
				const definition = await getWorkspace(workspaceId);
				if (!definition) {
					return WorkspaceErr({
						message: `Workspace "${workspaceId}" not found`,
					});
				}
				return Ok(definition);
			},
		}),

	/**
	 * Create a new workspace.
	 *
	 * Writes the definition JSON file and creates the data folder.
	 * If a template is provided, the tables and kv from the template are used.
	 */
	createWorkspace: defineMutation({
		mutationKey: ['workspaces', 'create'],
		mutationFn: async (input: {
			name: string;
			id: string;
			template: WorkspaceTemplate | null;
		}) => {
			const definition = await createWorkspaceDefinition({
				id: input.id,
				name: input.name,
				description: input.template?.description ?? '',
				icon: input.template?.icon ?? null,
				tables: [...(input.template?.tables ?? [])],
				kv: [...(input.template?.kv ?? [])],
			});

			console.log(`[createWorkspace] Created workspace:`, {
				id: definition.id,
				name: definition.name,
			});

			// Invalidate list query
			queryClient.invalidateQueries({ queryKey: workspaceKeys.list() });

			return Ok(definition);
		},
	}),

	/**
	 * Update a workspace's metadata.
	 */
	updateWorkspace: defineMutation({
		mutationKey: ['workspaces', 'update'],
		mutationFn: async (input: {
			workspaceId: string;
			name?: string;
			description?: string;
		}) => {
			const updated = await updateWorkspaceDefinition(input.workspaceId, {
				...(input.name !== undefined && { name: input.name }),
				...(input.description !== undefined && {
					description: input.description,
				}),
			});

			if (!updated) {
				return WorkspaceErr({
					message: `Workspace "${input.workspaceId}" not found`,
				});
			}

			console.log(`[updateWorkspace] Updated workspace:`, {
				id: updated.id,
				name: updated.name,
			});

			// Invalidate queries to refresh UI
			queryClient.invalidateQueries({ queryKey: workspaceKeys.list() });
			queryClient.invalidateQueries({
				queryKey: workspaceKeys.detail(input.workspaceId),
			});

			return Ok(updated);
		},
	}),

	/**
	 * Delete a workspace and all its data.
	 */
	deleteWorkspace: defineMutation({
		mutationKey: ['workspaces', 'delete'],
		mutationFn: async (id: string) => {
			const deleted = await deleteWorkspace(id);

			if (!deleted) {
				return WorkspaceErr({
					message: `Workspace "${id}" not found`,
				});
			}

			// Invalidate queries
			queryClient.invalidateQueries({ queryKey: workspaceKeys.list() });
			queryClient.removeQueries({ queryKey: workspaceKeys.detail(id) });

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
	// Definition Modification (Stubs - to be implemented)
	// ───────────────────────────────────────────────────────────────────────────

	/**
	 * Add a table to a workspace definition.
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
			// TODO: Implement via updateWorkspaceDefinition
			return WorkspaceErr({
				message: 'Adding tables is not yet implemented',
			});
		},
	}),

	/**
	 * Remove a table from a workspace definition.
	 */
	removeTable: defineMutation({
		mutationKey: ['workspaces', 'removeTable'],
		mutationFn: async (_input: { workspaceId: string; tableName: string }) => {
			// TODO: Implement via updateWorkspaceDefinition
			return WorkspaceErr({
				message: 'Removing tables is not yet implemented',
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
			// TODO: Implement via updateWorkspaceDefinition
			return WorkspaceErr({
				message: 'Adding KV entries is not yet implemented',
			});
		},
	}),

	/**
	 * Remove a KV entry from a workspace definition.
	 */
	removeKvEntry: defineMutation({
		mutationKey: ['workspaces', 'removeKvEntry'],
		mutationFn: async (_input: { workspaceId: string; key: string }) => {
			// TODO: Implement via updateWorkspaceDefinition
			return WorkspaceErr({
				message: 'Removing KV entries is not yet implemented',
			});
		},
	}),
};
