import { error } from '@sveltejs/kit';
import { getWorkspace } from '$lib/workspaces/dynamic/service';
import { createWorkspaceClient } from '$lib/yjs/workspace';
import type { LayoutLoad } from './$types';

/**
 * Load a workspace by ID.
 *
 * Flow:
 * 1. Load definition from JSON file
 * 2. Create workspace client with persistence
 * 3. Return client for use in child routes
 */
export const load: LayoutLoad = async ({ params }) => {
	const workspaceId = params.id;
	console.log(`[Layout] Loading workspace: ${workspaceId}`);

	// Load definition from JSON file
	const definition = await getWorkspace(workspaceId);
	if (!definition) {
		console.error(`[Layout] Workspace not found: ${workspaceId}`);
		error(404, { message: `Workspace "${workspaceId}" not found` });
	}

	// Create workspace client with persistence
	const client = createWorkspaceClient(definition);
	await client.whenSynced;

	console.log(
		`[Layout] Loaded workspace: ${definition.name} (${definition.id})`,
	);

	return {
		/** The workspace definition. */
		definition,
		/** The live workspace client for CRUD operations. */
		client,
	};
};
