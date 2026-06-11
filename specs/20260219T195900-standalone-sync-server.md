# Standalone Sync Server

**Date**: 2026-02-19
**Status**: Superseded
**Superseded by**: `specs/20260220T080000-plugin-first-server-architecture.md`: duplicate of `20260219T195846-standalone-sync-server.md`, both superseded by plugin-first architecture.
**Author**: AI-assisted

## Overview

Extract `@epicenter/server`'s sync functionality into a standalone sync server that creates rooms on demand, validates optional token auth, and works independently without workspace configuration. This becomes the default mode for `epicenter serve`.

## Motivation

### Current State

The sync plugin requires a pre-initialized `Y.Doc` for every room:

```typescript
// packages/server/src/sync/index.ts
type SyncPluginConfig = {
	getDoc: (workspaceId: string) => Y.Doc | undefined;
};

// In open handler: rejects if doc doesn't exist:
const doc = config.getDoc(room);
if (!doc) {
	ws.close(CLOSE_ROOM_NOT_FOUND, `Room not found: ${room}`);
	return;
}
```

And the server bundles everything together monolithically:

```typescript
// packages/server/src/server.ts
const baseApp = new Elysia()
  .use(openapi({ ... }))
  .use(createSyncPlugin({ getDoc: (room) => workspaces[room]?.ydoc }))
  .use(createTablesPlugin(workspaces));
```

This creates problems:

1. **No on-demand rooms**: You cannot connect to an arbitrary room ID. Every room must have a pre-initialized workspace client, which defeats the purpose of a general sync relay. y-sweet and y-websocket both create docs on demand.
2. **No server-side auth**: The client sends `?token=xxx` as a query param (line 477-480 in `provider.ts`), but the server never reads or validates it. `MESSAGE_AUTH (2)` is declared in protocol constants but never implemented.
3. **No standalone mode**: You cannot run just sync. The server requires workspace clients with definitions, tables, and actions: even if all you want is a Yjs relay.

### Desired State

```bash
# Just works. No config needed. Any room ID accepted.
epicenter serve

# With auth
epicenter serve --token my-secret

# Clients connect to any room:
# ws://localhost:3913/sync/my-room
# ws://localhost:3913/sync/any-arbitrary-id
```

## Research Findings

### How Other Yjs Servers Handle This

| Server      | Doc Creation                                                                 | Auth                                                    | Room Lifecycle                                                  |
| ----------- | ---------------------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------- |
| y-websocket | `getYDoc(docname)`: creates on demand, stored in `Map<string, WSSharedDoc>` | None built-in                                           | Manual `destroy()` or process exit                              |
| y-sweet     | `get_or_create_doc`: creates on first connect, stores in `DocStore`         | Two-tier: server token (admin) + client token (per-doc) | `doc_gc_worker` checks ref count periodically, evicts idle docs |
| Our current | `getDoc()` callback: rejects if undefined                                   | None                                                    | 60s eviction timer after last client disconnects                |

**Key finding**: Both y-websocket and y-sweet create docs on demand. Our server is the outlier by requiring pre-existing docs.

**Implication**: We should adopt the `get_or_create` pattern. The simplest version is: if a room doesn't exist when a client connects, create a new `Y.Doc` and start syncing.

### Auth Patterns

| Pattern                      | Complexity                                      | Use Case                     |
| ---------------------------- | ----------------------------------------------- | ---------------------------- |
| No auth (Mode 1)             | None                                            | localhost, LAN, Tailscale    |
| Static token (Mode 2)        | Low: compare string on upgrade                 | Self-hosted, trusted network |
| Per-doc JWT (y-sweet Mode 3) | High: token issuance endpoint, signing, expiry | Multi-tenant SaaS            |

**Key finding**: The client already supports modes 1 and 2. The server just needs to read the `?token=` query parameter and compare it against a configured secret. This is trivial.

**Implication**: Implement modes 1 and 2 only. Mode 3 (dynamic JWT) is a future concern and requires a token issuance endpoint that doesn't exist yet.

## Design Decisions

| Decision                 | Choice                                                                                          | Rationale                                                                                                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New function vs refactor | New `createSyncServer()` alongside existing `createSyncPlugin()`                                | `createSyncPlugin` is tightly coupled to workspace clients. A new function avoids breaking existing server consumers. The plugin can later delegate to the same core. |
| URL structure            | `/sync/:roomId`                                                                                 | Clean, simple, no workspace coupling. Current `/workspaces/:id/sync` stays for backward compat in `createServer`.                                                     |
| Doc creation             | On-demand `new Y.Doc()` on first connect                                                        | Matches y-sweet and y-websocket. No config needed.                                                                                                                    |
| Persistence              | None (memory only) in v1                                                                        | Simplicity first. Docs live in memory, lost on restart. Persistence hook is a future concern.                                                                         |
| Auth validation location | Query param on WebSocket upgrade (`?token=xxx`)                                                 | Already what the client sends. Elysia's `beforeHandle` can validate before the WebSocket opens.                                                                       |
| Room eviction            | Keep existing 60s timer pattern                                                                 | Already works well. Last client leaves → 60s timer → room destroyed.                                                                                                  |
| Package location         | `packages/server/src/sync/server.ts`                                                            | New file in existing sync directory. Shares protocol utilities.                                                                                                       |
| CLI integration          | `epicenter serve` starts sync server by default, layers workspace server on top if config found | Sync always works. Workspace features are additive.                                                                                                                   |

## Architecture

```
epicenter serve
    │
    ├── (always) createSyncServer({ port, token? })
    │     └── /sync/:roomId  (WebSocket)
    │           ├── On connect: get-or-create Y.Doc for roomId
    │           ├── On upgrade: validate ?token= if token configured
    │           ├── On message: y-websocket protocol (sync, awareness, query, sync_status)
    │           └── On disconnect: 60s eviction timer
    │
    └── (if config found) createServer(clients, { port })
          ├── /workspaces/:id/sync  (delegates to same sync core)
          ├── /workspaces/:id/tables/:table  (REST)
          └── /workspaces/:id/actions/:action  (RPC)
```

### WebSocket Connection Flow

```
STEP 1: Client connects
─────────────────────────
ws://localhost:3913/sync/my-room?token=secret
                         ▲              ▲
                         │              │
                      roomId       auth token (optional)

STEP 2: Auth validation (if token configured)
──────────────────────────────────────────────
Server config has token? → Compare with ?token= query param
  Match    → proceed to step 3
  Mismatch → close(4401, "Unauthorized")
  Missing  → close(4401, "Unauthorized")

Server config has NO token? → proceed to step 3 (open mode)

STEP 3: Room resolution
────────────────────────
rooms.has(roomId)?
  Yes → get existing doc + awareness
  No  → create new Y.Doc(), new Awareness(doc), add to rooms map

STEP 4: Sync handshake
───────────────────────
Server sends SyncStep1 (state vector)
Server sends current awareness states
Client sends SyncStep2 + its SyncStep1
Normal sync loop begins
```

## Implementation Plan

### Phase 1: Standalone Sync Server

- [ ] **1.1** Create `packages/server/src/sync/server.ts` with `createSyncServer()` function
  - Accept config: `{ port?: number; token?: string }`
  - Elysia app with single WebSocket route: `/sync/:roomId`
  - On-demand doc creation (internal `Map<string, { doc: Y.Doc, awareness: Awareness }>`)
  - Token validation on WebSocket upgrade via query param
  - Reuse existing `protocol.ts` encoding/decoding functions
  - Reuse same room management patterns (connection tracking, awareness, ping/pong, eviction)
  - Return `{ app, start(), destroy() }`: same shape as `createServer`

- [ ] **1.2** Add close code constant `CLOSE_UNAUTHORIZED = 4401` to sync module

- [ ] **1.3** Export `createSyncServer` from `packages/server/src/index.ts`

### Phase 2: CLI Integration

- [ ] **2.1** Update `epicenter serve` CLI command to start `createSyncServer` by default
  - Add `--token` flag
  - If no workspace config found, run standalone sync only
  - If workspace config found, layer `createServer` on top (which includes sync at `/workspaces/:id/sync`)

### Phase 3: Refactor createSyncPlugin (Future)

- [ ] **3.1** Refactor `createSyncPlugin` to share the same core room management as `createSyncServer`
  - Extract shared `RoomManager` or similar abstraction
  - `createSyncPlugin` becomes a thin wrapper that maps `/workspaces/:id/sync` → room manager with workspace-provided docs
  - `createSyncServer` uses the same room manager with on-demand doc creation

## Edge Cases

### Client connects with wrong token

1. Client sends `ws://host:3913/sync/room?token=wrong`
2. Server compares against configured token
3. Server closes with `4401 Unauthorized` before any sync messages are exchanged
4. Client's supervisor loop handles this as a connection failure with backoff

### Two clients connect to same room simultaneously

1. First client triggers `new Y.Doc()` + room creation
2. Second client finds existing room, joins it
3. Both receive each other's awareness, sync normally
4. Standard y-websocket behavior: no special handling needed

### Server restarts with active rooms

1. All in-memory Y.Docs are lost (no persistence in v1)
2. Clients reconnect via supervisor loop
3. New empty Y.Docs are created on demand
4. Clients send their local state via sync step 2, server catches up
5. Data loss only occurs if ALL clients have restarted too (nobody has the data anymore)

### Token configured but client sends no token

1. Server sees empty/missing `?token=` on upgrade
2. Server closes with `4401 Unauthorized`
3. This is intentional: if you configure a token, all clients must provide it

### Room eviction races

1. Last client disconnects, 60s timer starts
2. At 59s, new client connects
3. Timer is cancelled (existing pattern), room stays alive
4. Already handled by current `evictionTimers` logic: no change needed

## Open Questions

1. **Should `createSyncServer` also serve a basic HTTP health endpoint?**
   - Options: (a) Yes, `GET /` returns `{ status: "ok", rooms: N }`, (b) No, WebSocket only
   - **Recommendation**: (a): trivial to add, useful for monitoring, and matches the existing `createServer` pattern of having a `GET /` discovery endpoint.

2. **Should the `/sync/:roomId` route live at root or under a prefix?**
   - Options: (a) `/sync/:roomId`, (b) `/:roomId`, (c) `/rooms/:roomId`
   - **Recommendation**: (a): explicit namespace avoids collisions when workspace features are layered on top. `/sync/` prefix makes it clear what this endpoint does.

3. **Should we add a `maxRooms` limit to prevent unbounded memory growth?**
   - Options: (a) Yes, configurable limit with a reasonable default (e.g., 1000), (b) No, trust the operator
   - **Recommendation**: Defer. The eviction timer already handles idle rooms. A hard limit is an optimization for later.

4. **What happens when `createServer` (workspace mode) and `createSyncServer` are both present?**
   - The workspace server already handles `/workspaces/:id/sync` via `createSyncPlugin`.
   - The standalone sync server handles `/sync/:roomId`.
   - These are separate routes on the same Elysia app. No conflict.
   - **Recommendation**: In the CLI, mount both on the same Elysia instance. The standalone route is always available; workspace routes are added when config is found.

## Success Criteria

- [ ] `createSyncServer({ port: 3913 })` starts a working sync server with zero config
- [ ] Any client can connect to `ws://localhost:3913/sync/any-room-id` and sync a Y.Doc
- [ ] Two clients connecting to the same room ID sync with each other in real-time
- [ ] `createSyncServer({ token: "secret" })` rejects connections without the correct token
- [ ] `createSyncServer({ token: "secret" })` accepts connections with the correct token
- [ ] Rooms are created on demand and evicted 60s after the last client disconnects
- [ ] Existing `createServer` (workspace mode) continues to work unchanged
- [ ] `epicenter serve` starts the standalone sync server by default
- [ ] All existing sync protocol tests continue to pass

## References

- `packages/server/src/sync/index.ts`: Current sync plugin (room management, awareness, ping/pong, eviction patterns to reuse)
- `packages/server/src/sync/protocol.ts`: Protocol encoding/decoding (shared by both sync server and sync plugin)
- `packages/server/src/server.ts`: Current monolithic server (will need to mount sync server alongside)
- `packages/sync/src/types.ts`: Client auth modes (server must match modes 1 and 2)
- `packages/sync/src/provider.ts`: Client provider (sends `?token=` as query param)
- `packages/epicenter/src/cli/cli.ts`: CLI `serve` command (needs --token flag and standalone sync mode)
