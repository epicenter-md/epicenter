import type { AnyWorkspaceConfig } from '../workspace';

/**
 * Epicenter configuration
 * Defines a collection of workspaces that work together
 *
 * @example
 * ```typescript
 * const epicenter = defineEpicenter({
 *   id: 'my-app',
 *   workspaces: [pages, contentHub, auth],
 * });
 *
 * const client = await createEpicenterClient(epicenter);
 *
 * // Access workspace actions by workspace id
 * await client.pages.createPage({ title: 'Hello' });
 * await client.contentHub.createYouTubePost({ pageId: '1', ... });
 * await client.auth.login({ email: 'user@example.com' });
 * ```
 */
export type EpicenterConfig<
	TId extends string = string,
	TWorkspaces extends
		readonly AnyWorkspaceConfig[] = readonly AnyWorkspaceConfig[],
> = {
	/**
	 * Unique identifier for this epicenter instance
	 * Used to distinguish between different epicenter configurations
	 *
	 * @example 'my-app', 'content-platform', 'analytics-dashboard'
	 */
	id: TId;

	/**
	 * Base directory for all Epicenter storage (databases, markdown files, persistence)
	 *
	 * - Defaults to process.cwd() in Node.js (where epicenter commands are run)
	 * - Ignored in browser environments
	 * - Can be overridden per-index/provider if needed
	 *
	 * @example
	 * ```typescript
	 * // Store everything in /data/epicenter
	 * export default defineEpicenter({
	 *   storageDir: '/data/epicenter',
	 *   workspaces: [...]
	 * });
	 *
	 * // Use environment variable
	 * export default defineEpicenter({
	 *   storageDir: process.env.EPICENTER_STORAGE_DIR,
	 *   workspaces: [...]
	 * });
	 * ```
	 */
	storageDir?: string;

	/**
	 * Array of workspace configurations to compose
	 * Each workspace will be initialized and made available in the client
	 * Workspaces are accessed by their name property
	 *
	 * @example
	 * ```typescript
	 * workspaces: [
	 *   pages,      // name: 'pages'
	 *   contentHub, // name: 'content-hub'
	 *   auth,       // name: 'auth'
	 * ]
	 * ```
	 */
	workspaces: TWorkspaces;
};

/**
 * Define an epicenter configuration
 * Validates and returns the epicenter config
 *
 * @param config - Epicenter configuration
 * @returns Validated epicenter configuration
 *
 * @example
 * ```typescript
 * export const epicenter = defineEpicenter({
 *   id: 'my-app',
 *   workspaces: [pages, contentHub],
 * });
 * ```
 */
export function defineEpicenter<
	const TId extends string,
	const TWorkspaces extends readonly AnyWorkspaceConfig[],
>(
	config: EpicenterConfig<TId, TWorkspaces>,
): EpicenterConfig<TId, TWorkspaces> {
	// Validate epicenter ID
	if (!config.id || typeof config.id !== 'string') {
		throw new Error('Epicenter must have a valid string ID');
	}

	// Validate workspaces array
	if (!Array.isArray(config.workspaces)) {
		throw new Error('Workspaces must be an array of workspace configs');
	}

	if (config.workspaces.length === 0) {
		throw new Error('Epicenter must have at least one workspace');
	}

	// Validate each workspace
	for (const workspace of config.workspaces) {
		if (!workspace || typeof workspace !== 'object' || !workspace.id) {
			throw new Error(
				'Invalid workspace: workspaces must be workspace configs with id, schema, indexes, and actions',
			);
		}
	}

	// Check for duplicate workspace IDs
	const ids = config.workspaces.map((ws) => ws.id);
	const uniqueIds = new Set(ids);
	if (uniqueIds.size !== ids.length) {
		const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
		throw new Error(
			`Duplicate workspace IDs detected: ${duplicates.join(', ')}. ` +
				`Each workspace must have a unique ID.`,
		);
	}

	return config;
}
