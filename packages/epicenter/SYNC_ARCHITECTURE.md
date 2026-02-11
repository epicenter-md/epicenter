# Multi-Device Sync Architecture

Epicenter's sync system enables Y.Doc replication across multiple devices and servers using WebSocket. Every device with a filesystem can run an Elysia server as a **sync node**, and Yjs's multi-provider support allows connecting to multiple nodes simultaneously.

## Core Concepts

### Sync Nodes

A **sync node** is any device running an Elysia server with the sync plugin enabled. Sync nodes:

- Hold a Y.Doc instance in memory
- Accept WebSocket connections from browsers and other servers
- Broadcast updates to all connected clients
- Can connect to OTHER sync nodes as a client (server-to-server sync)

### Multi-Provider Architecture

Yjs supports **multiple providers simultaneously**. Each provider connects to a different sync node, and changes merge automatically via CRDTs:

```typescript
// A Y.Doc can connect to multiple servers at once
const doc = new Y.Doc();

// Provider 1: Local desktop server
new WebsocketProvider('ws://desktop.tailnet:3913/sync', 'blog', doc);

// Provider 2: Laptop server
new WebsocketProvider('ws://laptop.tailnet:3913/sync', 'blog', doc);

// Provider 3: Cloud server
new WebsocketProvider('wss://sync.myapp.com/sync', 'blog', doc);

// Changes sync through ALL connected providers
// Yjs deduplicates updates automatically
```

### Why This Works

- **CRDTs**: Yjs uses Conflict-free Replicated Data Types; updates merge regardless of order
- **Vector Clocks**: Each update has a unique ID; same update received twice is applied once
- **Eventual Consistency**: All Y.Docs converge to identical state, guaranteed

## Network Topology

### Example Setup (3 Devices + Cloud)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          SYNC NODE NETWORK                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   PHONE                    LAPTOP                     DESKTOP               │
│   ┌──────────┐            ┌──────────┐              ┌──────────┐           │
│   │ Browser  │            │ Browser  │              │ Browser  │           │
│   │ Y.Doc    │            │ Y.Doc    │              │ Y.Doc    │           │
│   └────┬─────┘            └────┬─────┘              └────┬─────┘           │
│        │                       │                         │                  │
│   (no server)             ┌────▼─────┐              ┌────▼─────┐           │
│        │                  │ Elysia   │◄────────────►│ Elysia   │           │
│        │                  │ Y.Doc    │  server-to-  │ Y.Doc    │           │
│        │                  │ :3913    │    server    │ :3913    │           │
│        │                  └────┬─────┘              └────┬─────┘           │
│        │                       │                         │                  │
│        │                       └──────────┬──────────────┘                  │
│        │                                  │                                 │
│        │                           ┌──────▼──────┐                          │
│        └──────────────────────────►│ Cloud Server│◄─────────────────────────│
│                                    │ Y.Doc :3913 │                          │
│                                    └─────────────┘                          │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Y.Doc Instance Count

| Location        | Y.Doc Count | Notes                          |
| --------------- | ----------- | ------------------------------ |
| Phone browser   | 1           | Client only (no local server)  |
| Laptop browser  | 1           | Connects to localhost          |
| Desktop browser | 1           | Connects to localhost          |
| Laptop server   | 1           | Sync node                      |
| Desktop server  | 1           | Sync node                      |
| Cloud server    | 1           | Sync node (optional)           |
| **Total**       | **5-6**     | All stay in sync via providers |

## Sync Node Configuration

Define your sync nodes as a constant for easy reference:

```typescript
// src/config/sync-nodes.ts

/**
 * Registry of all sync nodes in your network.
 *
 * Each entry is a WebSocket URL to an Elysia server running the sync plugin.
 * Use Tailscale hostnames for local network devices.
 */
export const SYNC_NODES = {
	// Local devices via Tailscale
	desktop: 'ws://desktop.my-tailnet.ts.net:3913/sync',
	laptop: 'ws://laptop.my-tailnet.ts.net:3913/sync',

	// Cloud server (optional, always-on)
	cloud: 'wss://sync.myapp.com/sync',

	// Localhost (for browser connecting to local server)
	localhost: 'ws://localhost:3913/sync',
} as const;

export type SyncNodeId = keyof typeof SYNC_NODES;
```

## Provider Strategy Per Device

Different devices need different provider configurations.

### Quick Reference Table

| Device              | Acts As         | Providers (Connects To)                                       | Rationale                                       |
| ------------------- | --------------- | ------------------------------------------------------------- | ----------------------------------------------- |
| **Phone browser**   | Client only     | `SYNC_NODES.desktop`, `SYNC_NODES.laptop`, `SYNC_NODES.cloud` | No local server; connect to all available nodes |
| **Laptop browser**  | Client          | `SYNC_NODES.localhost`                                        | Server handles cross-device sync                |
| **Desktop browser** | Client          | `SYNC_NODES.localhost`                                        | Server handles cross-device sync                |
| **Laptop server**   | Server + Client | `SYNC_NODES.desktop`, `SYNC_NODES.cloud`                      | Sync with OTHER servers (not itself)            |
| **Desktop server**  | Server + Client | `SYNC_NODES.laptop`, `SYNC_NODES.cloud`                       | Sync with OTHER servers (not itself)            |
| **Cloud server**    | Server only     | (none)                                                        | Accepts connections; doesn't initiate           |

### Key Insight

- **Browsers** on laptop/desktop only connect to `localhost`. Their local server handles all cross-device sync.
- **Servers** connect to OTHER servers (never themselves). This creates server-to-server sync.
- **Phone** has no server, so it connects directly to all available sync nodes for resilience.

### Phone Browser Configuration

Phone has no local server, so it connects directly to all available sync nodes:

```typescript
// phone/src/workspace.ts
import { defineWorkspace } from '@epicenter/hq/dynamic';
import { websocketSync } from '@epicenter/hq/extensions/websocket-sync';
import { SYNC_NODES } from './config/sync-nodes';

export const blogWorkspace = defineWorkspace({
	id: 'blog',
	tables: {
		/* ... */
	},
	providers: {
		// Connect to ALL sync nodes for maximum resilience
		syncDesktop: websocketSync({ url: SYNC_NODES.desktop }),
		syncLaptop: websocketSync({ url: SYNC_NODES.laptop }),
		syncCloud: websocketSync({ url: SYNC_NODES.cloud }),
	},
	actions: ({ tables }) => ({
		/* ... */
	}),
});
```

### Laptop/Desktop Browser Configuration

Browser connects to its own local server (localhost). The server handles cross-device sync.

```typescript
// desktop/browser/src/workspace.ts
import { defineWorkspace } from '@epicenter/hq/dynamic';
import { websocketSync } from '@epicenter/hq/extensions/websocket-sync';
import { SYNC_NODES } from './config/sync-nodes';

export const blogWorkspace = defineWorkspace({
	id: 'blog',
	tables: {
		/* ... */
	},
	providers: {
		// Browser only needs to connect to its local server
		// The server handles syncing with other devices
		sync: websocketSync({ url: SYNC_NODES.localhost }),
	},
	actions: ({ tables }) => ({
		/* ... */
	}),
});
```

### Desktop Server Configuration (Server-to-Server Sync)

The server acts as BOTH:

1. A sync server (accepts connections via `createSyncPlugin`)
2. A sync client (connects to other servers)

```typescript
// desktop/server/src/workspace.ts
import { defineWorkspace } from '@epicenter/hq/dynamic';
import { websocketSync } from '@epicenter/hq/extensions/websocket-sync';
import { SYNC_NODES } from './config/sync-nodes';

export const blogWorkspace = defineWorkspace({
	id: 'blog',
	tables: {
		/* ... */
	},
	providers: {
		// Connect to OTHER sync nodes (not itself!)
		// Desktop connects to: laptop + cloud
		syncToLaptop: websocketSync({ url: SYNC_NODES.laptop }),
		syncToCloud: websocketSync({ url: SYNC_NODES.cloud }),
	},
	actions: ({ tables }) => ({
		/* ... */
	}),
});
```

### Laptop Server Configuration

```typescript
// laptop/server/src/workspace.ts
import { defineWorkspace } from '@epicenter/hq/dynamic';
import { websocketSync } from '@epicenter/hq/extensions/websocket-sync';
import { SYNC_NODES } from './config/sync-nodes';

export const blogWorkspace = defineWorkspace({
	id: 'blog',
	tables: {
		/* ... */
	},
	providers: {
		// Laptop connects to: desktop + cloud
		syncToDesktop: websocketSync({ url: SYNC_NODES.desktop }),
		syncToCloud: websocketSync({ url: SYNC_NODES.cloud }),
	},
	actions: ({ tables }) => ({
		/* ... */
	}),
});
```

### Cloud Server Configuration

Cloud server typically only accepts connections (doesn't initiate):

```typescript
// cloud/src/workspace.ts
import { defineWorkspace } from '@epicenter/hq/dynamic';

export const blogWorkspace = defineWorkspace({
	id: 'blog',
	tables: {
		/* ... */
	},
	providers: {
		// Cloud server has no outgoing sync providers
		// It only accepts incoming connections via createSyncPlugin
	},
	actions: ({ tables }) => ({
		/* ... */
	}),
});
```

## Data Flow Examples

### Scenario 1: Phone Edits While All Devices Online

```
1. Phone edits document
2. Update sent to desktop server (via WebSocket)
3. Desktop server:
   - Applies update to its Y.Doc
   - Broadcasts to desktop browser
   - Sends to laptop server (server-to-server)
   - Sends to cloud server (server-to-server)
4. Laptop server:
   - Applies update
   - Broadcasts to laptop browser
5. All 6 Y.Docs now have the update
```

### Scenario 2: Desktop Browser Edits Offline

```
1. Desktop browser edits while offline
2. Update stored in IndexedDB (via y-indexeddb)
3. Desktop browser reconnects
4. Update sent to localhost (desktop server)
5. Desktop server broadcasts to all connected clients/servers
6. All devices converge
```

### Scenario 3: Two Devices Edit Simultaneously

```
1. Phone edits "Hello"
2. Laptop browser edits "World"
3. Both updates propagate through network
4. Yjs CRDTs merge automatically
5. All devices see "Hello World" (or merged result)
```

## Offline Support

Each device should also use local persistence:

```typescript
import { persistence } from '@epicenter/hq/extensions/persistence';
import { websocketSync } from '@epicenter/hq/extensions/websocket-sync';

const workspace = defineWorkspace({
	id: 'blog',
	providers: {
		// Local persistence (IndexedDB in browser, filesystem in Node.js)
		persistence,

		// Network sync
		sync: websocketSync({ url: SYNC_NODES.desktop }),
	},
});
```

When offline:

1. Changes saved to IndexedDB/filesystem
2. When back online, Yjs syncs missed updates
3. CRDTs ensure consistent merge

## Tailscale Integration

[Tailscale](https://tailscale.com/) provides a private mesh VPN that makes all your devices directly reachable:

- **No port forwarding**: Devices get stable hostnames like `desktop.my-tailnet.ts.net`
- **End-to-end encryption**: WireGuard tunnels between devices
- **Works anywhere**: Home, office, cellular; devices always reachable

```typescript
// With Tailscale, use hostnames instead of IPs
const SYNC_NODES = {
	desktop: 'ws://desktop.my-tailnet.ts.net:3913/sync', // Tailscale hostname
	laptop: 'ws://laptop.my-tailnet.ts.net:3913/sync', // Tailscale hostname
	cloud: 'wss://sync.myapp.com/sync', // Public domain
} as const;
```

## Monitoring and Debugging

### Connection Status

```typescript
import { WebsocketProvider } from 'y-websocket';

const provider = new WebsocketProvider(url, roomId, doc);

provider.on('status', ({ status }) => {
	console.log(`Connection to ${url}: ${status}`);
	// 'connecting' | 'connected' | 'disconnected'
});

provider.on('sync', (isSynced) => {
	console.log(`Synced with ${url}: ${isSynced}`);
});
```

### Check Y.Doc State

```typescript
// See current document state
console.log(doc.toJSON());

// See client ID (unique per Y.Doc instance)
console.log(doc.clientID);

// See state vector (what this doc has seen)
console.log(Y.encodeStateVector(doc));
```

## Summary

| Component            | Purpose                                     |
| -------------------- | ------------------------------------------- |
| **SYNC_NODES**       | Constant defining all sync endpoints        |
| **websocketSync**    | Creates a provider for one sync node        |
| **Multi-provider**   | Connect to multiple nodes simultaneously    |
| **Server-to-server** | Servers sync with each other as clients     |
| **Tailscale**        | Private network for device-to-device access |
| **persistence**      | Local persistence for offline support       |

The architecture scales from "just my devices on Tailscale" to "add a cloud server later" without fundamental changes. Start simple and add providers as needed.
