import {
	HocuspocusProvider,
	type HocuspocusProviderConfiguration,
} from '@hocuspocus/provider';
import type { Provider } from '../core/provider';

/**
 * Configuration for Hocuspocus collaboration provider.
 *
 * Extends HocuspocusProviderConfiguration but omits `name` and `document`
 * since those are automatically set from the workspace context.
 */
export type HocuspocusProviderConfig = {
	/** WebSocket URL of the Hocuspocus server (default: 'ws://127.0.0.1:3913') */
	url?: string;
} & Omit<HocuspocusProviderConfiguration, 'name' | 'document' | 'url'>;

/**
 * Creates a Hocuspocus provider for real-time collaboration.
 *
 * This provider connects to a Hocuspocus server and enables multiple clients
 * with the same workspace ID to sync their Yjs documents in real-time.
 *
 * **Best Practices:**
 * - Use authentication tokens in production
 * - Handle connection status for better UX
 * - Enable awareness for presence features (cursors, selections)
 * - Configure proper timeout and reconnection settings
 *
 * @example Basic usage
 * ```typescript
 * const workspace = defineWorkspace({
 *   id: 'blog',
 *   // ...
 *   providers: [
 *     createHocuspocusProvider({
 *       url: 'ws://localhost:1234',
 *     }),
 *   ],
 * });
 * ```
 *
 * @example With authentication
 * ```typescript
 * const workspace = defineWorkspace({
 *   id: 'blog',
 *   // ...
 *   providers: [
 *     createHocuspocusProvider({
 *       url: 'ws://localhost:1234',
 *       token: await getAuthToken(),
 *       onAuthenticationFailed: ({ reason }) => {
 *         console.error('Auth failed:', reason);
 *         // Redirect to login or refresh token
 *       },
 *     }),
 *   ],
 * });
 * ```
 *
 * @example With connection monitoring
 * ```typescript
 * const workspace = defineWorkspace({
 *   id: 'blog',
 *   // ...
 *   providers: [
 *     createHocuspocusProvider({
 *       url: 'ws://localhost:1234',
 *       onStatus: ({ status }) => {
 *         console.log('Connection status:', status);
 *         // Update UI to show connection state
 *       },
 *       onSynced: () => {
 *         console.log('Document synced!');
 *       },
 *       onError: (error) => {
 *         console.error('Connection error:', error);
 *       },
 *     }),
 *   ],
 * });
 * ```
 */
export function createHocuspocusProvider(
	config: HocuspocusProviderConfig = {},
): Provider {
	return ({ ydoc }) => {
		new HocuspocusProvider({
			...config,
			name: ydoc.guid,
			document: ydoc,
			url: config.url ?? 'ws://127.0.0.1:3913', // Default to localhost
		});
	};
}
