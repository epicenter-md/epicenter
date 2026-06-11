# Standalone Sync Server

**Date**: 2026-02-19
**Status**: Superseded
**Superseded by**: `specs/20260220T080000-plugin-first-server-architecture.md`: `createSyncServer()` is included as a convenience wrapper over `createSyncPlugin()`, which is more composable and covers all the same capabilities.
**Author**: AI-assisted
**Related**: `20260219T195800-server-architecture-rethink.md` (Layer 0+1), `20260214T120800-migrate-y-sweet-to-epicenter-sync.md` (protocol)

## Overview

Extract the sync relay from `@epicenter/server` into a standalone `createSyncServer()` that just synchronizes Y.Docs over WebSockets. No REST, no tables, no actions, no workspace clients. Three auth modes matching `@epicenter/sync`'s client. Hit any URL, get a room.

## Motivation

### Current State

The sync plugin lives inside a full-featured HTTP server that requires workspace clients:

```typescript
// packages/server/src/server.ts: requires initialized workspace clients
const server = createServer(blogClient, { port: 3913 });
server.start();
// Provides: REST tables, actions, OpenAPI docs, AND sync
```

The sync plugin itself has no auth:

```typescript
// packages/server/src/sync/index.ts: no auth check
return new Elysia().ws('/workspaces/:workspaceId/sync', {
	open(ws) {
		const room = ws.data.params.workspaceId;
		const doc = config.getDoc(room); // ← must come from workspace client
		// ← No auth. Anyone who hits this URL gets in.
	},
});
```

The client supports three auth modes (`@epicenter/sync`), but the server enforces none:

```typescript
// Client can send tokens...
const provider = createSyncProvider({
	doc,
	url,
	token: 'my-secret', // ← Sent as ?token=my-secret
});

// ...but the server never checks them.
```

This creates three problems:

1. **Can't use sync without workspace clients.** If you just want to sync Y.Docs between devices, you still need to define table schemas, create workspace clients, and wire up extensions. The sync relay is locked inside a larger system.

2. **No auth on the server.** The client sends tokens, the server ignores them. Anyone with the URL can connect to any room. This is fine for localhost but dangerous for anything exposed to a network.

3. **Can't manage its own docs.** The sync plugin receives Y.Docs via `getDoc()`: it can't create them. If you connect to a room that doesn't have a pre-created doc, you get a 4004 close code. Rooms should be created lazily on first connection (like y-sweet does).

### Desired State

A standalone sync server you can start with one line:

```typescript
import { createSyncServer } from '@epicenter/server/sync';

// Mode 1: Open: no auth, anyone can connect, rooms created on demand
const server = createSyncServer({ port: 3913 });
server.start();

// Mode 2: Shared token: server has a secret, clients must include it
const server = createSyncServer({
	port: 3913,
	auth: { token: 'my-shared-secret' },
});
server.start();
```

Clients connect with `@epicenter/sync`:

```typescript
const provider = createSyncProvider({
	doc: myDoc,
	url: 'ws://localhost:3913/rooms/my-room',
	token: 'my-shared-secret', // Mode 2
});
```

## Research Findings

### How y-sweet and y-websocket Handle Server-Side Sync

| Aspect         | y-sweet                                                   | y-websocket                            | Current @epicenter/server                         |
| -------------- | --------------------------------------------------------- | -------------------------------------- | ------------------------------------------------- |
| Room creation  | Lazy on first connection                                  | Lazy on first connection               | Requires pre-existing Y.Doc from workspace client |
| Y.Doc per room | Server creates and manages                                | Server creates and manages             | External: passed via `getDoc()`                  |
| Auth           | Server token + per-doc client tokens with R/W permissions | None (URL only)                        | None                                              |
| Auth timing    | Before WebSocket upgrade                                  | N/A                                    | N/A                                               |
| Persistence    | Server-side (S3/filesystem)                               | Optional leveldb callback              | Client-side (IndexedDB/filesystem)                |
| Room eviction  | GC worker after idle period                               | Room destroyed when last client leaves | 60s timer after last client leaves                |
| Ping/pong      | Yes                                                       | Yes (30s)                              | Yes (30s)                                         |

**Key finding**: Both y-sweet and y-websocket create and manage their own Y.Docs per room. Our server is the oddball: it borrows docs from workspace clients. For a standalone sync server, the server must own its docs.

**Key finding from y-sweet**: Auth is verified BEFORE the WebSocket upgrade, not after. This prevents unauthenticated connections from consuming server resources. Elysia supports `beforeHandle` on WebSocket routes for this.

### Auth Mode Mapping (Client ↔ Server)

The three auth modes from `@epicenter/sync`'s README need corresponding server behavior:

| Mode                   | Client Config                         | Server Config                                | How It Works                                                                                        |
| ---------------------- | ------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **1: Open**            | Just `url`                            | No `auth` option                             | Server accepts all connections. No token checked.                                                   |
| **2: Shared Token**    | `url` + `token: 'secret'`             | `auth: { token: 'secret' }`                  | Client sends `?token=secret` in URL. Server compares against its configured token.                  |
| **3: Verify Function** | `url` + `getToken: async () => '...'` | `auth: { verify: async (token) => boolean }` | Client sends token in URL. Server calls `verify(token)`. Async: can hit a DB, validate a JWT, etc. |

**Implication**: Mode 1 and 2 are simple string comparison (or skip). Mode 3 is the escape hatch for any auth system: JWT validation, session checks, OAuth introspection. The server doesn't need to know HOW auth works, just whether the token is valid.

### Protocol: Already Solid

The existing protocol code in `packages/server/src/sync/protocol.ts` is clean and complete:

- MESSAGE_SYNC (0): Document sync (step 1, step 2, updates)
- MESSAGE_AWARENESS (1): User presence
- MESSAGE_QUERY_AWARENESS (3): Request awareness states
- MESSAGE_SYNC_STATUS (102): Heartbeat + hasLocalChanges echo

The sync plugin in `packages/server/src/sync/index.ts` correctly handles all four message types, has ping/pong keepalive, room eviction with 60s timer, awareness tracking, and WeakMap-based connection state. This code works. It just needs auth and standalone room management.

## Design Decisions

| Decision                         | Choice                                                                   | Rationale                                                                                                                                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Separate export, not replace     | `@epicenter/server/sync` export alongside existing `@epicenter/server`   | The full server (`createServer`) still needs to exist for workspace clients with REST/actions. The sync server is a subset.                                                                                   |
| Server owns its Y.Docs           | Rooms create fresh `Y.Doc` on first connection                           | Matches y-sweet/y-websocket. No external doc dependency.                                                                                                                                                      |
| Auth before upgrade              | Validate token in `beforeHandle`, not in `open`                          | Reject bad connections before they consume WebSocket resources. y-sweet pattern.                                                                                                                              |
| No server-side persistence (yet) | Rooms hold Y.Docs in memory only                                         | Client-side persistence is the source of truth. When all clients disconnect and the room evicts, the doc is gone. Next connection starts fresh and syncs from client. This matches the existing architecture. |
| Keep existing URL pattern        | `/rooms/:roomId` as primary, `/workspaces/:workspaceId/sync` as alias    | `rooms` is the correct abstraction for a generic sync server. Keep workspace URL for backward compat.                                                                                                         |
| Room allow-list optional         | Open mode: any room ID. Token mode: optionally restrict to known rooms.  | In open mode (localhost/LAN), ad-hoc rooms are fine. In token mode, you might want to restrict which rooms exist.                                                                                             |
| `getDoc` hook for full server    | `createSyncServer` uses internal docs; `createSyncPlugin` keeps `getDoc` | The full server still needs `getDoc` to connect sync to workspace clients. The standalone server doesn't.                                                                                                     |

## Architecture

### Standalone Sync Server

```
createSyncServer({ port, auth? })
  │
  ├── Layer 0: HTTP + WebSocket listener
  │     └── Health endpoint: GET / → { rooms: [...], connections: N }
  │
  ├── Auth Gate (optional)
  │     ├── Mode 1 (no auth config): pass through
  │     ├── Mode 2 (token string): compare ?token param
  │     └── Mode 3 (verify fn): await verify(token)
  │
  └── Room Manager
        ├── Map<string, Room>
        │     └── Room = { doc: Y.Doc, awareness: Awareness, conns: Set, evictionTimer? }
        ├── On connect: get-or-create room, join
        ├── On message: y-websocket protocol (0, 1, 3, 102)
        ├── On disconnect: leave room, start eviction timer if empty
        └── Eviction: 60s after last client → destroy room
```

### Connection Flow

```
Client                          Server
  │                                │
  ├─ WS connect ──────────────────►│
  │  ws://host:3913/rooms/my-room  │
  │  ?token=secret                 │
  │                                │
  │                         ┌──────┤ Auth Gate
  │                         │ Mode 1: skip
  │                         │ Mode 2: token === config.token?
  │                         │ Mode 3: await config.verify(token)?
  │                         └──────┤
  │                                │
  │                         ┌──────┤ Room Manager
  │                         │ room = rooms.get('my-room')
  │                         │   ?? createRoom('my-room')
  │                         └──────┤
  │                                │
  │◄─ SYNC step 1 ────────────────┤  Server sends its state vector
  ├─ SYNC step 2 ─────────────────►│  Client responds with diff
  │                                │
  ├─ SYNC_STATUS (102) ───────────►│  Heartbeat + version
  │◄─ SYNC_STATUS (102) ──────────┤  Echo
  │                                │
  │   (bidirectional sync continues)
```

### Relationship to Full Server

```
@epicenter/server
  ├── createServer(clients, options)     ← Full server (REST + sync + actions)
  │     └── Uses createSyncPlugin()      ← Sync with external getDoc()
  │
  └── createSyncServer(options)          ← NEW: Standalone sync
        └── Uses room manager directly   ← Sync with internal docs
```

`createServer` continues to work as-is for workspace clients. `createSyncServer` is a new, simpler entry point for pure sync.

## API Design

### `createSyncServer(options)`

```typescript
type SyncServerAuth =
	| { token: string } // Mode 2: shared secret
	| { verify: (token: string) => Promise<boolean> | boolean }; // Mode 3: custom verify

type SyncServerOptions = {
	/** Port to listen on. Default: 3913. */
	port?: number;

	/** Auth configuration. Omit for open mode (Mode 1). */
	auth?: SyncServerAuth;

	/**
	 * Time (ms) to wait after last client disconnects before destroying a room.
	 * Default: 60_000 (60 seconds).
	 */
	roomEvictionTimeout?: number;

	/**
	 * Called when a new room is created. Use for logging or injecting initial doc state.
	 * The doc is empty when this fires: client sync hasn't happened yet.
	 */
	onRoomCreated?: (roomId: string, doc: Y.Doc) => void;

	/**
	 * Called when a room is evicted (no clients for `roomEvictionTimeout` ms).
	 * Use for logging, persistence, or cleanup.
	 */
	onRoomEvicted?: (roomId: string, doc: Y.Doc) => void;
};

type SyncServer = {
	/** Start listening. Returns the underlying Bun server. */
	start(): ReturnType<typeof Bun.serve>;

	/** Stop the server and destroy all rooms. */
	destroy(): Promise<void>;

	/** Get list of active room IDs. */
	rooms(): string[];

	/** Get connection count for a room (0 if room doesn't exist). */
	connections(roomId: string): number;
};

function createSyncServer(options?: SyncServerOptions): SyncServer;
```

### URL Pattern

```
ws://host:3913/rooms/{roomId}
```

Room IDs are arbitrary strings from the URL path. The server doesn't validate or restrict them (in open mode). In auth mode, the server validates the token but still allows any room ID by default.

### Auth Token Transport

The client sends the token as a URL query parameter:

```
ws://host:3913/rooms/my-room?token=my-shared-secret
```

This matches `@epicenter/sync`'s existing behavior (provider.ts line 478-482):

```typescript
if (token) {
	const parsed = new URL(url);
	parsed.searchParams.set('token', token);
	wsUrl = parsed.toString();
}
```

## Implementation Plan

### Phase 1: Extract Room Manager

Extract the room lifecycle from `packages/server/src/sync/index.ts` into a reusable module.

- [ ] **1.1** Create `packages/server/src/sync/rooms.ts`: room creation, join, leave, eviction timer
- [ ] **1.2** Move room-related state (rooms Map, awarenessMap, evictionTimers) from the plugin closure into a `createRoomManager()` factory
- [ ] **1.3** Add `createRoom(roomId)` that creates a fresh Y.Doc + Awareness (no external `getDoc`)
- [ ] **1.4** Add `getOrCreateRoom(roomId)` that lazily creates rooms on first access
- [ ] **1.5** Room manager returns: `{ getOrCreate, destroy, rooms, connections }`
- [ ] **1.6** Refactor existing `createSyncPlugin` to use the room manager internally (keep `getDoc` for backward compat: `getDoc` takes priority over lazy creation)

### Phase 2: Add Auth Gate

Add authentication to the WebSocket upgrade path.

- [ ] **2.1** Create `packages/server/src/sync/auth.ts`: auth verification logic
- [ ] **2.2** Implement token extraction from URL query params
- [ ] **2.3** Implement Mode 1 (no auth): always pass
- [ ] **2.4** Implement Mode 2 (shared token): constant-time string comparison
- [ ] **2.5** Implement Mode 3 (verify function): `await config.verify(token)`
- [ ] **2.6** Return 401/403 WebSocket close codes for failed auth
- [ ] **2.7** Add tests for each auth mode

### Phase 3: Create Standalone Sync Server

Wire room manager + auth into a standalone server.

- [ ] **3.1** Create `packages/server/src/sync/server.ts`: `createSyncServer()` factory
- [ ] **3.2** Set up Elysia app with WebSocket route at `/rooms/:roomId`
- [ ] **3.3** Wire auth gate as `beforeHandle` (Elysia middleware)
- [ ] **3.4** Wire room manager for connection lifecycle
- [ ] **3.5** Add health/discovery endpoint: `GET /` → `{ rooms, connections }`
- [ ] **3.6** Add `start()`, `destroy()`, `rooms()`, `connections()` methods
- [ ] **3.7** Export from `packages/server/src/sync/index.ts`

### Phase 4: Integration Tests

Test client + server working together using `@epicenter/sync`.

- [ ] **4.1** Test: two clients sync through the server (doc changes propagate)
- [ ] **4.2** Test: auth Mode 1: open access, no token needed
- [ ] **4.3** Test: auth Mode 2: valid token connects, invalid token rejected
- [ ] **4.4** Test: auth Mode 3: verify function called, result respected
- [ ] **4.5** Test: room created on first connection, evicted after timeout
- [ ] **4.6** Test: hasLocalChanges works end-to-end (102 echo)
- [ ] **4.7** Test: reconnection after server restart

### Phase 5: Backward Compatibility

Ensure the full server still works.

- [ ] **5.1** Verify `createServer(workspaceClients)` still works unchanged
- [ ] **5.2** Verify existing sync plugin tests pass
- [ ] **5.3** Verify full server typecheck passes

## Edge Cases

### Room ID Validation

Room IDs come from URL paths. Potential issues:

1. Empty room ID: reject with 400
2. Very long room IDs: cap at 256 chars
3. Special characters: URL-encoded by the client, decoded by Elysia
4. Room IDs with `/`: Elysia's `:roomId` param captures until next `/`, so `/rooms/a/b` would not match. This is fine: room IDs are single path segments.

### Auth Token in URL vs Headers

Tokens in URLs are visible in server logs, browser history, and potentially proxies. The `Sec-WebSocket-Protocol` header is an alternative, but:

- It's non-standard for auth (it's for protocol negotiation)
- Some proxies strip it
- The current client already uses query params

**Decision**: Keep `?token=` for now. Document the security tradeoff. For sensitive deployments, use HTTPS (wss://) which encrypts the URL.

### Room Eviction While Client is Reconnecting

1. Client disconnects (network issue)
2. 60s eviction timer starts
3. At 59s, client reconnects
4. Timer must be cancelled: the room stays alive

This is already handled in the current sync plugin (eviction timer cancellation on new connection). The room manager extraction must preserve this.

### Server Restart: No Persistence

If the server restarts, all rooms are destroyed. When clients reconnect, they start fresh rooms. The client's local persistence (IndexedDB/filesystem) is the source of truth. It syncs its full state to the new empty server doc. This is the existing behavior and is correct for the client-side persistence model.

### Concurrent Room Creation

Two clients connect to the same room ID simultaneously. `getOrCreateRoom` must be idempotent. If the room already exists, return it. Since JavaScript is single-threaded, there's no true concurrency issue, but the `Map.get() ?? create()` pattern must be atomic (set before returning).

### Verify Function Throws

If `auth.verify(token)` throws an error, treat it as auth failure (reject the connection). Don't leak the error message to the client: log it server-side.

## Open Questions

1. **Should the standalone server also expose `/workspaces/:workspaceId/sync` for backward compat?**
   - The full server uses this pattern. Clients connecting to the standalone server would need to use `/rooms/:roomId` instead.
   - **Recommendation**: Yes, add as an alias. A one-liner in Elysia. Avoids breaking existing client URLs.

2. **Should the room manager support an `allowRoom` predicate?**
   - In token auth mode, you might want to restrict which rooms can be created.
   - Options: (a) No restriction: any room ID, (b) `allowRoom: (roomId: string, token: string) => boolean`
   - **Recommendation**: Defer. The `verify` function in Mode 3 already receives the token: if you need per-room auth, your verify function can parse a JWT containing room claims. Adding `allowRoom` now is premature.

3. **Should we add `onRoomCreated`/`onRoomEvicted` hooks or a plugin system?**
   - Hooks are simple. A plugin system is flexible but complex.
   - **Recommendation**: Start with hooks (shown in the API). They're enough for logging and basic persistence. A plugin system can come later if hooks prove limiting.

4. **Should `createSyncServer` live in `@epicenter/server` or a new `@epicenter/sync-server` package?**
   - It shares protocol code with the existing server.
   - **Recommendation**: Keep in `@epicenter/server` as a secondary export (`@epicenter/server/sync`). It reuses `protocol.ts` and the room manager. Separate package means duplicating code or adding a shared dependency.

## Success Criteria

- [ ] `createSyncServer()` starts a working sync server with zero config
- [ ] Two `@epicenter/sync` clients can sync a Y.Doc through the server
- [ ] Mode 1 (open): no token, connection succeeds
- [ ] Mode 2 (shared token): correct token connects, wrong token rejected
- [ ] Mode 3 (verify): custom function controls access
- [ ] Rooms created lazily on first connection
- [ ] Rooms evicted 60s after last client disconnects
- [ ] `hasLocalChanges` works end-to-end (102 echo)
- [ ] Existing `createServer()` still works unchanged
- [ ] All existing tests pass

## References

- `packages/server/src/sync/index.ts`: Current sync plugin (extract room manager + add auth)
- `packages/server/src/sync/protocol.ts`: Protocol encode/decode (unchanged, already complete)
- `packages/sync/src/provider.ts`: Client provider (already supports 3 auth modes)
- `packages/sync/src/types.ts`: Client types (`SyncProviderConfig`, auth options)
- `specs/20260219T195800-server-architecture-rethink.md`: Layer 0+1 is exactly this server
- `specs/20260214T120800-migrate-y-sweet-to-epicenter-sync.md`: Protocol migration (complete)
- `specs/20260213T120800-extract-epicenter-server-package.md`: Phase 2 designs auth modes
