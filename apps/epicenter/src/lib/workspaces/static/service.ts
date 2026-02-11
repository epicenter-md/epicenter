import { appLocalDataDir, join } from '@tauri-apps/api/path';
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import type { StaticWorkspaceEntry, StaticWorkspacesRegistry } from './types';

const REGISTRY_FILE = 'static-workspaces.json';

async function getRegistryPath(): Promise<string> {
	const baseDir = await appLocalDataDir();
	return join(baseDir, REGISTRY_FILE);
}

function createEmptyRegistry(): StaticWorkspacesRegistry {
	return { version: 1, workspaces: [] };
}

async function loadRegistry(): Promise<StaticWorkspacesRegistry> {
	const path = await getRegistryPath();
	try {
		const content = await readTextFile(path);
		return JSON.parse(content) as StaticWorkspacesRegistry;
	} catch {
		// File doesn't exist yet, return empty registry
		return createEmptyRegistry();
	}
}

/**
 * Save the static workspaces registry
 */
async function saveRegistry(registry: StaticWorkspacesRegistry): Promise<void> {
	const path = await getRegistryPath();
	await writeTextFile(path, JSON.stringify(registry, null, '\t'));
}

/**
 * List all registered static workspaces
 */
export async function listStaticWorkspaces(): Promise<StaticWorkspaceEntry[]> {
	const registry = await loadRegistry();
	return registry.workspaces;
}

/**
 * Get a single static workspace by ID
 */
export async function getStaticWorkspace(
	id: string,
): Promise<StaticWorkspaceEntry | null> {
	const registry = await loadRegistry();
	return registry.workspaces.find((w) => w.id === id) ?? null;
}

/**
 * Add a new static workspace to the registry
 */
export async function addStaticWorkspace(
	entry: Omit<StaticWorkspaceEntry, 'addedAt'>,
): Promise<StaticWorkspaceEntry> {
	const registry = await loadRegistry();

	// Check for duplicate
	if (registry.workspaces.some((w) => w.id === entry.id)) {
		throw new Error(`Static workspace "${entry.id}" already exists`);
	}

	const newEntry: StaticWorkspaceEntry = {
		...entry,
		addedAt: new Date().toISOString(),
	};

	registry.workspaces.push(newEntry);
	await saveRegistry(registry);

	return newEntry;
}
