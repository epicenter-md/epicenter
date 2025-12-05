import type * as Y from 'yjs';
import type { EpicenterDir, StorageDir } from './types';

/**
 * Context provided to each YJS provider function.
 *
 * Provides workspace metadata and the YJS document that providers attach to.
 *
 * @property id - The workspace ID (e.g., 'blog', 'content-hub')
 * @property ydoc - The YJS document that providers attach to
 * @property storageDir - Absolute storage directory path resolved from epicenter config
 *   - Node.js: Resolved to absolute path (defaults to `process.cwd()` if not specified in config)
 *   - Browser: `undefined` (filesystem operations not available)
 * @property epicenterDir - Absolute path to the `.epicenter` directory
 *   - Computed as `path.join(storageDir, '.epicenter')`
 *   - `undefined` in browser environment
 *
 * @example Using epicenterDir in a provider
 * ```typescript
 * const myProvider: Provider = ({ id, ydoc, epicenterDir }) => {
 *   console.log(`Setting up provider for workspace: ${id}`);
 *
 *   // Check for Node.js environment
 *   if (!epicenterDir) {
 *     throw new Error('This provider requires Node.js environment');
 *   }
 *
 *   // Use epicenterDir directly for storage paths
 *   const filePath = path.join(epicenterDir, `${id}.yjs`);
 * };
 * ```
 */
export type ProviderContext = {
	id: string;
	ydoc: Y.Doc;
	storageDir: StorageDir | undefined;
	epicenterDir: EpicenterDir | undefined;
};

/**
 * A YJS provider function that attaches external capabilities to a YDoc.
 *
 * Providers can be:
 * - **Persistence**: Save/load YDoc state (filesystem, IndexedDB)
 * - **Synchronization**: Real-time collaboration (WebSocket, WebRTC)
 * - **Observability**: Logging, debugging, analytics
 *
 * Providers can be synchronous or asynchronous. Async providers are awaited during workspace initialization.
 *
 * @example Persistence provider
 * ```typescript
 * const persistenceProvider: Provider = ({ ydoc }) => {
 *   new IndexeddbPersistence('my-db', ydoc);
 * };
 * ```
 *
 * @example Sync provider
 * ```typescript
 * const syncProvider: Provider = ({ ydoc }) => {
 *   new WebsocketProvider('ws://localhost:1234', 'my-room', ydoc);
 * };
 * ```
 */
export type Provider = (context: ProviderContext) => void | Promise<void>;
