import type { WorkspaceDefinition } from '@epicenter/hq/dynamic';
import { appLocalDataDir, join } from '@tauri-apps/api/path';
import {
	mkdir,
	readDir,
	readTextFile,
	remove,
	writeTextFile,
} from '@tauri-apps/plugin-fs';

/**
 * Get the base workspaces directory path.
 */
async function getWorkspacesDir(): Promise<string> {
	const baseDir = await appLocalDataDir();
	return join(baseDir, 'workspaces');
}

/**
 * Get the path to a workspace's definition.json file (inside the workspace folder).
 */
async function getDefinitionPath(id: string): Promise<string> {
	const workspacesDir = await getWorkspacesDir();
	return join(workspacesDir, id, 'definition.json');
}

/**
 * Get the path to a workspace's data folder.
 */
async function getDataFolderPath(id: string): Promise<string> {
	const workspacesDir = await getWorkspacesDir();
	return join(workspacesDir, id);
}

/**
 * List all workspace definitions by reading definition.json from each workspace folder.
 */
export async function listWorkspaces(): Promise<WorkspaceDefinition[]> {
	const workspacesDir = await getWorkspacesDir();

	let entries: Awaited<ReturnType<typeof readDir>>;
	try {
		entries = await readDir(workspacesDir);
	} catch {
		// Directory doesn't exist yet, return empty array
		return [];
	}

	const definitions: WorkspaceDefinition[] = [];

	for (const entry of entries) {
		// Only process directories (each workspace is a folder)
		if (!entry.isDirectory) continue;

		const definitionPath = await join(
			workspacesDir,
			entry.name,
			'definition.json',
		);
		try {
			const content = await readTextFile(definitionPath);
			const definition = JSON.parse(content) as WorkspaceDefinition;
			definitions.push(definition);
		} catch {
			// Skip folders without valid definition.json
			console.warn(
				`Failed to read workspace definition: ${entry.name}/definition.json`,
			);
		}
	}

	return definitions;
}

/**
 * Get a single workspace definition by ID.
 */
export async function getWorkspace(
	id: string,
): Promise<WorkspaceDefinition | null> {
	const filePath = await getDefinitionPath(id);

	try {
		const content = await readTextFile(filePath);
		return JSON.parse(content) as WorkspaceDefinition;
	} catch {
		return null;
	}
}

/**
 * Create a new workspace (create folder + write definition.json inside).
 */
export async function createWorkspaceDefinition(
	input: Omit<WorkspaceDefinition, 'id'> & { id?: string },
): Promise<WorkspaceDefinition> {
	const id = input.id ?? crypto.randomUUID();
	const definition: WorkspaceDefinition = {
		id,
		name: input.name,
		description: input.description,
		icon: input.icon,
		tables: input.tables,
		kv: input.kv,
	};

	const dataFolderPath = await getDataFolderPath(id);
	const definitionPath = await getDefinitionPath(id);

	// Create workspace folder (this also ensures parent workspaces/ dir exists)
	await mkdir(dataFolderPath, { recursive: true });

	// Write definition.json inside the workspace folder
	await writeTextFile(definitionPath, JSON.stringify(definition, null, '\t'));

	return definition;
}

/**
 * Update a workspace definition.
 */
export async function updateWorkspaceDefinition(
	id: string,
	updates: Partial<Omit<WorkspaceDefinition, 'id'>>,
): Promise<WorkspaceDefinition | null> {
	const existing = await getWorkspace(id);
	if (!existing) return null;

	const updated: WorkspaceDefinition = {
		...existing,
		...updates,
		id, // Ensure id cannot be changed
	};

	const definitionPath = await getDefinitionPath(id);
	await writeTextFile(definitionPath, JSON.stringify(updated, null, '\t'));

	return updated;
}

/**
 * Delete a workspace and all its data (definition.json is inside the folder).
 */
export async function deleteWorkspace(id: string): Promise<boolean> {
	const dataFolderPath = await getDataFolderPath(id);

	try {
		// Delete workspace folder recursively (includes definition.json)
		await remove(dataFolderPath, { recursive: true });
		return true;
	} catch {
		// Workspace folder doesn't exist
		return false;
	}
}
