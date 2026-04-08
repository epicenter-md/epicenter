/**
 * Workspace config loader.
 *
 * Loads `epicenter.config.ts` and collects all named `WorkspaceClient` exports
 * (results of `createWorkspace()`). Default exports are ignored—use named exports
 * so multi-workspace configs are unambiguous and export names appear in error messages.
 *
 * @example
 * ```typescript
 * // epicenter.config.ts:
 * //   export const notes = createNotesWorkspace();
 * //   export const tasks = createTasksWorkspace();
 *
 * const { clients } = await loadConfig('/path/to/project');
 * ```
 */

import { join, resolve } from 'node:path';
import type { AnyWorkspaceClient } from '@epicenter/workspace';

const CONFIG_FILENAME = 'epicenter.config.ts';

export type LoadConfigResult = {
	/** Absolute path to the directory containing epicenter.config.ts. */
	configDir: string;
	/** Workspace clients loaded from the config. */
	clients: AnyWorkspaceClient[];
};

/**
 * Load workspace clients from an epicenter.config.ts file.
 * Collects all named exports that pass the workspace client duck-type check.
 * Default exports are skipped. Deduplicates by workspace ID.
 *
 * @param targetDir - Directory containing epicenter.config.ts.
 * @throws If no config file found or no valid exports detected.
 */
export async function loadConfig(targetDir: string): Promise<LoadConfigResult> {
	const configDir = resolve(targetDir);
	const configPath = join(configDir, CONFIG_FILENAME);

	if (!(await Bun.file(configPath).exists())) {
		throw new Error(`No ${CONFIG_FILENAME} found in ${configDir}`);
	}

	const module = await import(Bun.pathToFileURL(configPath).href);

	const clients: AnyWorkspaceClient[] = [];
	const seenIds = new Set<string>();

	for (const [name, value] of Object.entries(module)) {
		if (name === 'default') continue;
		if (!isWorkspaceClient(value)) continue;

		if (seenIds.has(value.id)) {
			throw new Error(
				`Duplicate workspace ID "${value.id}" found in ${CONFIG_FILENAME} (export "${name}")`,
			);
		}
		seenIds.add(value.id);
		clients.push(value);
	}

	if (clients.length === 0) {
		const hasDefault = isWorkspaceClient(module.default);
		const hint = hasDefault
			? `\nFound a default export—use a named export instead:\n  export const myApp = createMyWorkspace()`
			: `\nExport createWorkspace() results as named exports:\n  export const myApp = createMyWorkspace()`;
		throw new Error(`No workspace clients found in ${CONFIG_FILENAME}.${hint}`);
	}

	return { configDir, clients };
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/** A pre-wired client has `definitions` and `tables` (set by createWorkspace). */
function isWorkspaceClient(value: unknown): value is AnyWorkspaceClient {
	if (typeof value !== 'object' || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.id === 'string' &&
		'definitions' in record &&
		'tables' in record
	);
}
