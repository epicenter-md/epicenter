# Sync Server Redesign

**Date**: 2026-02-19
**Status**: Superseded
**Superseded by**: `specs/20260220T080000-plugin-first-server-architecture.md`: ws identity bug fix (room manager with `ws.raw` keying) and auth (all 3 modes) are covered in the plugin-first architecture.
**Author**: AI-assisted

## Overview

Strip `@epicenter/server`'s sync plugin down to a standalone sync room server that handles only Yjs document synchronization with auth modes 1 (open) and 2 (shared token). Fix a critical bug in WebSocket connection tracking, add server-side auth validation, and decouple from the workspace client system.

## Motivation

### Current State

The sync plugin lives inside a full REST server that requires workspace clients:

```typescript
// packages/server/src/server.ts
function createServer(clients: AnyWorkspaceClient[], options?: ServerOptions) {
  // Mounts: REST tables, actions, OpenAPI docs, AND sync
  .use(createSyncPlugin({ getDoc: (room) => workspaces[room]?.ydoc }))
  .use(createTablesPlugin(workspaces))
  // ...
}
```

The sync plugin (`packages/server/src/sync/index.ts`) tracks connections using Elysia's `ws` wrapper objects:

```typescript
// open handler
rooms.get(room)!.add(ws); // stores open-event wrapper

// close handler
rooms.get(room)?.delete(ws); // tries to delete close-event wrapper (DIFFERENT object)

// message handler (broadcast filter)
if (conn !== ws) {
	// compares open-event wrapper vs message-event wrapper
	conn.send(awarenessMessage);
}
```

But the code itself documents:

```typescript
// IMPORTANT: Elysia creates a new wrapper object for each event (open, message, close),
// so `ws` objects are NOT identity-stable across handlers. However, `ws.raw` IS stable.
```

This creates problems:

1. **Connections never removed from rooms**: `Set.delete(ws)` in `close()` can't find the `ws` added in `open()` because they're different objects. Room sizes grow forever.
2. **Room eviction never triggers**: Since room size never reaches 0, the 60-second eviction timer never starts. Rooms and their Y.Docs leak.
3. **Awareness echoes back to sender**: The `conn !== ws` filter in broadcast always passes (different wrapper objects), so the sender receives their own awareness updates.
4. **No server-side auth**: The client sends `?token=xxx` but the server ignores it. `createSyncPlugin` accepts only `{ getDoc }`.
5. **Over-coupled to workspace system**: Can't use sync without `AnyWorkspaceClient[]` and the full REST server.

### Desired State

A minimal sync server that:

- Fixes the ws identity bug using `ws.raw` for all tracking
- Validates auth tokens on connection (modes 1 and 2)
- Works standalone (just give it Y.Docs)
- Keeps the existing protocol layer intact (`protocol.ts` is solid)

```typescript
// Desired: standalone sync server
const server = createSyncServer({
	auth: { token: 'my-secret' }, // Mode 2. Omit for Mode 1 (open).
	getDoc: (room) => docs.get(room),
	port: 3913,
});
```

## Research Findings

### How y-websocket and y-sweet Handle This

| Aspect         | y-websocket (reference)              | y-sweet (production)                    | Current Epicenter                      |
| -------------- | ------------------------------------ | --------------------------------------- | -------------------------------------- |
| Room tracking  | `Map<string, Set<WebSocket>>`        | Doc-level connection tracking           | `Map<string, Set<ws wrapper>>` (buggy) |
| WS identity    | Node `ws` library (stable objects)   | Rust (stable connection IDs)            | Elysia wrappers (NOT stable)           |
| Auth           | None in default server               | Two-tier: server tokens + client tokens | Client sends token, server ignores it  |
| Document store | In-memory `Map<string, WSSharedDoc>` | On-demand load + persistence + GC       | Delegates to workspace client's `ydoc` |
| Server scope   | Sync only                            | Sync + REST API for doc management      | Sync + REST tables + actions + OpenAPI |
| Room cleanup   | Destroy when empty                   | GC worker after inactivity              | 60s eviction timer (never triggers)    |

**Key finding**: Both y-websocket and y-sweet track connections using identity-stable objects. Our Elysia wrapper instability is a Bun-specific footgun that the code acknowledges but doesn't handle correctly.

**Implication**: All connection tracking must use `ws.raw` (the stable Bun ServerWebSocket). The rooms Set, broadcast filter, and cleanup must all key off `ws.raw`.

### Auth Pattern Comparison

| Auth Mode       | Client (`@epicenter/sync`)  | Server (current) | Server (needed)                        |
| --------------- | --------------------------- | ---------------- | -------------------------------------- |
| Mode 1: Open    | No token sent               | No check         | No check (correct)                     |
| Mode 2: Shared  | `?token=xxx` in URL         | Token ignored    | Compare `?token` against config secret |
| Mode 3: Dynamic | `getToken()` → `?token=xxx` | Token ignored    | Out of scope (needs JWT verification)  |

## Design Decisions

| Decision                       | Choice                     | Rationale                                                                                    |
| ------------------------------ | -------------------------- | -------------------------------------------------------------------------------------------- |
| Fix ws identity tracking       | Use `ws.raw` everywhere    | Code already documents the instability. `ws.raw` is the documented stable key.               |
| Auth modes to support          | Modes 1 and 2 only         | User requested. Mode 3 requires JWT infrastructure: defer.                                  |
| Server coupling                | Keep sync plugin separate  | `createSyncPlugin` is already an Elysia plugin. Fix it in place, make `createServer` use it. |
| Add auth to plugin or server   | Plugin level               | Auth belongs at the WebSocket upgrade, not in an outer wrapper.                              |
| Room tracking data structure   | `Map<string, Set<object>>` | Use `ws.raw` as the Set element. `ws.raw` is identity-stable per connection.                 |
| Broadcast: store send function | Map `ws.raw → send fn`     | Need to call `ws.send()` but keyed by `ws.raw`. Store the callable at connection time.       |
| Standalone sync server factory | New `createSyncServer()`   | Thin wrapper around Elysia + the fixed sync plugin. No workspace system dependency.          |
| Keep existing `createServer`   | Yes, uses fixed plugin     | Existing consumers shouldn't break. `createServer` continues to mount tables + sync.         |

## Architecture

### Fixed Connection Tracking

```
                    open(ws)
                       │
                       ▼
              ┌──────────────────┐
              │  ws.raw (stable) │──── Key for ALL tracking
              └──────────────────┘
                       │
            ┌──────────┼──────────┐
            ▼          ▼          ▼
     rooms Set    connectionState   broadcast filter
    (ws.raw)     WeakMap (ws.raw)   (conn.raw !== ws.raw)
```

### Auth Flow (Mode 2)

```
STEP 1: Client connects
────────────────────────
ws://host:3913/:room/sync?token=my-secret

STEP 2: Server validates on upgrade
────────────────────────────────────
- Extract ?token from URL
- If auth configured and token doesn't match → ws.close(4401, "Unauthorized")
- If auth not configured or token matches → proceed to sync

STEP 3: Normal sync protocol
─────────────────────────────
- Send sync step 1
- Handle messages (sync, awareness, sync status)
- Same as current, but with fixed connection tracking
```

### Standalone Sync Server

```
┌─────────────────────────────────────────────┐
│  createSyncServer(config)                   │
│  ├── auth?: { token: string }               │
│  ├── getDoc: (room) => Y.Doc | undefined    │
│  ├── port?: number (default 3913)           │
│  └── onRoomEmpty?: (room) => void           │
│                                             │
│  Returns: { start(), destroy() }            │
└─────────────────────────────────────────────┘
         │
         │ uses
         ▼
┌─────────────────────────────────────────────┐
│  createSyncPlugin(config)                   │
│  ├── getDoc: (room) => Y.Doc | undefined    │
│  ├── auth?: { token: string }               │  ← NEW
│  └── onRoomEmpty?: (room) => void           │  ← NEW
│                                             │
│  Elysia plugin: /workspaces/:room/sync      │
│  (or configurable path pattern)             │
└─────────────────────────────────────────────┘
```

## Implementation Plan

### Phase 1: Fix the ws identity bug

- [ ] **1.1** In `createSyncPlugin`, change rooms tracking from `Set<{ send }>` to `Map<object, { send }>` keyed by `ws.raw`
- [ ] **1.2** In `open()`: store `ws.raw → ws.send.bind(ws)` (capture send fn at open time)
- [ ] **1.3** In `close()`: delete by `ws.raw` key (guaranteed match)
- [ ] **1.4** In `message()` awareness broadcast: filter by `rawKey !== ws.raw`
- [ ] **1.5** Verify room size checks and eviction timer work with the new structure

### Phase 2: Add auth modes 1 and 2

- [ ] **2.1** Add `auth?: { token: string }` to `SyncPluginConfig`
- [ ] **2.2** In `open()`: if auth configured, extract `?token` from `ws.data.query` or URL, compare against config. Close with 4401 if mismatch.
- [ ] **2.3** If no auth configured, skip validation (Mode 1)

### Phase 3: Standalone sync server factory

- [ ] **3.1** Create `createSyncServer()` function that wraps Elysia + fixed sync plugin
- [ ] **3.2** Accept `getDoc`, `auth`, `port` config
- [ ] **3.3** Return `{ start(), destroy() }`: no tables, no actions, no OpenAPI

### Phase 4: Update `createServer` to use fixed plugin

- [ ] **4.1** Pass auth config through `createServer` to `createSyncPlugin`
- [ ] **4.2** Existing tests should still pass since protocol layer is unchanged

## Edge Cases

### Auth token in URL logging

1. Token is passed as `?token=xxx` in the WebSocket URL
2. Proxies, load balancers, or log aggregators may capture query strings
3. For Mode 2 this is acceptable (shared secret for LAN/Tailscale). For production (Mode 3), tokens should be short-lived JWTs.

### Room with no matching doc

1. Client connects to `ws://host/unknown-room/sync`
2. `getDoc("unknown-room")` returns `undefined`
3. Server closes with 4004 (already handled correctly)

### Simultaneous disconnect of all clients

1. Multiple clients disconnect at the same moment
2. Each `close()` handler runs: only the last one should start the eviction timer
3. Current code handles this: checks `room.size === 0` before starting timer

### Reconnection during eviction window

1. Last client disconnects, 60s eviction timer starts
2. New client connects within 60s
3. Timer is cancelled (already handled: `clearTimeout` in `open()`)

## Open Questions

1. **URL pattern: `/workspaces/:room/sync` vs `/:room/sync`?**
   - Current uses `/workspaces/:workspaceId/sync`: tied to workspace concept
   - A standalone sync server might want `/:room` or a configurable pattern
   - **Recommendation**: Keep `/workspaces/:room/sync` for backward compat in `createServer`, but make `createSyncServer` use `/:room/sync` (or make it configurable)

2. **Should `createSyncServer` also serve a health endpoint?**
   - y-sweet has health checks for storage backend
   - A `GET /` returning `{ status: "ok", rooms: [...] }` is cheap
   - **Recommendation**: Add a minimal `GET /` health endpoint. No OpenAPI overhead.

3. **Room eviction callback: should `createSyncServer` expose `onRoomEmpty`?**
   - Useful for persistence layers that want to flush/snapshot when rooms empty
   - **Recommendation**: Yes, add as optional callback in config. The standalone server doesn't persist, but consumers might.

## Success Criteria

- [ ] Existing `packages/server` tests pass unchanged
- [ ] New test: connect two mock clients, verify sync works bidirectionally
- [ ] New test: disconnect client, verify room tracking updates correctly
- [ ] New test: Mode 2 auth rejects invalid token with 4401
- [ ] New test: Mode 1 (no auth config) accepts all connections
- [ ] New test: `createSyncServer` starts, accepts connections, syncs a Y.Doc
- [ ] No changes to `packages/sync` (client is fine)
- [ ] No changes to `packages/server/src/sync/protocol.ts` (protocol layer is fine)

## References

- `packages/server/src/sync/index.ts`: The buggy sync plugin (main fix target)
- `packages/server/src/sync/protocol.ts`: Protocol layer (no changes needed)
- `packages/server/src/server.ts`: Current server that wraps the plugin
- `packages/sync/src/provider.ts`: Client-side provider (no changes needed)
- `packages/sync/src/types.ts`: Auth mode types for reference
