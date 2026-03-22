// @ts-nocheck
import { error } from '@sveltejs/kit';
import { getWorkspace } from '$lib/workspaces/dynamic/service';
import { createWorkspaceClient } from '$lib/yjs/workspace';
import type { LayoutLoad } from './$types';

/**
 * Load a workspace by ID.
 *
 * Flow:
 * 1. Load metadata from JSON file (for display: name, icon, etc.)
 * 2. Create workspace client from Static definition with persistence
 * 3. Return both for use in child routes
 */
export const load = async ({ params }: Parameters<LayoutLoad>[0]) => {
	const workspaceId = params.id;
	console.log(`[Layout] Loading workspace: ${workspaceId}`);

	// Load metadata from JSON file (for display purposes)
	const definition = await getWorkspace(workspaceId);
	if (!definition) {
		console.error(`[Layout] Workspace not found: ${workspaceId}`);
		error(404, { message: `Workspace "${workspaceId}" not found` });
	}

	// Create workspace client from Static definition with persistence
	const client = createWorkspaceClient(workspaceId);
	await client.whenReady;

	console.log(
		`[Layout] Loaded workspace: ${definition.name} (${definition.id})`,
	);

	return {
		/** The workspace metadata (name, icon, etc.). */
		definition,
		/** The live workspace client for CRUD operations. */
		client,
	};
};
