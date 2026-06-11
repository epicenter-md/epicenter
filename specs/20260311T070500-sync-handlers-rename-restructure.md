# Sync Handlers Rename & Restructure

**Date**: 2026-03-11
**Status**: Complete
**Author**: AI-assisted

## Overview

Rename and restructure the three exported functions in `sync-handlers.ts` to reflect their actual responsibilities, separate pure computation from side effects, and adopt destructured object parameters for all multi-argument signatures.

## Motivation

### Current State

```typescript
// sync-handlers.ts: current API
export function handleWsOpen(doc: Y.Doc, awareness: Awareness, ws: WebSocket)
  : { initialMessages: Uint8Array[]; state: ConnectionState }

export function handleWsMessage(data: Uint8Array, state: ConnectionState)
  : Result<SyncEffect[], SyncHandlerError>

export function handleWsClose(state: ConnectionState): void
```

```typescript
// ConnectionState: current type
export type ConnectionState = {
  ws: WebSocket;
  doc: Y.Doc;              // same for ALL connections
  awareness: Awareness;    // same for ALL connections
  controlledClientIds: Set<number>;
  updateHandler: (...) => void;      // only exists for cleanup
  awarenessHandler: (...) => void;   // only exists for cleanup
};
```

This creates problems:

1. **Naming lies about abstraction level.** `handleWs*` suggests these ARE the WebSocket event handlers, but they're called two layers below the actual DO handlers (`webSocketMessage` → `hub.dispatch` → `handleWsMessage`). They're protocol functions, not WebSocket handlers.

2. **`handleWsOpen` does two unrelated things.** It computes initial messages (pure) AND registers event listeners (side effect). Evidence: `restoreHibernated()` calls it but discards `initialMessages`: wasted computation.

3. **`ConnectionState` conflates shared and per-connection state.** Every connection carries redundant `doc` and `awareness` references. The hub already has these in its closure.

4. **`handleWsMessage` is half-honest about effects.** It mutates doc/awareness inline (via `applyUpdateV2`, `applyAwarenessUpdate`) then returns additional effects. The name "handle" obscures the mutation.

5. **Positional arguments.** `handleWsOpen(doc, awareness, ws)`: three positional args with no labels at the call site. The rest of the sync layer (protocol.ts) already uses destructured objects: `encodeSyncStep1({ doc })`, `handleSyncPayload({ syncType, payload, doc, origin })`.

### Desired State

```typescript
// sync-handlers.ts: proposed API (all single-argument destructured objects)

function computeInitialMessages({ doc, awareness }: RoomContext): Uint8Array[]

function registerConnection({ doc, awareness, ws }: { ...RoomContext; ws: WebSocket }): Connection

function applyMessage({ data, room, connection }: {
  data: Uint8Array;
  room: RoomContext;
  connection: Connection;
}): Result<SyncEffect[], SyncHandlerError>

function teardownConnection({ room, connection }: {
  room: RoomContext;
  connection: Connection;
}): void
```

```typescript
type RoomContext = { doc: Y.Doc; awareness: Awareness }

type Connection = {
  ws: WebSocket;
  controlledClientIds: Set<number>;
  unregister: () => void;  // replaces exposed handler references
}
```

## Research Findings

### External Reference Patterns

| Source | Naming Pattern | State Management |
|--------|---------------|-----------------|
| **CF Durable Objects** | `webSocketMessage`, `webSocketClose`: lifecycle methods on DO class | Per-connection: `serializeAttachment()`. Shared: DO instance fields. Clear separation. |
| **Yjs y-websocket-server** | Verb-oriented: `readSyncMessage`, `writeSyncStep1`, `writeUpdate` | `WSSharedDoc` with `conns: Map<conn, Set<clientId>>`: shared doc is the room, per-conn state is just the ID set. |
| **Yjs y-protocols** | `messageYjsSyncStep1`, `messageYjsUpdate`: constants, not handler names | N/A (protocol layer only) |
| **This codebase (protocol.ts)** | Already uses destructured objects: `encodeSyncStep1({ doc })`, `handleSyncPayload({ syncType, payload, doc, origin })` | N/A |

**Key finding**: Both CF and Yjs separate shared room state from per-connection state. Our `ConnectionState` type conflates them. Both ecosystems use verb-oriented function names describing what the function DOES, not when it's called.

**Implication**: Renaming to `computeInitialMessages` / `registerConnection` / `applyMessage` / `teardownConnection` aligns with both CF and Yjs conventions. Splitting `RoomContext` from `Connection` matches both ecosystems' separation patterns.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Split `handleWsOpen` into two functions | `computeInitialMessages` + `registerConnection` | Separates pure computation from side-effectful registration. Eliminates wasted work in `restoreHibernated()`. |
| Rename `handleWsMessage` → `applyMessage` | `applyMessage` | Honest about mutation: "apply" signals doc/awareness will be mutated. Consistent with Yjs naming (`applyUpdateV2`, `applyAwarenessUpdate`). |
| Rename `handleWsClose` → `teardownConnection` | `teardownConnection` | Pairs with `registerConnection`. Describes cleanup responsibility, not event timing. |
| All functions take destructured objects | Single `{ ... }` parameter | Matches `protocol.ts` conventions (`encodeSyncStep1({ doc })`). Self-documenting at call sites. All functions take 2+ logical arguments. |
| Extract `RoomContext` type | `{ doc: Y.Doc; awareness: Awareness }` | Makes shared-vs-per-connection distinction explicit. Eliminates redundant doc/awareness in every Connection. |
| Replace handler fields with `unregister()` | Single cleanup closure | `updateHandler`/`awarenessHandler` are implementation details that only exist for `doc.off()` calls. `unregister()` hides this. |
| Rename `ConnectionState` → `Connection` | `Connection` | Shorter, less generic. "State" describes any bag of data; "Connection" describes what this represents. |
| Keep `SyncEffect` unchanged | No change | The effect system is well-designed. No reason to touch it. |

## Architecture

```
BEFORE (handleWsOpen does two things):
─────────────────────────────────────

hub.upgrade()
  └─ handleWsOpen(doc, awareness, server)
       ├─ compute initial messages    ← pure
       └─ register event listeners    ← side effect
       └─ return { initialMessages, state: ConnectionState }

hub.restoreHibernated()
  └─ handleWsOpen(doc, awareness, ws)
       ├─ compute initial messages    ← WASTED (discarded)
       └─ register event listeners    ← side effect
       └─ return { state }            ← only this is used


AFTER (split by responsibility):
─────────────────────────────────

hub.upgrade()
  ├─ computeInitialMessages({ doc, awareness })     ← pure
  └─ registerConnection({ doc, awareness, ws })      ← side effect

hub.restoreHibernated()
  └─ registerConnection({ doc, awareness, ws })      ← no wasted computation
```

```
BEFORE (ConnectionState carries shared state):
──────────────────────────────────────────────

ConnectionState = {
  ws,                      ← per-connection
  doc,                     ← SHARED (same for all)
  awareness,               ← SHARED (same for all)
  controlledClientIds,     ← per-connection
  updateHandler,           ← per-connection (cleanup detail)
  awarenessHandler,        ← per-connection (cleanup detail)
}

AFTER (clean separation):
─────────────────────────

RoomContext = {
  doc,                     ← shared, passed explicitly
  awareness,               ← shared, passed explicitly
}

Connection = {
  ws,                      ← per-connection
  controlledClientIds,     ← per-connection
  unregister(),            ← per-connection (encapsulates cleanup)
}
```

## Implementation Plan

### Phase 1: Type Changes

- [x] **1.1** Add `RoomContext` type to `sync-handlers.ts`
- [x] **1.2** Replace `ConnectionState` with `Connection` type (drop `doc`, `awareness`, `updateHandler`, `awarenessHandler`; add `unregister`)
- [x] **1.3** Update `SyncHandlerError`: no changes expected, but verify

### Phase 2: Function Renames & Splits

- [x] **2.1** Split `handleWsOpen` into `computeInitialMessages({ doc, awareness })` and `registerConnection({ doc, awareness, ws })`
- [x] **2.2** Rename `handleWsMessage` → `applyMessage({ data, room, connection })`: destructured object input
- [x] **2.3** Rename `handleWsClose` → `teardownConnection({ room, connection })`: destructured object input

### Phase 3: Update Callers

- [x] **3.1** Update `createConnectionHub` in `base-sync-room.ts`: use new function names and separated `RoomContext` / `Connection` types
- [x] **3.2** Update `restoreHibernated()`: call only `registerConnection`, no wasted `computeInitialMessages`
- [x] **3.3** Update `upgrade()`: call both `computeInitialMessages` and `registerConnection`
- [x] **3.4** Update `dispatch()`: pass `room` and `connection` separately to `applyMessage`
- [x] **3.5** Update `close()`: pass `room` and `connection` separately to `teardownConnection`

### Phase 4: Update Tests

- [x] **4.1** Update imports and function calls in `sync-handlers.test.ts`
- [x] **4.2** Update test setup helpers (`setup()`, `setupTwoClients()`) to use new types
- [x] **4.3** Verify all tests pass with `bun test`

### Phase 5: Verify

- [x] **5.1** Run `bun run typecheck`: no type errors
- [x] **5.2** Run `bun test` in `packages/server-remote`: all green
- [x] **5.3** Verify no other packages import from `sync-handlers.ts` (it's internal to the CF package)

## Edge Cases

### Hibernation Restoration

1. DO wakes from hibernation, `restoreHibernated()` runs
2. Previously called `handleWsOpen` which computed and discarded `initialMessages`
3. After refactor: calls only `registerConnection`: no wasted computation
4. Must verify `controlledClientIds` restoration from attachment still works

### Effect System Unchanged

1. `applyMessage` still returns `Result<SyncEffect[], Error>`
2. The hub's `dispatch()` still processes effects in order
3. No behavioral change: only the function boundary moves

## Open Questions

1. **Should `RoomContext` be a named export?**
   - It's useful for the hub and tests, but it's a simple two-field type
   - **Recommendation**: Export it. Tests and `createConnectionHub` both benefit from the shared type name.

2. **Should `applyMessage` take `{ data, room, connection }` or `{ data, ...room, connection }`?**
   - Flat: `{ data, doc, awareness, connection }`: more fields but no nesting
   - Nested: `{ data, room, connection }`: fewer fields, clearer grouping
   - **Recommendation**: Nested `{ data, room, connection }`. The grouping makes the shared-vs-per-connection distinction visible at the call site.

## Success Criteria

- [x] All functions in `sync-handlers.ts` take a single destructured object parameter
- [x] `ConnectionState` replaced by `Connection` (no `doc`/`awareness` fields)
- [x] `RoomContext` type exists and is used consistently
- [x] `handleWsOpen` split into two functions: `restoreHibernated` no longer wastes computation
- [x] All 15+ tests in `sync-handlers.test.ts` pass unchanged (behavior preserved)
- [x] `bun run typecheck` clean
- [x] No other packages affected (verify with grep)

## References

- `packages/server-remote/src/sync-handlers.ts`: primary target
- `packages/server-remote/src/base-sync-room.ts`: main consumer (createConnectionHub)
- `packages/server-remote/src/sync-handlers.test.ts`: tests to update
- `packages/sync/src/protocol.ts`: reference for destructured object convention
- `packages/server-remote/src/workspace-room.ts`: subclass (verify unaffected)
- `packages/server-remote/src/document-room.ts`: subclass (verify unaffected)
