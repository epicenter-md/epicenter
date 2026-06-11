# Pure Sync Server

**Date**: 2026-02-20
**Status**: Superseded
**Superseded by**: `specs/20260220T080000-plugin-first-server-architecture.md`: all capabilities (on-demand rooms, 3 auth modes, zero @epicenter/workspace dependency) are included via `createSyncPlugin()` + `createSyncServer()` wrapper.
**Author**: Braden + Claude
**Relates to**: `specs/20260219T195800-server-architecture-rethink.md` (Layers 0+1)

## Overview

Extract the sync relay from `@epicenter/server` into a standalone `createSyncServer()` that creates Y.Doc rooms on-demand, supports the three auth modes from `@epicenter/sync`, and requires zero workspace configuration. This is the "no config, just sync" base from the broader server rethink.

## Motivation

### Current State

The sync plugin lives inside `createServer()` which requires a fully initialized `AnyWorkspaceClient`:

```typescript
// packages/server/src/server.ts: sync is buried inside the full server
createSyncPlugin({
	getDoc: (room) => workspaces[room]?.ydoc, // only returns docs for known workspaces
});
```

```typescript
// packages/server/src/sync/index.ts: no auth, no dynamic rooms
const doc = config.getDoc(room);
if (!doc) {
	ws.close(CLOSE_ROOM_NOT_FOUND, `Room not found: ${room}`);
	return;
}
```

This creates three problems:

1. **No dynamic rooms.** Connecting to `/workspaces/my-notes/sync` returns 4004 unless `my-notes` is a pre-registered workspace client. y-websocket and y-sweet both create docs on first connection. A sync relay between two devices shouldn't require schema definitions.

2. **Zero server-side auth.** The client (`@epicenter/sync`) sends `?token=xxx` in the WebSocket URL. The server never reads it. Any connection is accepted. The three auth modes exist only client-side.

3. **Tight coupling to `@epicenter/workspace`.** You can't run a sync server without importing the entire workspace system. The server's `package.json` has `@epicenter/workspace` as a peer dependency.

### Desired State

```typescript
import { createSyncServer } from '@epicenter/server';

// Mode 1: Open (localhost, tailscale, LAN)
const server = createSyncServer({ port: 3913 });

// Mode 2: Shared token
const server = createSyncServer({
	port: 3913,
	auth: { token: 'my-shared-secret' },
});

// Mode 3: Token verification (for JWTs, external auth)
const server = createSyncServer({
	port: 3913,
	auth: {
		verifyToken: async (token) => {
			// validate JWT, check database, etc.
			return true; // or false to reject
		},
	},
});

server.start();
// Any client connects to ws://localhost:3913/{roomName}
// Room created on first connection, evicted after idle timeout
```

## Research Findings

### How y-websocket and y-sweet handle this

| Aspect          | y-websocket                                     | y-sweet                                          | Current epicenter server                 |
| --------------- | ----------------------------------------------- | ------------------------------------------------ | ---------------------------------------- |
| Room creation   | On-demand (first connection creates Y.Doc)      | On-demand via `get_or_create_doc`                | Pre-registered only (4004 if unknown)    |
| Auth            | None built-in                                   | Two-tier: server token + client token (JWT-like) | None                                     |
| Room routing    | URL path = room name                            | `/d/:id/ws/:id` path-based                       | `/workspaces/:id/sync` (matches y-sweet) |
| Doc persistence | Optional callback (`persistence.bindState`)     | `SyncKv` with filesystem/S3 backends             | Delegates to workspace client extensions |
| Room eviction   | No built-in eviction                            | `doc_gc_worker` evicts after inactivity          | 60s timer after last disconnect (good)   |
| Protocol        | sync (0) + awareness (1) + auth (2) + query (3) | Same + custom extensions                         | Same + SYNC_STATUS (102) heartbeat echo  |

**Key finding**: Both y-websocket and y-sweet create docs on-demand. Auth is orthogonal to sync. The sync server shouldn't care about workspace schemas: it's a room that relays Y.Doc updates.

**Implication**: The existing `createSyncPlugin` is 90% correct. It just needs: (1) auto-create docs instead of rejecting unknown rooms, and (2) auth checking before WebSocket upgrade.

### Protocol compatibility

The client (`@epicenter/sync`) speaks standard y-websocket protocol + MESSAGE_SYNC_STATUS (102). The server already handles all four message types correctly. No protocol changes needed.

The 102 extension is backward-compatible: standard y-websocket clients ignore unknown message types, and the server gracefully handles clients that don't send 102.

## Design Decisions

| Decision                      | Choice                                                             | Rationale                                                                      |
| ----------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Dynamic room creation         | Create Y.Doc on first connection                                   | Matches y-websocket/y-sweet behavior; enables zero-config sync                 |
| Auth at WebSocket upgrade     | Check `?token=` before upgrade completes                           | Reject before binary protocol starts; clear error reporting via HTTP status    |
| Three auth modes              | Open, shared token, verify function                                | Mirrors the three modes in `@epicenter/sync` client                            |
| Route pattern                 | `/:room` (configurable prefix)                                     | Simplest possible. Prefix like `/workspaces/:id/sync` optional via config      |
| Room eviction                 | 60s after last disconnect (existing)                               | Already implemented and tested. Keep as-is.                                    |
| Doc persistence               | Out of scope (in-memory only)                                      | Persistence is a Layer 4 concern (see broader spec). Sync relay = ephemeral.   |
| Separate from full server     | `createSyncServer` alongside `createServer`                        | Full server composes sync + tables + actions. Sync server is the minimal core. |
| No `@epicenter/workspace` dependency | Sync server depends only on `yjs`, `lib0`, `y-protocols`, `elysia` | Removes coupling. Full server still depends on hq for tables/actions.          |

## Architecture

```
createSyncServer({ port, auth? })
│
├── Auth middleware (applied before WebSocket upgrade)
│   ├── Mode 1 (open): No check, accept all
│   ├── Mode 2 (token): Compare ?token= to configured secret
│   └── Mode 3 (verify): Call verifyToken(?token=) async, accept/reject
│
├── Room Manager
│   ├── rooms: Map<string, { doc: Y.Doc, conns: Set, awareness: Awareness }>
│   ├── getOrCreate(roomName): Returns existing or creates new Y.Doc
│   └── eviction: 60s timer after last connection leaves
│
└── WebSocket handler (existing protocol, unchanged)
    ├── MESSAGE_SYNC (0): Document sync (step 1, step 2, update)
    ├── MESSAGE_AWARENESS (1): User presence
    ├── MESSAGE_QUERY_AWARENESS (3): Request awareness states
    └── MESSAGE_SYNC_STATUS (102): Heartbeat echo (unchanged)
```

### Relationship to full server

```
createSyncServer()           createServer()
  │ standalone                  │ composes everything
  ├── auth                      ├── createSyncServer() internally
  ├── room manager              ├── tables plugin
  └── ws handler                ├── actions plugin
                                ├── openapi
                                └── discovery endpoint
```

`createServer` would internally use `createSyncServer` (or its room manager) rather than duplicating sync logic. This is a future refactor: for now, `createSyncServer` is a new export alongside the existing `createServer`.

## Implementation Plan

### Phase 1: Auth + dynamic rooms in existing sync plugin

The minimal change to make sync actually work. Modify `packages/server/src/sync/index.ts`.

- [ ] **1.1** Change `SyncPluginConfig` to support get-or-create: replace `getDoc: (id) => Y.Doc | undefined` with `getOrCreateDoc: (id) => Y.Doc` that auto-creates on miss
- [ ] **1.2** Add auth config to `SyncPluginConfig`: `auth?: { token: string } | { verifyToken: (token: string) => Promise<boolean> | boolean }`
- [ ] **1.3** Add auth checking in the WebSocket `open` handler: extract `?token=` from URL, validate against config, close with 4001 on failure
- [ ] **1.4** Add default `getOrCreateDoc` that maintains an internal `Map<string, Y.Doc>` (for standalone mode)
- [ ] **1.5** Update existing tests, add auth + dynamic room tests

### Phase 2: `createSyncServer` standalone export

New function that composes the sync plugin into a standalone server.

- [ ] **2.1** Create `packages/server/src/sync-server.ts` with `createSyncServer(config)` function
- [ ] **2.2** Config type: `{ port?: number, auth?: ... , routePrefix?: string }`
- [ ] **2.3** Minimal Elysia app: health check at `/` + sync plugin
- [ ] **2.4** Export from `packages/server/src/index.ts`
- [ ] **2.5** Integration test: two `@epicenter/sync` clients sync through `createSyncServer`

### Phase 3: Decouple from `@epicenter/workspace` (optional, future)

- [ ] **3.1** Move sync-only code to a subpath export (`@epicenter/server/sync`) that doesn't import `@epicenter/workspace`
- [ ] **3.2** Keep `@epicenter/server` (full) depending on hq for tables/actions
- [ ] **3.3** Or: extract sync server to its own package (`@epicenter/sync-server`)

## Edge Cases

### Client connects with token in open mode

1. Server configured with no auth (Mode 1)
2. Client sends `?token=xxx` anyway
3. Server ignores the token: connection accepted. No error. The token is harmless.

### Client connects without token in token mode

1. Server configured with `{ token: 'secret' }`
2. Client connects without `?token=`
3. Server closes with 4001 (Unauthorized) before WebSocket messages begin
4. Client's supervisor loop sees the close, backs off, retries

### Two clients connect to same room, one creates doc

1. Client A connects to `/my-notes`: room doesn't exist, Y.Doc created
2. Client A sends sync step 1, server responds with sync step 2 (empty doc)
3. Client A sends updates: server's Y.Doc now has data
4. Client B connects to `/my-notes`: room exists, joins
5. Client B receives sync step 2 with Client A's data
6. Both clients are now synced

### Server restarts, rooms are lost

1. Server restarts: all in-memory Y.Docs are gone
2. Clients reconnect, each sends sync step 1 with their state vector
3. Server creates fresh Y.Doc, responds with empty sync step 2
4. Clients send their full state as updates
5. Server's Y.Doc is rebuilt from client state

This is correct CRDT behavior. The clients are the source of truth. Persistence (keeping docs across restarts) is a Layer 4 concern.

### Rapid connect/disconnect during eviction window

1. Last client disconnects: 60s eviction timer starts
2. At 59s, new client connects: timer cancelled, room stays alive
3. New client disconnects immediately: new 60s timer starts
4. No client connects within 60s: room evicted, Y.Doc garbage collected

Already handled correctly by existing code.

## Open Questions

1. **Should the route be `/:room` or `/workspaces/:room/sync`?**
   - Options: (a) `/:room` for simplicity, (b) `/workspaces/:room/sync` for backward compatibility, (c) Configurable via `routePrefix`
   - **Recommendation**: (c) Configurable, defaulting to `/:room` for the standalone sync server. The full `createServer` would override with `/workspaces/:id/sync` for backward compatibility.

2. **Should auth rejection happen at HTTP upgrade or after WebSocket open?**
   - Options: (a) HTTP 401 before upgrade (cleaner), (b) WebSocket close code 4001 after open (easier with Elysia)
   - **Recommendation**: (b) Close with 4001. Elysia's `.ws()` handler runs after upgrade. Rejecting before upgrade requires middleware on the HTTP route, which is more complex with Elysia's WebSocket handling. The client's supervisor loop handles close codes gracefully. Research whether Elysia supports `beforeHandle` on `.ws()` routes.

3. **Should on-demand rooms have a maximum count?**
   - Options: (a) Unlimited, (b) Configurable max, (c) Memory-based limit
   - **Recommendation**: (a) Unlimited for now. Eviction keeps memory bounded. Add limits later if DoS becomes a concern.

4. **Should the sync server expose the doc store for persistence hooks?**
   - Example: `server.onRoomCreated((room, doc) => loadFromDisk(doc))`
   - **Recommendation**: Defer. This is the bridge to Layer 4. For now, in-memory only. Add persistence hooks when the full layered architecture is implemented.

## Success Criteria

- [ ] Two `@epicenter/sync` clients can sync a Y.Doc through `createSyncServer()` with no workspace config
- [ ] Auth Mode 1 (open): Any client connects without token
- [ ] Auth Mode 2 (token): Client with correct `?token=` connects; wrong/missing token is rejected
- [ ] Auth Mode 3 (verify): Custom `verifyToken` function is called and respected
- [ ] MESSAGE_SYNC_STATUS (102) heartbeat echo still works
- [ ] Room eviction still works (60s after last disconnect)
- [ ] Existing `createServer` still works (backward compatible)
- [ ] No `@epicenter/workspace` import in the sync-only code path

## References

- `packages/server/src/sync/index.ts`: Current sync plugin (room management, WebSocket handler)
- `packages/server/src/sync/protocol.ts`: Protocol encoding/decoding (unchanged)
- `packages/server/src/server.ts`: Current `createServer()` that wraps everything
- `packages/sync/src/provider.ts`: Client-side sync provider (3 auth modes)
- `packages/sync/src/types.ts`: `SyncProviderConfig` with token/getToken
- `specs/20260219T195800-server-architecture-rethink.md`: Broader layered architecture vision
