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
 * Get the path to a workspace's JSON definition file.
 */
async function getDefinitionPath(id: string): Promise<string> {
	const workspacesDir = await getWorkspacesDir();
	return join(workspacesDir, `${id}.json`);
}

/**
 * Get the path to a workspace's data folder.
 */
async function getDataFolderPath(id: string): Promise<string> {
	const workspacesDir = await getWorkspacesDir();
	return join(workspacesDir, id);
}

/**
 * List all workspace definitions by reading JSON files.
 */
export async function listWorkspaces(): Promise<WorkspaceDefinition[]> {
	const workspacesDir = await getWorkspacesDir();

	let entries;
	try {
		entries = await readDir(workspacesDir);
	} catch {
		// Directory doesn't exist yet, return empty array
		return [];
	}

	const definitions: WorkspaceDefinition[] = [];

	for (const entry of entries) {
		// Only process .json files (not directories)
		if (!entry.name.endsWith('.json')) continue;

		const filePath = await join(workspacesDir, entry.name);
		try {
			const content = await readTextFile(filePath);
			const definition = JSON.parse(content) as WorkspaceDefinition;
			definitions.push(definition);
		} catch {
			// Skip files that can't be read or parsed
			console.warn(`Failed to read workspace definition: ${entry.name}`);
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
 * Create a new workspace (write JSON + create data folder).
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

	const workspacesDir = await getWorkspacesDir();
	const definitionPath = await getDefinitionPath(id);
	const dataFolderPath = await getDataFolderPath(id);

	// Ensure workspaces directory exists
	await mkdir(workspacesDir, { recursive: true });

	// Write definition JSON
	await writeTextFile(definitionPath, JSON.stringify(definition, null, '\t'));

	// Create data folder
	await mkdir(dataFolderPath, { recursive: true });

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
 * Delete a workspace and all its data.
 */
export async function deleteWorkspace(id: string): Promise<boolean> {
	const definitionPath = await getDefinitionPath(id);
	const dataFolderPath = await getDataFolderPath(id);

	try {
		// Delete definition JSON
		await remove(definitionPath);
	} catch {
		// Definition doesn't exist
		return false;
	}

	try {
		// Delete data folder recursively
		await remove(dataFolderPath, { recursive: true });
	} catch {
		// Data folder might not exist, that's okay
	}

	return true;
}
