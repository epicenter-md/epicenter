# Three-Layer Sync Package Split

**Status**: Implemented
**Context**: `sync-core` was collapsed into `@epicenter/sync` (protocol + handlers). Following the yjs ecosystem's direction (`@y/protocols` → `@y/websocket` → `@y/websocket-server`), split into three clean layers.

## Current State

`@epicenter/sync` contains two modules with different concerns:

| Module | Concern | Consumers |
|---|---|---|
| `protocol.ts` | Pure encode/decode (wire protocol) | sync-client, server-local (indirectly), server-remote |
| `handlers.ts` | Server-side WS connection lifecycle | server-local, server-remote |

`@epicenter/sync-client` is already clean: client-side providers only.

## Problem

`handlers.ts` is server-side WS lifecycle logic (registers doc/awareness listeners, manages per-connection state, handles cleanup). It's not a protocol primitive. Merging it with `protocol.ts` means:

1. Client packages (`sync-client`) depend on a package that contains server-only code
2. The boundary doesn't match the yjs ecosystem's emerging `@y/protocols` / `@y/websocket-server` split
3. Adding server-only dependencies later would leak into client bundles

## Target Architecture

```
@epicenter/sync            ← pure protocol (encode/decode, constants, Awareness re-export)
@epicenter/sync-client     ← client providers (already exists, no changes)
@epicenter/sync-server     ← server WS lifecycle handlers (NEW)
```

### Dependency graph

```
@epicenter/sync-client ──────→ @epicenter/sync
@epicenter/sync-server ──────→ @epicenter/sync
server-local ────────────────→ @epicenter/sync-server
server-remote ────→ @epicenter/sync-server
```

`sync-client` and `sync-server` both depend on `sync` (protocol). Neither depends on the other.

## Import Map: Before → After

### server-local/src/sync/ws-plugin.ts

```diff
-import {
-	type ConnectionState,
-	handleWsClose,
-	handleWsMessage,
-	handleWsOpen,
-} from '@epicenter/sync';
+import {
+	type ConnectionState,
+	handleWsClose,
+	handleWsMessage,
+	handleWsOpen,
+} from '@epicenter/sync-server';
```

### server-remote/src/document-room.ts

```diff
-import {
-	Awareness,
-	type ConnectionState,
-	decodeSyncRequest,
-	handleWsClose,
-	handleWsMessage,
-	handleWsOpen,
-	stateVectorsEqual,
-} from '@epicenter/sync';
+import {
+	decodeSyncRequest,
+	stateVectorsEqual,
+} from '@epicenter/sync';
+import {
+	Awareness,
+	type ConnectionState,
+	handleWsClose,
+	handleWsMessage,
+	handleWsOpen,
+} from '@epicenter/sync-server';
```

### server-remote/src/workspace-room.ts

Same pattern as document-room.ts: split the import.

### sync-client (NO CHANGES)

`sync-client` only imports protocol symbols (`MESSAGE_TYPE`, `encodeSyncStep1`, `handleSyncMessage`, etc.) from `@epicenter/sync`. It never touches handlers. Zero changes needed.

## Proposal

### Wave 1: Create `@epicenter/sync-server`

1. Create `packages/sync-server/package.json`:
   ```json
   {
     "name": "@epicenter/sync-server",
     "version": "0.0.1",
     "main": "./src/index.ts",
     "types": "./src/index.ts",
     "exports": { ".": "./src/index.ts" },
     "license": "AGPL-3.0",
     "scripts": { "typecheck": "tsc --noEmit" },
     "dependencies": {
       "@epicenter/sync": "workspace:*",
       "lib0": "catalog:",
       "y-protocols": "catalog:"
     },
     "peerDependencies": { "yjs": "catalog:" },
     "devDependencies": {
       "@types/bun": "catalog:",
       "typescript": "catalog:"
     }
   }
   ```

2. Create `packages/sync-server/tsconfig.json`: copy from `packages/sync/tsconfig.json`

3. Move `packages/sync/src/handlers.ts` → `packages/sync-server/src/handlers.ts`
   - Update internal import: `from './protocol'` → `from '@epicenter/sync'`
   - The file imports these from protocol: `encodeAwareness`, `encodeAwarenessStates`, `encodeSyncStatus`, `encodeSyncStep1`, `encodeSyncUpdate`, `handleSyncMessage`, `MESSAGE_TYPE`
   - It also imports `Awareness` from `y-protocols/awareness` and `decoding` from `lib0/decoding` directly: these stay as-is

4. Create `packages/sync-server/src/index.ts`:
   ```ts
   /**
    * @epicenter/sync-server: Server-Side Sync Handlers
    *
    * Framework-agnostic WS connection lifecycle. Adapters (Elysia, Cloudflare Workers)
    * call these handlers and map the results to their transport layer.
    */
   export {
     type ConnectionId,
     type ConnectionState,
     handleWsClose,
     handleWsMessage,
     handleWsOpen,
     type WsMessageResult,
     type WsOpenResult,
   } from './handlers';

   // Re-export Awareness so server consumers don't need a direct y-protocols dependency
   export { Awareness } from 'y-protocols/awareness';
   ```

### Wave 2: Update `@epicenter/sync` (remove handler exports)

1. Update `packages/sync/src/index.ts`: remove all handler re-exports:
   ```ts
   /**
    * @epicenter/sync: Sync Wire Protocol
    *
    * Pure encode/decode functions for the yjs sync protocol.
    * No framework deps. No connection lifecycle. Only yjs + lib0 + y-protocols.
    */
   export {
     type DecodedSyncMessage,
     decodeMessageType,
     decodeSyncMessage,
     decodeSyncRequest,
     decodeSyncStatus,
     encodeAwareness,
     encodeAwarenessStates,
     encodeQueryAwareness,
     encodeSyncRequest,
     encodeSyncStatus,
     encodeSyncStep1,
     encodeSyncStep2,
     encodeSyncUpdate,
     handleSyncMessage,
     MESSAGE_TYPE,
     type MessageType,
     SYNC_MESSAGE_TYPE,
     type SyncMessageType,
     stateVectorsEqual,
   } from './protocol';
   ```

   Note: `Awareness` re-export moves to `sync-server`. `sync-client` already has its own direct `y-protocols` dependency.

2. Delete `packages/sync/src/handlers.ts` (moved in Wave 1)

3. Remove `lib0` from `packages/sync/package.json` dependencies IF `protocol.ts` doesn't import it directly.
   > **Check**: `protocol.ts` imports `lib0/decoding` and `lib0/encoding`: `lib0` stays.

### Wave 3: Update server consumers

1. **`packages/server-local/package.json`**: Change `@epicenter/sync` → `@epicenter/sync-server` in dependencies
   > `server-local/src/sync/ws-plugin.ts` only imports handler symbols (`ConnectionState`, `handleWsOpen/Message/Close`). It doesn't use any protocol symbols directly. So the dep on `@epicenter/sync` can be replaced entirely.

2. **`packages/server-remote/package.json`**: Add `@epicenter/sync-server` to dependencies. Keep `@epicenter/sync` (CF rooms use `decodeSyncRequest` and `stateVectorsEqual` from protocol).

3. Update import paths in:
   - `packages/server-local/src/sync/ws-plugin.ts`: change `'@epicenter/sync'` → `'@epicenter/sync-server'`
   - `packages/server-remote/src/document-room.ts`: split import (protocol from `sync`, handlers from `sync-server`)
   - `packages/server-remote/src/workspace-room.ts`: same split

4. Run `bun install` to wire up the new workspace package.

### Wave 4: Verify

1. `bun run typecheck` across all affected packages
2. `bun test packages/sync/`: protocol tests still pass
3. `bun test packages/server-local/`: ws-plugin integration tests still pass
4. `bun test packages/sync-client/`: client tests unaffected

## What This Does NOT Change

- `protocol.ts` stays in `@epicenter/sync`: pure encode/decode, no lifecycle
- `sync-client` is untouched: it only imports protocol symbols
- No API changes: all functions keep the same signatures
- No wire protocol changes: same bytes on the wire

## Risk

Low. This is a file move + import path updates. No logic changes. The handler API (`handleWsOpen/Message/Close`) and all its types are unchanged.

## Decision: Where does `Awareness` re-export live?

Currently `@epicenter/sync` re-exports `Awareness` from `y-protocols/awareness` as a convenience. After the split:

- `sync-server` needs it (handlers create/manage awareness state)
- `sync-client` has its own `y-protocols` dependency already
- Protocol-level encode/decode functions take `awareness: Awareness` as args

**Decision**: Move the `Awareness` re-export to `sync-server`. Server consumers get it from there. `sync-client` already imports `Awareness` directly from `y-protocols/awareness`. If a protocol consumer needs the type, they can import from `y-protocols` directly: it's a peer dep anyway.

Alternatively, keep it in `@epicenter/sync` too: re-exporting from two places is fine since it's the same underlying type. But cleaner to have one canonical source per layer.

## Review

**Completed**: 2026-03-08
**Branch**: braden-w/tab-mgr-sync-upgrade

### Summary

Split `@epicenter/sync` into `@epicenter/sync` (protocol) + `@epicenter/sync-server` (handlers) as a separate workspace package. The prior commit (`ae9bca629`) had already done the logical split via subpath exports (`@epicenter/sync/server`), so this change promoted the subpath into its own package and updated all consumer imports.

### Deviations from Spec

- Wave 2 item 3 (remove `lib0` dep): Not applicable: `protocol.ts` uses `lib0` directly, so it stays.
- The spec's import map assumed pre-subpath-split imports (`from '@epicenter/sync'` for handlers). The actual starting point was post-subpath-split (`from '@epicenter/sync/server'`), making the consumer changes simpler.
- `Awareness` re-export removed from `@epicenter/sync` entirely (moved to `sync-server` only), per the spec's decision.
- Also removed `packages/sync/src/server.ts` (the subpath barrel file from the prior commit): not mentioned in spec since it didn't exist when spec was written.
