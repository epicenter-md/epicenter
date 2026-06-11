# Plugin-First Server Architecture

**Date**: 2026-02-20
**Status**: Draft
**Author**: Braden + Claude
**Supersedes**: `specs/20260219T195846-standalone-sync-server.md`, `specs/20260220T044539-pure-sync-server.md`, `specs/20260219T204521 sync-server-redesign.md`
**Relates to**: `specs/20260219T195800-server-architecture-rethink.md` (this spec implements Layers 0+1 and lays groundwork for 2+3), `specs/20260213T120800-extract-epicenter-server-package.md` (Phase 1 complete, this replaces Phase 2)

## Overview

Restructure `@epicenter/server` around two independent Elysia plugins: a sync plugin with zero `@epicenter/workspace` dependency and a workspace plugin that provides REST tables, actions, and OpenAPI. Convenience wrappers (`createSyncServer`, `createServer`) compose the plugins for users who don't want to touch Elysia directly. The sync plugin fixes the ws identity tracking bug and adds auth.

## Motivation

### Current State

The server is already built from Elysia plugins, but they're private to `createServer()`:

```typescript
// packages/server/src/server.ts: plugins exist but aren't exported
function createServerInternal(clients: AnyWorkspaceClient[], options?: ServerOptions) {
  const app = new Elysia()
    .use(openapi({ ... }))
    .use(createSyncPlugin({ getDoc: (room) => workspaces[room]?.ydoc }))
    .use(createTablesPlugin(workspaces));

  for (const router of actionRouters) {
    app.use(router);
  }
}
```

This creates four problems:

1. **Sync requires workspace schemas.** `createSyncPlugin` receives `getDoc` from `createServer`, which maps workspace IDs to `client.ydoc`. Connecting to an unknown room returns 4004. Two devices can't sync a Y.Doc without defining table schemas first.

2. **No auth.** The client sends `?token=xxx` in the WebSocket URL. The server ignores it. Any connection is accepted.

3. **Plugins aren't composable.** Users can't mount sync on one port and REST on another. They can't add sync to their own Elysia app. They can't use sync without tables. The only entry point is `createServer(clients)`: all or nothing.

4. **The ws identity bug.** The sync plugin tracks connections using Elysia wrapper objects. Elysia creates a new wrapper for each event (open, message, close), so `ws` in close() is a different object than `ws` in open(). `rooms.get(room).delete(ws)` can't find the ws that was added. Rooms never empty. Eviction never triggers. Memory leaks.

### Desired State

```typescript
// Use case 1: Pure sync relay (NAS, Mac Mini, Tailscale)
import { createSyncServer } from '@epicenter/server/sync';
createSyncServer({ port: 3913, auth: { token: 'my-secret' } }).start();

// Use case 2: Full workspace server (existing behavior, backward compatible)
import { createServer } from '@epicenter/server';
createServer(clients, { port: 3913 }).start();

// Use case 3: Custom composition (power users)
import { createSyncPlugin } from '@epicenter/server/sync';
import { createWorkspacePlugin } from '@epicenter/server';

const app = new Elysia()
	.use(createSyncPlugin({ auth: { token: 'secret' } }))
	.use(createWorkspacePlugin(clients))
	.get('/health', () => 'ok')
	.listen(3913);
```

## Research Findings

### Elysia Plugin Composition

Elysia plugins are functions that receive and return an Elysia instance. They compose via `.use()`:

```typescript
const plugin = new Elysia()
  .ws('/path', { open(ws) { ... }, message(ws, msg) { ... } })

const app = new Elysia()
  .use(plugin)           // mount the plugin's routes
  .use(anotherPlugin)    // compose multiple plugins
  .listen(3913)
```

Key behaviors:

- Plugins share the same server instance (routes merge)
- WebSocket routes can live in plugins: Elysia wires them into Bun's `.ws()` handler
- IMPORTANT: Must use `app.listen()` not `Bun.serve({ fetch: app.fetch })`: the latter skips WebSocket handler registration
- Plugins can use `Elysia({ prefix: '/api' })` for route namespacing
- Multiple Elysia instances can listen on different ports independently

### How y-websocket and y-sweet Handle Room Management

| Aspect          | y-websocket                                 | y-sweet                                          | Current epicenter server                 |
| --------------- | ------------------------------------------- | ------------------------------------------------ | ---------------------------------------- |
| Room creation   | On-demand (first connection creates Y.Doc)  | On-demand via `get_or_create_doc`                | Pre-registered only (4004 if unknown)    |
| Auth            | None built-in                               | Two-tier: server token + client token (JWT-like) | None                                     |
| Room routing    | URL path = room name                        | `/d/:id/ws/:id` path-based                       | `/workspaces/:id/ws`                     |
| Connection ID   | Node `ws` library (stable objects)          | Rust (stable connection IDs)                     | Elysia wrappers (NOT stable)             |
| Doc persistence | Optional callback (`persistence.bindState`) | `SyncKv` with filesystem/S3 backends             | Delegates to workspace client extensions |
| Room eviction   | No built-in eviction                        | `doc_gc_worker` evicts after inactivity          | 60s timer (never triggers due to bug)    |

**Key finding**: Both y-websocket and y-sweet create docs on-demand and use identity-stable connection objects. Our architecture should match: rooms on-demand, `ws.raw` for stable identity.

### Auth Token Transport

| Transport                   | WebSocket | HTTP REST | Notes                                             |
| --------------------------- | --------- | --------- | ------------------------------------------------- |
| `?token=xxx` query param    | Yes       | Yes       | Simple. Visible in logs/proxies. Fine for LAN.    |
| `Authorization: Bearer xxx` | No\*      | Yes       | Standard for REST. \*Browser WS can't set headers |
| Custom WS message (type 2)  | Yes       | No        | y-protocols reserves AUTH=2. More complex.        |

**Decision**: Use `?token=xxx` as the primary transport. It works for both WS and REST. Browser WebSocket API cannot set custom headers, making `Authorization` unusable for WS connections. For production deployments with JWTs, the `verifyToken` callback can validate JWTs passed via `?token=`. The token is a query parameter, not a path segment: no URL pattern changes needed.

## Design Decisions

| Decision               | Choice                                                                | Rationale                                                                                                                                                        |
| ---------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture           | Two Elysia plugins + convenience wrappers                             | Plugins are the primitive. Wrappers are sugar. Matches how Elysia is designed.                                                                                   |
| Sync plugin dependency | Zero `@epicenter/workspace` imports                                          | Sync only needs `yjs`, `lib0`, `y-protocols`, `elysia`. Decouples completely.                                                                                    |
| Room creation          | On-demand by default, `getDoc` override for workspace-integrated mode | Standalone mode creates docs automatically. Workspace mode provides existing docs.                                                                               |
| Connection tracking    | `ws.raw` keyed `Map`, not `Set`                                       | Fixes the identity bug by construction. `Map<object, { send }>` keyed by `ws.raw`.                                                                               |
| Auth modes             | Open (no auth), shared token, verify function                         | Matches the three modes in `@epicenter/sync` client. Verify function enables JWTs without us implementing JWT.                                                   |
| Auth check timing      | In WS `open` handler, close with 4401 on failure                      | Elysia's `.ws()` handler runs after HTTP upgrade. Rejecting before upgrade requires HTTP middleware which is more complex with Elysia. Close code 4401 is clean. |
| Route pattern          | Configurable `routePrefix`, default varies                            | Standalone sync: `/:room/ws`. Workspace plugin: `/workspaces/:id/ws`.                                                                                            |
| Package structure      | Subpath exports within `@epicenter/server`                            | One package, three entry points. Avoids release coordination of multiple packages.                                                                               |
| Backward compatibility | `createServer()` signature unchanged                                  | Existing users don't change anything. New capabilities are additive.                                                                                             |

## Architecture

### The Two Plugins

```
┌────────────────────────────────────────────────────────────────┐
│                      User's Choice                              │
│                                                                  │
│   createSyncServer()    createServer()     new Elysia()          │
│   (one-liner sync)     (one-liner full)   .use(plugins...)       │
│                                           (power users)          │
└────────────────────────────────────────────────────────────────┘
                    │              │              │
                    ▼              ▼              ▼
┌────────────────────────────────────────────────────────────────┐
│                    Elysia Plugin Layer                           │
│                                                                  │
│   createSyncPlugin(config?)      createWorkspacePlugin(clients)  │
│   ├── Room manager               ├── Tables plugin               │
│   ├── Auth (open/token/verify)   ├── Actions router              │
│   ├── WS protocol handler        ├── OpenAPI docs                │
│   ├── Ping/pong keepalive        └── Discovery endpoint          │
│   ├── GET / (room list)                                          │
│   ├── GET /:room/doc (snapshot)                                  │
│   └── POST /:room/doc (update)                                   │
│                                                                  │
│   Depends on:                    Depends on:                     │
│     elysia, yjs, lib0,            elysia, @epicenter/workspace          │
│     y-protocols                                                  │
│   NO @epicenter/workspace               (tables, actions, types)        │
└────────────────────────────────────────────────────────────────┘
                    │
                    ▼
┌────────────────────────────────────────────────────────────────┐
│                    Room Manager (extracted)                      │
│   createRoomManager(config?)                                     │
│   ├── rooms: Map<string, Room>                                   │
│   │   └── Room { doc, awareness, conns, evictionTimer }          │
│   │       └── conns: Map<object, { send }> (keyed by ws.raw)    │
│   ├── join(roomId, wsRaw, send)                                  │
│   ├── leave(roomId, wsRaw)                                       │
│   ├── broadcast(roomId, data, excludeRaw?)                       │
│   ├── getOrCreateDoc(roomId) → Y.Doc                             │
│   └── eviction: 60s after last connection leaves                 │
└────────────────────────────────────────────────────────────────┘
```

### Sync Plugin Modes

The sync plugin operates in two modes based on whether `getDoc` is provided:

```
Mode 1: Standalone (no getDoc)
──────────────────────────────
Client connects to /:room/ws
  → Room manager creates fresh Y.Doc on demand
  → Y.Doc is ephemeral (rebuilt from client state)
  → Room evicted 60s after last disconnect

Mode 2: Workspace-Integrated (getDoc provided)
───────────────────────────────────────────────
Client connects to /workspaces/:id/ws
  → getDoc(id) returns workspace's Y.Doc
  → If undefined → 4004 (room not found)
  → Room lifecycle managed by workspace client
```

`createServer()` uses Mode 2 internally. `createSyncServer()` uses Mode 1.

### Auth Flow

```
Client connects:  ws://host:3913/room/ws?token=my-secret

Server (open handler):
  1. Extract ?token from URL
  2. Check auth config:
     ├── No auth configured  → accept (Mode 1: open)
     ├── { token: 'secret' } → compare, reject with 4401 if mismatch (Mode 2: shared)
     └── { verify: fn }      → await fn(token), reject with 4401 if false (Mode 3: verify)
  3. If accepted → proceed with sync protocol
```

### Package Structure

```
packages/server/
  package.json
    exports:
      ".":      "./src/index.ts"
      "./sync": "./src/sync/index.ts"

  src/
    index.ts                    # createServer, createWorkspacePlugin (re-exports from submodules)
    server.ts                   # createServer(): backward compat wrapper
    workspace-plugin.ts         # createWorkspacePlugin(): tables + actions + openapi
    tables.ts                   # createTablesPlugin(): unchanged
    actions.ts                  # createActionsRouter(): unchanged
    sync/
      index.ts                  # createSyncPlugin, createSyncServer (public API for ./sync)
      plugin.ts                 # createSyncPlugin(): the Elysia plugin
      server.ts                 # createSyncServer(): convenience wrapper
      rooms.ts                  # createRoomManager(): extracted room lifecycle
      auth.ts                   # validateAuth(): token/verify logic
      protocol.ts               # unchanged: encode/decode functions
```

**Critical**: `src/sync/index.ts` must NOT import from `@epicenter/workspace`. The `./sync` subpath export is the dependency firewall.

`src/index.ts` re-exports `createServer` and `createWorkspacePlugin`. It does NOT re-export sync: users import sync from `@epicenter/server/sync` to avoid pulling in `@epicenter/workspace`.

### How createServer() Composes the Plugins

```typescript
// server.ts: backward compatible, composes both plugins
function createServer(
  clientOrClients: AnyWorkspaceClient | AnyWorkspaceClient[],
  options?: ServerOptions,
) {
  const clients = Array.isArray(clientOrClients) ? clientOrClients : [clientOrClients];
  const workspaces = Object.fromEntries(clients.map(c => [c.id, c]));

  const app = new Elysia()
    .use(openapi({ ... }))
    .use(createSyncPlugin({
      getDoc: (room) => workspaces[room]?.ydoc,
      auth: options?.auth,
      routePrefix: '/workspaces/:workspaceId/ws',
    }))
    .use(createWorkspacePlugin(clients));

  return {
    app,
    start() { app.listen(options?.port ?? DEFAULT_PORT); ... },
    async destroy() { ... },
  };
}
```

### How This Maps to the 5-Layer Vision

The server architecture rethink describes a staged kernel with 5 layers. This spec implements the first two and creates the structure for the rest:

| Kernel Layer             | This Spec                                              | Future                                                        |
| ------------------------ | ------------------------------------------------------ | ------------------------------------------------------------- |
| Layer 0: Transport       | `new Elysia().listen(port)`: always starts            | Same                                                          |
| Layer 1: Room Manager    | `createRoomManager()`: extracted, reusable            | Same                                                          |
| Layer 2: Schema Registry | - | Future `createSchemaPlugin()` reads contracts from filesystem |
| Layer 3: API Surface     | `createWorkspacePlugin()`: tables + actions + openapi | Derived from registry instead of live clients                 |
| Layer 4: Runtime         | `createServer(clients)` passes live clients            | Lazy workspace initialization on first data access            |

Each layer is an Elysia plugin. The staged kernel is a specific composition order. The plugins ARE the layers, no additional abstraction needed.

## `createSyncPlugin` API

```typescript
type SyncPluginConfig = {
	/**
	 * Resolve a Y.Doc for a room. Called when a client connects.
	 *
	 * - If provided and returns Y.Doc → use that doc for the room
	 * - If provided and returns undefined → close with 4004 (room not found)
	 * - If omitted → create a fresh Y.Doc on demand (standalone mode)
	 */
	getDoc?: (roomId: string) => Y.Doc | undefined;

	/**
	 * Auth configuration. Omit for open mode (no auth).
	 */
	auth?:
		| { token: string }
		| { verify: (token: string) => boolean | Promise<boolean> };

	/**
	 * Route prefix for the WebSocket endpoint.
	 * Default: '/:room/ws' (standalone) or '/workspaces/:workspaceId/ws' (when used in createServer)
	 */
	routePrefix?: string;

	/**
	 * Called when a room is created (first connection to a new room ID).
	 * Only fires in standalone mode (no getDoc).
	 */
	onRoomCreated?: (roomId: string, doc: Y.Doc) => void;

	/**
	 * Called when a room is evicted (60s after last connection leaves).
	 */
	onRoomEvicted?: (roomId: string, doc: Y.Doc) => void;
};

function createSyncPlugin(config?: SyncPluginConfig): Elysia;
```

## `createSyncServer` API

```typescript
type SyncServerConfig = {
	port?: number; // default: 3913
	auth?:
		| { token: string }
		| { verify: (token: string) => boolean | Promise<boolean> };
	onRoomCreated?: (roomId: string, doc: Y.Doc) => void;
	onRoomEvicted?: (roomId: string, doc: Y.Doc) => void;
};

function createSyncServer(config?: SyncServerConfig): {
	app: Elysia;
	start(): Server;
	destroy(): void;
};
```

Internally: `new Elysia().use(createSyncPlugin(config)).get('/', () => ({ status: 'ok', rooms: [...] }))`.

## `createWorkspacePlugin` API

```typescript
function createWorkspacePlugin(
	clients: AnyWorkspaceClient | AnyWorkspaceClient[],
): Elysia;
```

Bundles:

- `createTablesPlugin(workspaces)`: REST CRUD for all tables
- `createActionsRouter(...)`: query/mutation endpoints per workspace
- Discovery endpoint at `/` with workspace listing

Does NOT include sync, that's a separate plugin. Does NOT include OpenAPI, that's added by `createServer()` or by the user.

## `createRoomManager` (Internal)

```typescript
type Room = {
	doc: Y.Doc;
	awareness: Awareness;
	conns: Map<object, { send: (data: Buffer) => void }>; // keyed by ws.raw
	evictionTimer?: ReturnType<typeof setTimeout>;
};

type RoomManagerConfig = {
	getDoc?: (roomId: string) => Y.Doc | undefined;
	evictionTimeout?: number; // default: 60_000
	onRoomCreated?: (roomId: string, doc: Y.Doc) => void;
	onRoomEvicted?: (roomId: string, doc: Y.Doc) => void;
};

function createRoomManager(config?: RoomManagerConfig): {
	/** Add a connection to a room. Creates room if needed. Returns the Y.Doc or undefined (room rejected). */
	join(
		roomId: string,
		wsRaw: object,
		send: (data: Buffer) => void,
	): { doc: Y.Doc; awareness: Awareness } | undefined;

	/** Remove a connection from a room. Starts eviction timer if room is empty. */
	leave(roomId: string, wsRaw: object): void;

	/** Send data to all connections in a room except the sender. */
	broadcast(roomId: string, data: Buffer, excludeRaw?: object): void;

	/** Get an existing room's doc (for use in message handler). */
	getDoc(roomId: string): Y.Doc | undefined;

	/** Get awareness for a room. */
	getAwareness(roomId: string): Awareness | undefined;

	/** List active room IDs. */
	rooms(): string[];

	/** Destroy all rooms and clear timers. */
	destroy(): void;
};
```

The room manager is the core extracted from the current sync plugin. It's not exported from the package. It's an internal module used by `createSyncPlugin`. Making it public is a future consideration (for Durable Objects or custom transports).

### How the ws Identity Bug is Fixed

The current bug:

```typescript
// open handler: stores Elysia wrapper
rooms.get(room)!.add(ws);

// close handler: tries to delete a DIFFERENT Elysia wrapper
rooms.get(room)?.delete(ws); // ← different object, delete fails

// broadcast: comparison always passes (different objects)
if (conn !== ws) {
	conn.send(data);
} // ← sender receives own messages
```

The fix (in `createRoomManager`):

```typescript
// join(): stores ws.raw as key
room.conns.set(wsRaw, { send });

// leave(): deletes by ws.raw (same object reference)
room.conns.delete(wsRaw);

// broadcast(): filters by ws.raw identity
for (const [raw, conn] of room.conns) {
	if (raw !== excludeRaw) conn.send(data);
}
```

`ws.raw` is the underlying Bun `ServerWebSocket`: stable across all Elysia event handlers for the same connection. The room manager never touches Elysia wrappers. Bug is impossible by construction.

## Implementation Plan

### Phase 1: Extract room manager and fix ws bug

- [ ] **1.1** Create `packages/server/src/sync/rooms.ts` with `createRoomManager()`
- [ ] **1.2** Room uses `Map<object, { send }>` keyed by `ws.raw` for connection tracking
- [ ] **1.3** Implement `join()`: get-or-create room, add connection, cancel eviction timer if running
- [ ] **1.4** Implement `leave()`: remove connection by `ws.raw`, start eviction timer if room empty
- [ ] **1.5** Implement `broadcast()`: iterate `conns`, filter by `raw !== excludeRaw`
- [ ] **1.6** Implement `destroy()`: clear all rooms, cancel all timers
- [ ] **1.7** Port connection state tracking (awareness, update handler, ping interval, controlled client IDs) from current sync plugin into room manager or keep in plugin: decide during implementation

### Phase 2: Add auth to sync plugin

- [ ] **2.1** Create `packages/server/src/sync/auth.ts` with `validateAuth(config, token)` function
- [ ] **2.2** In sync plugin `open` handler: extract `?token` from URL, call `validateAuth`, close with 4401 on failure
- [ ] **2.3** If no auth configured, skip validation (open mode)
- [ ] **2.4** Support `{ token: string }` (direct comparison) and `{ verify: fn }` (callback)

### Phase 3: Refactor sync plugin to use room manager

- [ ] **3.1** Rewrite `createSyncPlugin` in `packages/server/src/sync/plugin.ts` using `createRoomManager`
- [ ] **3.2** Support two modes: standalone (no `getDoc`, rooms on-demand) and integrated (`getDoc` provided)
- [ ] **3.3** Keep protocol handling unchanged (`protocol.ts` is solid)
- [ ] **3.4** Support configurable `routePrefix`
- [ ] **3.5** Add `onRoomCreated` and `onRoomEvicted` callbacks

### Phase 4: Create convenience wrappers and workspace plugin

- [ ] **4.1** Create `packages/server/src/sync/server.ts` with `createSyncServer()`: wraps Elysia + sync plugin + health endpoint
- [ ] **4.2** Create `packages/server/src/workspace-plugin.ts` with `createWorkspacePlugin()`: bundles tables + actions
- [ ] **4.3** Update `createServer()` in `server.ts` to compose `createSyncPlugin` + `createWorkspacePlugin`
- [ ] **4.4** Pass `auth` option through `createServer` → sync plugin

### Phase 5: Package exports

- [ ] **5.1** Create `packages/server/src/sync/index.ts`: exports `createSyncPlugin`, `createSyncServer`
- [ ] **5.2** Update `packages/server/src/index.ts`: exports `createServer`, `createWorkspacePlugin`, `DEFAULT_PORT`
- [ ] **5.3** Add `"./sync": "./src/sync/index.ts"` to `package.json` exports
- [ ] **5.4** Verify `@epicenter/server/sync` has zero `@epicenter/workspace` imports (grep for it)
- [ ] **5.5** Update existing tests
- [ ] **5.6** Add new tests: sync plugin standalone mode, auth modes, room manager lifecycle

## Edge Cases

### Client connects with token in open mode

1. Server configured with no auth
2. Client sends `?token=xxx` anyway
3. Server ignores the token: connection accepted. The token is harmless.

### Client connects without token in token mode

1. Server configured with `{ token: 'secret' }`
2. Client connects without `?token=`
3. Server closes with 4401 (Unauthorized) in the `open` handler
4. Client's supervisor loop sees the close, backs off, retries

### Standalone sync: server restarts, rooms are lost

1. Server restarts: all in-memory Y.Docs are gone
2. Clients reconnect, each sends sync step 1 with their state vector
3. Server creates fresh Y.Doc, responds with empty sync step 2
4. Clients send their full state as updates
5. Server's Y.Doc is rebuilt from client state
6. Correct CRDT behavior: clients are source of truth

### Both plugins mounted on same Elysia app

1. User mounts sync plugin and workspace plugin on the same app
2. Sync plugin registers `/:room/ws` (standalone route)
3. Workspace plugin registers `/workspaces/:id/tables/...`
4. No route conflicts: different path patterns
5. If user wants workspace-integrated sync, they pass `getDoc` and set `routePrefix: '/workspaces/:workspaceId/ws'`

### createServer backward compatibility

1. Existing code: `createServer(client, { port: 3913 })`
2. Still works identically: `createServer` internally composes both plugins
3. New code: `createServer(client, { port: 3913, auth: { token: 'secret' } })`
4. Auth flows through to sync plugin: additive, no breaking change

## Open Questions

1. **Should `createWorkspacePlugin` include OpenAPI, or should that be separate?**
   - Options: (a) Include OpenAPI in workspace plugin, (b) Keep OpenAPI in `createServer` only, (c) Separate `createOpenApiPlugin`
   - **Recommendation**: (b) Keep in `createServer`. Power users who compose plugins may not want Scalar UI. `createServer` is the opinionated "batteries included" wrapper.

2. **Should `createRoomManager` be exported from the package?**
   - Options: (a) Internal only, (b) Export from `@epicenter/server/sync`
   - **Recommendation**: (a) Internal for now. Export when there's a real consumer (Durable Objects adapter, custom transport). Premature export creates API surface to maintain.

3. **Should standalone sync rooms have a max count?**
   - Options: (a) Unlimited, (b) Configurable limit, (c) Memory-based
   - **Recommendation**: (a) Unlimited for now. Eviction keeps memory bounded. Add limits when DoS is a real concern.

4. **Should the sync plugin expose room state via REST?**
   - Example: `GET /rooms` → `[{ id: 'blog', connections: 2 }]`
   - ~~**Recommendation**: Yes, but only in `createSyncServer` (the convenience wrapper adds a health endpoint). The raw plugin shouldn't add REST routes: it's a WS plugin.~~
   - **Updated**: Yes, directly in `createSyncPlugin`. See `specs/20260220T195900-sync-plugin-rest-endpoints.md`. The plugin registers `GET /` (room list), `GET /:room/doc` (binary snapshot), and `POST /:room/doc` (binary update) alongside the WS route. REST and WS operate on the same Y.Doc: they're the same concern.

## Success Criteria

- [ ] `createSyncServer({ port: 3913 })` starts a working sync relay with zero config
- [ ] Two `@epicenter/sync` clients can sync a Y.Doc through the standalone sync server
- [ ] Auth Mode 1 (open): Any client connects without token
- [ ] Auth Mode 2 (token): Client with correct `?token=` connects; wrong/missing rejected with 4401
- [ ] Auth Mode 3 (verify): Custom verify function is called and respected
- [ ] Room eviction works correctly (60s after last disconnect: fixes the current bug)
- [ ] Awareness broadcast doesn't echo back to sender (fixes the current bug)
- [ ] `createServer(client)` still works identically (backward compatible)
- [ ] `createServer(client, { auth: { token: 'secret' } })` adds auth to sync
- [ ] `import { createSyncPlugin } from '@epicenter/server/sync'` has zero `@epicenter/workspace` imports
- [ ] MESSAGE_SYNC_STATUS (102) heartbeat echo still works
- [ ] Existing server tests pass unchanged (or with minimal updates)
- [ ] Power user can mount `createSyncPlugin` on their own Elysia app

## References

- `packages/server/src/server.ts`: Current `createServer()` to refactor
- `packages/server/src/sync/index.ts`: Current sync plugin with ws identity bug (main refactor target)
- `packages/server/src/sync/protocol.ts`: Protocol layer (unchanged)
- `packages/server/src/tables.ts`: Tables plugin (unchanged, absorbed into workspace plugin)
- `packages/server/src/actions.ts`: Actions router (unchanged, absorbed into workspace plugin)
- `packages/server/package.json`: Add `./sync` subpath export
- `packages/sync/src/provider.ts`: Client-side sync provider (no changes needed)
- `packages/sync/src/types.ts`: Client auth mode types (reference for auth design)
- `specs/20260219T195800-server-architecture-rethink.md`: 5-layer vision (this spec is Layers 0+1)

## Review

### Implementation Summary

All 5 phases implemented in dependency order. Typecheck clean after each phase. All 56 existing tests pass unchanged.

### Files Created

| File                  | Purpose                                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `sync/rooms.ts`       | `createRoomManager()`: extracted room lifecycle, fixes ws identity bug via `Map<object, { send }>` keyed by `ws.raw` |
| `sync/auth.ts`        | `validateAuth()`: open/token/verify modes, `CLOSE_UNAUTHORIZED` constant                                             |
| `sync/plugin.ts`      | `createSyncPlugin()`: rewritten to use room manager + auth, configurable route prefix, standalone + integrated modes |
| `sync/server.ts`      | `createSyncServer()`: zero-config sync relay with health endpoint                                                    |
| `workspace-plugin.ts` | `createWorkspacePlugin()`: bundles tables + actions + discovery endpoint                                             |

### Files Modified

| File            | Changes                                                                                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sync/index.ts` | Replaced old buggy sync plugin with barrel export (3 re-exports)                                                                                           |
| `server.ts`     | Updated imports to use `sync/plugin` and `workspace-plugin`. Added `auth` option to `ServerOptions`. Simplified `createServerInternal` to compose plugins. |
| `index.ts`      | Added `createWorkspacePlugin` export                                                                                                                       |
| `package.json`  | Added `"./sync": "./src/sync/index.ts"` subpath export                                                                                                     |

### Open Questions Decisions

1. **OpenAPI placement** → (b) Keep in `createServer` only. `createWorkspacePlugin` does not include OpenAPI. Power users who compose plugins may not want Scalar UI; `createServer` is the opinionated batteries-included wrapper.

2. **Room manager export** → (a) Internal only. `createRoomManager` is not exported from the package. No external consumer exists yet. Export when there's a real use case (Durable Objects, custom transport).

3. **Room count limits** → (a) Unlimited. Eviction keeps memory bounded. Add limits when DoS is a real concern.

4. **REST room state in sync** → ~~Only in `createSyncServer` wrapper. The raw `createSyncPlugin` doesn't add REST routes: it's a WebSocket-only plugin.~~ **Amended**: REST endpoints (`GET /`, `GET /:room/doc`, `POST /:room/doc`) now live in `createSyncPlugin` directly. See `specs/20260220T195900-sync-plugin-rest-endpoints.md`.

5. **Connection state tracking (Phase 1.7)** → Per-connection state (updateHandler, pingInterval, controlledClientIds) stays in the plugin via a `WeakMap<object, ConnectionState>` keyed by `ws.raw`. This is transport-specific (WebSocket concerns). The room manager handles rooms, docs, awareness, and the connection map (`Map<object, { send }>`). Clean separation: room manager is transport-agnostic, plugin is Elysia/WebSocket-specific.

### Design Decision: Fixed Route + Elysia Prefix (replaces routePrefix)

The sync plugin always registers `/:room/sync` as a fixed route string. Consumers control the mount point via Elysia's native `prefix` option:

```typescript
// Standalone: /:room/sync
new Elysia().use(createSyncPlugin()).listen(3913);

// Integrated: /rooms/:room/sync
// NOTE: Prefix changed from /workspaces to /rooms in specs/20260220T195900-sync-route-prefix-restructure.md
new Elysia()
	.use(new Elysia({ prefix: '/rooms' }).use(createSyncPlugin({ getDoc })))
	.listen(3913);
```

This replaced the earlier `routePrefix` config + `Object.values(params)[0]` extraction, which was fragile (relied on JS object key ordering for the room ID). The fixed route gives Elysia full type inference on `ws.data.params.room`: no casts, no runtime fragility.

### Verification

- `bun run typecheck`: clean after every phase
- `bun test`: 56 tests pass, 103 expect() calls, 0 failures
- `grep @epicenter/workspace src/sync/`: zero imports (only the JSDoc comment about the firewall)
- `protocol.ts`: untouched
- `tables.ts`, `actions.ts`: untouched
- Backward compatibility: `createServer(client, { port })` signature unchanged, additive `auth` option

### Phase B: DX Improvements (Breaking Changes)

After Phase A, we applied 7 DX improvements that intentionally break backwards compatibility for better developer experience.

**Changes:**

1. **Dropped function overloads**: `createServer` has a single `export function` signature (no separate declaration + `export { createServer }` pattern).
2. **Added `stop()`**: Async method that stops the HTTP server and destroys all workspace clients. Replaces the old `destroy()` which only cleaned up clients without stopping the server.
3. **Removed signal handling**: `start()` no longer installs `SIGINT`/`SIGTERM` handlers or calls `process.exit()`. The caller owns lifecycle concerns.
4. **Removed startup logging**: `start()` no longer prints the wall-of-text banner. The CLI's `serve` command now owns startup logging (2 lines: server URL + API docs URL).
5. **Unified port constant**: Removed `DEFAULT_SYNC_PORT` from `sync/server.ts`. The sync server inlines `3913` as the default. Only `DEFAULT_PORT` exists (exported from the main entry).
6. **Consistent return type**: `createSyncServer` now returns `async stop()` matching `createServer`'s shape. Previously had sync `destroy()`.
7. **Moved discovery `GET /`**: The discovery endpoint (listing workspaces and actions) moved from `createWorkspacePlugin` to `createServer`. The workspace plugin is now purely tables + actions. `createServer` owns the root route.
8. **CLI owns startup UX**: The `serve` command in `cli.ts` now prints startup info and blocks with `await new Promise(() => {})`, letting the CLI's existing signal handlers manage shutdown.

**Files changed:**

| File                  | Changes                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `server.ts`           | Single export, slim `start()`, added `stop()`, removed `destroy()`, added `GET /` discovery |
| `sync/server.ts`      | Removed `DEFAULT_SYNC_PORT`, renamed `destroy()` → async `stop()`, removed startup log      |
| `workspace-plugin.ts` | Removed `GET /` discovery endpoint, removed `collectActionPaths` import                     |
| `cli.ts`              | Added startup logging, `await new Promise(() => {})` for blocking                           |

**Verification:**

- `bun run typecheck` (packages/server): clean
- `bun test` (packages/server): 56/56 pass
- `bun run typecheck` (packages/epicenter): no new errors (pre-existing `_v` type errors in test files only)
- LSP diagnostics: zero errors on all 4 changed files

## Cloud Portability

The plugin architecture is designed with two deployment targets in mind:

**Portable (used in both self-hosted and cloud):**

- Sync plugin protocol layer (rooms, auth, y-websocket encoding)
- Auth validation (`validateAuth`, `AuthConfig`)
- Room manager (`createRoomManager`)

**Self-hosted only:**

- `createServer()`: full convenience wrapper
- `createWorkspacePlugin()`: tables + actions REST endpoints
- `createTablesPlugin()`: per-workspace table CRUD
- `createActionsRouter()`: action query/mutation endpoints
- OpenAPI documentation

In cloud mode (Cloudflare Workers + Durable Objects), the sync protocol code runs inside a DO class. The DO handles WebSocket connections directly via Hibernatable WebSockets. The CF Worker handles HTTP routing and authentication. Table access happens via CRDTs (clients sync Y.Docs directly), and actions run on the user's own infrastructure.
