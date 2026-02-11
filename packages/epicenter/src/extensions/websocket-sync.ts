import { WebsocketProvider } from 'y-websocket';
import { defineExports, type ExtensionFactory } from '../dynamic/extension';
import type { KvField, TableDefinition } from '../dynamic/schema';

// ═══════════════════════════════════════════════════════════════════════════════
// MULTI-DEVICE SYNC ARCHITECTURE
// ═══════════════════════════════════════════════════════════════════════════════
//
// Epicenter supports a distributed sync architecture where Y.Doc instances
// can be replicated across multiple devices and servers. Each device with a
// filesystem can run an Elysia server as a sync node.
//
// TOPOLOGY EXAMPLE (3 devices + optional cloud):
//
//   ┌─────────────────────────────────────────────────────────────────────────┐
//   │                        SYNC NODE NETWORK                                │
//   ├─────────────────────────────────────────────────────────────────────────┤
//   │                                                                         │
//   │   PHONE                   LAPTOP                    DESKTOP             │
//   │   ┌──────────┐           ┌──────────┐              ┌──────────┐        │
//   │   │ Browser  │           │ Browser  │              │ Browser  │        │
//   │   │ Y.Doc    │           │ Y.Doc    │              │ Y.Doc    │        │
//   │   └────┬─────┘           └────┬─────┘              └────┬─────┘        │
//   │        │                      │                         │              │
//   │   (no server)            ┌────▼─────┐              ┌────▼─────┐        │
//   │                          │ Elysia   │◄────────────►│ Elysia   │        │
//   │                          │ Y.Doc    │  server-to-  │ Y.Doc    │        │
//   │                          │ :3913    │    server    │ :3913    │        │
//   │                          └────┬─────┘              └────┬─────┘        │
//   │                               │                         │              │
//   │                               └──────────┬──────────────┘              │
//   │                                          │                             │
//   │                                   ┌──────▼──────┐                      │
//   │                                   │ Cloud Server│ (optional)           │
//   │                                   │ Y.Doc :3913 │                      │
//   │                                   └─────────────┘                      │
//   │                                                                         │
//   └─────────────────────────────────────────────────────────────────────────┘
//
// KEY CONCEPTS:
//
// 1. SYNC NODES: Any device with a filesystem can be a sync node (runs Elysia)
// 2. MULTI-PROVIDER: Yjs supports multiple extensions; changes merge via CRDTs
// 3. SERVER-TO-SERVER: Servers can sync with each other as clients
// 4. RESILIENCE: Connect to multiple nodes for redundancy
//
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Registry of sync nodes in your network.
 *
 * Define all your sync endpoints here. Each device with a filesystem
 * (laptop, desktop, cloud server) can run an Elysia sync server.
 *
 * @example
 * ```typescript
 * // Define your sync node network
 * export const SYNC_NODES = {
 *   // Local devices via Tailscale
 *   desktop: 'ws://desktop.my-tailnet.ts.net:3913/sync',
 *   laptop: 'ws://laptop.my-tailnet.ts.net:3913/sync',
 *
 *   // Cloud server (optional, always-on)
 *   cloud: 'wss://sync.myapp.com/sync',
 *
 *   // Localhost (for browser connecting to local server)
 *   localhost: 'ws://localhost:3913/sync',
 * } as const;
 *
 * export type SyncNodeId = keyof typeof SYNC_NODES;
 * ```
 */
export type SyncNodesConfig = Record<string, string>;

/**
 * Configuration for WebSocket sync extension.
 */
export type WebsocketSyncConfig = {
	/**
	 * WebSocket URL of the sync server.
	 *
	 * @example Single server
	 * ```typescript
	 * url: 'ws://localhost:3913/sync'
	 * ```
	 *
	 * @example Using SYNC_NODES constant
	 * ```typescript
	 * url: SYNC_NODES.desktop
	 * ```
	 */
	url: string;
};

/**
 * Creates a WebSocket sync extension for real-time collaboration.
 *
 * This extension uses y-websocket to connect to an Epicenter server's
 * sync endpoint for document synchronization and awareness.
 *
 * ## Multi-Device Architecture
 *
 * Yjs supports multiple extensions simultaneously. Create multiple extensions
 * to connect to multiple sync nodes for redundancy and resilience:
 *
 * ```typescript
 * // SYNC_NODES defined in your config
 * const SYNC_NODES = {
 *   desktop: 'ws://desktop.my-tailnet.ts.net:3913/sync',
 *   laptop: 'ws://laptop.my-tailnet.ts.net:3913/sync',
 *   cloud: 'wss://sync.myapp.com/sync',
 * } as const;
 * ```
 *
 * ## Extension Strategy Per Device
 *
 * | Device          | Role            | Connects To                    |
 * |-----------------|-----------------|--------------------------------|
 * | Phone browser   | Client only     | desktop, laptop, cloud         |
 * | Laptop browser  | Client          | localhost (own server)         |
 * | Desktop browser | Client          | localhost (own server)         |
 * | Laptop server   | Node + Client   | desktop, cloud (other servers) |
 * | Desktop server  | Node + Client   | laptop, cloud (other servers)  |
 * | Cloud server    | Node + Client   | (accepts connections only)     |
 *
 * ## Why This Works
 *
 * - **Yjs CRDTs**: Updates merge automatically regardless of delivery order
 * - **Deduplication**: Same update received from multiple extensions is applied once
 * - **Eventual consistency**: All Y.Docs converge to identical state
 *
 * **Note**: This extension requires the `y-websocket` package to be installed
 * in your client application. It's not bundled with @epicenter/hq to keep
 * the server package lightweight.
 *
 * @example Single extension (browser to local server)
 * ```typescript
 * import { createWorkspace } from '@epicenter/hq/dynamic';
 * import { websocketSync } from '@epicenter/hq/extensions/websocket-sync';
 *
 * // Browser connects to its own local Elysia server
 * const workspace = createWorkspace(definition).withExtensions({
 *   sync: websocketSync({ url: 'ws://localhost:3913/sync' }),
 * });
 * ```
 *
 * @example Multi-extension (phone connecting to all nodes)
 * ```typescript
 * import { createWorkspace } from '@epicenter/hq/dynamic';
 * import { websocketSync } from '@epicenter/hq/extensions/websocket-sync';
 *
 * const SYNC_NODES = {
 *   desktop: 'ws://desktop.my-tailnet.ts.net:3913/sync',
 *   laptop: 'ws://laptop.my-tailnet.ts.net:3913/sync',
 *   cloud: 'wss://sync.myapp.com/sync',
 * } as const;
 *
 * // Phone browser connects to ALL available sync nodes
 * const workspace = createWorkspace(definition).withExtensions({
 *   // Create an extension for each sync node
 *   syncDesktop: websocketSync({ url: SYNC_NODES.desktop }),
 *   syncLaptop: websocketSync({ url: SYNC_NODES.laptop }),
 *   syncCloud: websocketSync({ url: SYNC_NODES.cloud }),
 * });
 * ```
 *
 * @example Server-to-server sync (Elysia servers syncing with each other)
 * ```typescript
 * import { createWorkspace } from '@epicenter/hq/dynamic';
 * import { websocketSync } from '@epicenter/hq/extensions/websocket-sync';
 *
 * // Desktop server connects to laptop and cloud as a CLIENT
 * const SYNC_NODES = {
 *   laptop: 'ws://laptop.my-tailnet.ts.net:3913/sync',
 *   cloud: 'wss://sync.myapp.com/sync',
 * } as const;
 *
 * const workspace = createWorkspace(definition).withExtensions({
 *   // Server acts as both:
 *   // 1. A sync server (via createSyncPlugin in server.ts)
 *   // 2. A sync client connecting to other servers
 *   syncToLaptop: websocketSync({ url: SYNC_NODES.laptop }),
 *   syncToCloud: websocketSync({ url: SYNC_NODES.cloud }),
 * });
 * ```
 *
 * @example Direct usage with y-websocket (no Epicenter client)
 * ```typescript
 * import * as Y from 'yjs';
 * import { WebsocketProvider } from 'y-websocket';
 *
 * const doc = new Y.Doc();
 *
 * // Connect to multiple servers simultaneously
 * const providers = [
 *   new WebsocketProvider('ws://desktop.tailnet:3913/sync', 'blog', doc),
 *   new WebsocketProvider('ws://laptop.tailnet:3913/sync', 'blog', doc),
 *   new WebsocketProvider('wss://sync.myapp.com/sync', 'blog', doc),
 * ];
 *
 * // Changes sync through ALL connected extensions
 * providers.forEach(p => p.on('sync', () => console.log('Synced!')));
 * ```
 */
export function websocketSync<
	TTableDefinitions extends readonly TableDefinition[],
	TKvFields extends readonly KvField[],
>(config: WebsocketSyncConfig): ExtensionFactory<TTableDefinitions, TKvFields> {
	return ({ ydoc }) => {
		const provider = new WebsocketProvider(
			config.url,
			ydoc.guid, // Room name is the workspace ID (Y.Doc guid)
			ydoc,
		);

		return defineExports({
			destroy: () => {
				provider.destroy();
			},
		});
	};
}
