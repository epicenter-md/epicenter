# Sync-Core Simplification

**Status**: Implemented
**Context**: `server-remote-standalone` was removed in `666828eaf`. `sync-core` now has two consumers with divergent needs. Time to tighten the package boundaries.

## Current State

`@epicenter/sync` has three modules:

| Module | What it does | Used by server-local | Used by server-remote |
|---|---|---|---|
| `protocol.ts` | Binary encode/decode for all wire message types | Indirectly (via handlers) | Yes (`decodeSyncRequest`, `stateVectorsEqual`) |
| `handlers.ts` | Framework-agnostic WS lifecycle (`handleWsOpen/Message/Close`) | Yes | Yes |
| `rooms.ts` | In-memory room manager (Y.Doc + Awareness + connection map + eviction) | Yes (sole consumer) | No (DOs are the rooms) |

Other issues:
- `package.json` exports `"./discovery"` pointing to `src/discovery/index.ts`: directory was deleted in `7d32c0a6b`
- `@epicenter/sync` lists `@epicenter/sync` as a dependency but has zero imports from it (added on current branch, may be intentional for upcoming work: verify before removing)

## Problem

`rooms.ts` exists in sync-core as a "shared primitive" but has exactly one consumer (`server-local`). It was kept during the standalone removal with the rationale "useful for tests and potential future standalone." But:

1. It's not a protocol primitive: it's an in-memory connection lifecycle manager with Elysia-specific design assumptions (`ws.raw` as `object` key)
2. Its config surface (`getDoc`, `onRoomCreated`, `onRoomEvicted`, `evictionTimeout`) exists to serve `server-local`'s sidecar pattern
3. CF doesn't need it: each Durable Object IS its own room with its own `Map<WebSocket, ConnectionState>` and platform-managed lifecycle
4. Keeping it in sync-core creates the illusion of reusability that doesn't exist

## Proposal

### Wave 1: Inline `rooms.ts` into `server-local`

Move `rooms.ts` and `rooms.test.ts` from `packages/sync-core/src/` to `packages/server-local/src/sync/`.

**sync-core becomes**: pure protocol primitives (encode/decode + handlers). This is exactly what both consumers actually share.

**server-local gets**: the room manager it exclusively uses, co-located with the Elysia plugin that wraps it. The `WsSyncPluginConfig` type already redeclares the same `getDoc`/`onRoomCreated`/`onRoomEvicted` config: after inlining, that duplication collapses.

Changes:
- [x] 1. Move `sync-core/src/rooms.ts` → `server-local/src/sync/rooms.ts`
- [x] 2. Move `sync-core/src/rooms.test.ts` → `server-local/src/sync/rooms.test.ts`
- [x] 3. Remove `createRoomManager` export from `sync-core/src/index.ts`
- [x] 4. Update `ws-plugin.ts` import from `'@epicenter/sync'` to `'./rooms'`
- [x] 5. Added `y-protocols` as direct dependency to `server-local/package.json`
  > rooms.ts imports from `y-protocols/awareness`: previously resolved transitively via sync-core, now needs explicit declaration.
- [x] 6. `handlers.ts` and `protocol.ts` still use yjs/y-protocols, so those deps stay in sync-core

### Wave 2: Clean up `sync-core` package.json

- [x] 1. Remove the `"./discovery"` export (broken, points to deleted directory)
- [x] 2. Verify whether `@epicenter/sync` actually needs the `@epicenter/sync` dependency
  > **Verified**: `@epicenter/sync` actively imports `encodeSyncUpdate`, `handleSyncMessage`, `encodeSyncStatus`, `encodeSyncStep2`, and `encodeSyncRequest` from sync-core. Dependency is real, kept.

### Wave 3 (optional): Collapse `WsSyncPluginConfig` duplication

- [x] Exported `RoomManagerConfig` from `rooms.ts`
- [x] Changed `WsSyncPluginConfig` to `RoomManagerConfig & { verifyToken?: ... }`
- [x] Simplified `createRoomManager(config)` call: passes config directly instead of destructuring individual fields
- [x] Removed unused `import type * as Y from 'yjs'` from `ws-plugin.ts`

## What This Does NOT Change

- `protocol.ts` and `handlers.ts` stay in `sync-core`: both server-local and CF use them
- `@epicenter/sync` (client provider) is unaffected: it has its own protocol implementation
- The room manager API (`join`/`leave`/`broadcast`/`destroy`) stays the same: this is a move, not a rewrite

## Risk

Low. This is a file move within the monorepo. The room manager's API and tests are unchanged. The only import path that changes is in `ws-plugin.ts` (one line).

If a future standalone server needs room management, extracting it back out (or just importing from `@epicenter/server-local`) is trivial. YAGNI until then.

## Review

**Completed**: 2026-03-08
**Branch**: braden-w/tab-mgr-sync-upgrade

### Summary

Moved `rooms.ts` and its tests from `sync-core` to `server-local`, making sync-core a pure protocol primitives package. Collapsed `WsSyncPluginConfig` type duplication now that rooms and the plugin are co-located. Removed the broken `./discovery` export from sync-core's package.json.

### Deviations from Spec

- Added `y-protocols` as an explicit dependency to `server-local/package.json`: not called out in the spec but required since `rooms.ts` imports from `y-protocols/awareness` directly.
- `@epicenter/sync`'s dependency on sync-core was verified as real (5 active imports), so it was kept rather than removed.
