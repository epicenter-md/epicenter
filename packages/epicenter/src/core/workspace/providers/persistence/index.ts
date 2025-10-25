import type { ProviderContext } from '../../config';

/**
 * Universal persistence provider that automatically detects the environment
 * and uses the appropriate persistence strategy.
 *
 * **Environment Detection**:
 * - Browser (has `window` global) → IndexedDB via `y-indexeddb`
 * - Node-like (no `window`) → Filesystem in `.epicenter/` directory
 *
 * **How it works**:
 * - Uses standard `typeof window !== 'undefined'` check
 * - Dynamically imports the appropriate implementation
 * - Works across all bundlers (Vite, Webpack, esbuild) and runtimes (Node, Bun, Deno)
 *
 * **Storage locations**:
 * - Browser: IndexedDB database named after workspace ID
 * - Desktop: `./.epicenter/${workspaceId}.yjs` file
 *
 * @example Basic usage (works everywhere)
 * ```typescript
 * import { defineWorkspace } from '@repo/epicenter';
 * import { setupPersistence } from '@repo/epicenter/persistence';
 *
 * const workspace = defineWorkspace({
 *   id: 'blog',
 *   providers: [setupPersistence],
 *   // ... schema, indexes, actions
 * });
 *
 * // In browser: uses IndexedDB
 * // In Node/Bun: uses filesystem (.epicenter/blog.yjs)
 * ```
 *
 * @example Multi-workspace (both environments)
 * ```typescript
 * const blog = defineWorkspace({
 *   id: 'blog',
 *   providers: [setupPersistence],
 * });
 *
 * const notes = defineWorkspace({
 *   id: 'notes',
 *   providers: [setupPersistence],
 * });
 *
 * // Browser: Creates separate IndexedDB databases
 * // Desktop: Creates .epicenter/blog.yjs and .epicenter/notes.yjs
 * ```
 *
 * @example With sync provider (common pattern)
 * ```typescript
 * import { createHocuspocusProvider } from '@repo/epicenter';
 *
 * const workspace = defineWorkspace({
 *   id: 'blog',
 *   providers: [
 *     setupPersistence,  // Local persistence
 *     createHocuspocusProvider({ url: 'ws://localhost:1234' }),  // Sync
 *   ],
 * });
 * ```
 */
export async function setupPersistence(
	context: ProviderContext,
): Promise<void> {
	const isBrowser = typeof window !== 'undefined';

	if (isBrowser) {
		// Browser: use IndexedDB
		const { setupPersistence } = await import('./web.js');
		setupPersistence(context);
	} else {
		// Node-like: use filesystem
		const { setupPersistence } = await import('./desktop.js');
		await setupPersistence(context);
	}
}

export { EPICENTER_STORAGE_DIR } from './desktop';
