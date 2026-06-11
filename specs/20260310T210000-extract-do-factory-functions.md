# Extract Durable Object Factory Functions

## Goal

Extract three factory functions from the duplicated code in `WorkspaceRoom` and `DocumentRoom`:
- `createUpdateLog`: SQLite persistence + compaction
- `createConnectionHub`: WebSocket lifecycle map + dispatch + broadcast
- `createAutoSaveTracker`: dedup auto-save on last disconnect (DocumentRoom only)

## Approach

Create a single new file `room-helpers.ts` containing all three factories. Refactor both DO classes to use them. Existing `sync-handlers.ts` stays untouched. The hub calls into it.

## Todo

- [x] Create `room-helpers.ts` with `createUpdateLog`, `createConnectionHub`, `createAutoSaveTracker`
- [x] Refactor `WorkspaceRoom` to use `createUpdateLog` + `createConnectionHub`
- [x] Refactor `DocumentRoom` to use all three
- [x] Delete duplicated `swallow` function (now imported via hub from sync-handlers)
- [x] Delete duplicated `MAX_COMPACTED_BYTES` constant (now in room-helpers)
- [x] Delete duplicated `WsAttachment` type (now in room-helpers)
- [x] Fix sync-handlers.test.ts to use new `SyncEffect[]` API
- [x] Run existing sync-handlers tests: 22/22 pass
- [x] Run typecheck: server-remote clean (pre-existing @epicenter/ai failure unrelated)
- [x] Update spec with review

## Non-goals

- Changing sync-handlers.ts
- Changing the public RPC interface (sync, getDoc, snapshots)
- Changing app.ts routes

## Review

### What changed

Three factory functions extracted into `room-helpers.ts`, each encapsulating a distinct unit of coupled state:

1. **`createUpdateLog`**: SQLite DDL, cold-start loading with compaction, live `updateV2` persistence. Owns `MAX_COMPACTED_BYTES`.
2. **`createConnectionHub`**: `Map<WebSocket, ConnectionState>`, upgrade, dispatch (SyncEffect[] processing), close/error, hibernation restoration. Owns `WsAttachment` type.
3. **`createAutoSaveTracker`**: `lastSavedSv` state + dedup comparison. Wired as `onAllDisconnected` callback.

### Impact on DO files

| File | Before | After | Reduction |
|------|--------|-------|-----------|
| `workspace-room.ts` | 329 lines | ~160 lines | ~51% |
| `document-room.ts` | 428 lines | ~260 lines | ~39% |

Both DOs are now thin shells: constructor wires factories, `sync()` and `getDoc()` stay inline (too small to extract), WebSocket callbacks delegate to `hub.dispatch/close/error`.

### What was NOT changed
- `sync-handlers.ts`: untouched as specified
- `app.ts` routes: no interface changes
- Public RPC methods (sync, getDoc, snapshots): identical signatures

### Test changes
- `sync-handlers.test.ts` updated from old `WsMessageResult` API (`result.data!.response`, `.broadcast`, `.awarenessChanged`) to new `SyncEffect[]` API (`result.data!.find(e => e.type === 'respond')`, etc.)
- 22/22 tests pass

### Pre-existing issues noted
- `@epicenter/ai` has 2 unrelated type errors (`NumberKeysOf` not found, index type error in `workspace/types.ts`). Not caused by this change.
