# Inline Connection Hub into BaseSyncRoom

## Problem

`createConnectionHub` is a factory function inside `base-sync-room.ts` that wraps WebSocket lifecycle logic. Every method is called from exactly one place in `BaseSyncRoom`. It doesn't earn its abstraction:

- **Single consumer**: every method has 1 call site
- **Two-phase init smell**: `hub!` definite assignment exists because the hub needs `doc`/`awareness` from `blockConcurrencyWhile` AND `onAllDisconnected` from the subclass. Subclasses must remember to call `initHub()` with no compile-time enforcement.
- **Extra indirection**: `webSocketMessage()` → `hub.dispatch()` → `handleWsMessage()` is one hop too many when the DO _is_ the coordination point.
- **`onAllDisconnected` callback is over-engineered**: only `DocumentRoom` uses it. A protected method override is simpler.

## What stays untouched

- `sync-handlers.ts`: the protocol layer (pure functions returning effects). Correct boundary.
- The effect pattern (`respond`/`broadcast`/`persistAttachment`). Good design.
- Auth in `app.ts`: Better Auth middleware at handshake time. Hub never touched auth.
- `constants.ts`: unchanged.

## Changes

### 1. `base-sync-room.ts`: Inline hub into class

**Remove:**
- `ConnectionHub` type alias
- `createConnectionHub` function (entire ~150 lines)
- `private hub!: ConnectionHub` field
- `protected initHub(options?)` method

**Add to class:**
- `private states = new Map<WebSocket, ConnectionState>()` field (no `!` needed)
- Move `restoreHibernated()` logic to end of `blockConcurrencyWhile` callback
- Private `upgrade(): Response` method (called from `fetch`)
- Inline `dispatch` logic into `webSocketMessage()`
- Inline `close` logic into `webSocketClose()`
- Inline `error` logic into `webSocketError()` (delegates to close with 1011)
- `protected onAllDisconnected(): void {}`: no-op, overridden by DocumentRoom
- `alarm()` uses `this.states.size` instead of `this.hub.size`

**JSDoc updates:**
- Remove `createConnectionHub` JSDoc (function deleted)
- Remove `hub!` field JSDoc (field deleted)
- Remove `initHub()` JSDoc (method deleted)
- Add JSDoc to `webSocketMessage` override (validate size, decode, process effects)
- Add JSDoc to `webSocketClose` override (cleanup, handler deregistration, awareness removal, onAllDisconnected)
- Add JSDoc to `webSocketError` override (error → close with 1011)
- Add JSDoc to `onAllDisconnected` (protected hook for subclass cleanup)
- Add JSDoc to `upgrade` (private: WebSocket pair creation, hibernation API, initial sync messages)
- Update class-level JSDoc to remove `initHub` references
- Preserve `restoreHibernated` logic description as inline comment

### 2. `document-room.ts`: Override `onAllDisconnected`

**Remove:**
- `this.initHub({ onAllDisconnected: ... })` call
- Closure-scoped `lastSavedSv` variable

**Add:**
- `private lastSavedSv: Uint8Array | null = null` class field
- `protected override onAllDisconnected(): void` method with the same logic

### 3. `workspace-room.ts`: Remove `initHub()` call

**Remove:**
- `this.initHub()` call (constructor body becomes empty, just `super()`)

## Todos

- [x] Inline hub state and methods into `BaseSyncRoom`
- [x] Add `protected onAllDisconnected()` no-op method
- [x] Update `webSocketMessage` with inlined dispatch logic + JSDoc
- [x] Update `webSocketClose` with inlined close logic + JSDoc
- [x] Update `webSocketError` with inlined error logic + JSDoc
- [x] Move `restoreHibernated` into `blockConcurrencyWhile`
- [x] Add private `upgrade()` method with JSDoc
- [x] Update `alarm()` to use `this.states.size`
- [x] Update class-level JSDoc (remove hub/initHub references)
- [x] Update `DocumentRoom`: override `onAllDisconnected`, remove `initHub`
- [x] Update `WorkspaceRoom`: remove `initHub` call
- [x] Run diagnostics on all changed files

## Size estimate

- `BaseSyncRoom` class: ~65 lines → ~120 lines (net +55)
- `createConnectionHub` deleted: -150 lines
- File net change: ~-95 lines
- `DocumentRoom`: ~+10 lines (method override replaces initHub call)
- `WorkspaceRoom`: -1 line

## Review

### What changed

**`base-sync-room.ts`** (523 → 371 lines, **-152 lines**)
- Deleted `createConnectionHub` factory function and `ConnectionHub` type alias
- Deleted `private hub!` field and `protected initHub()` method (two-phase init eliminated)
- Added `private states = new Map<WebSocket, ConnectionState>()` as a class field
- Moved `restoreHibernated` logic to end of `blockConcurrencyWhile` callback (inline comment explains what it does)
- Added `private upgrade(): Response` method with JSDoc
- Inlined dispatch logic into `webSocketMessage()` with full JSDoc (size validation, binary conversion, effect processing)
- Inlined close logic into `webSocketClose()` with full JSDoc (handler deregistration, awareness removal, compaction scheduling)
- `webSocketError()` now calls `this.webSocketClose(ws, 1011, 'WebSocket error', false)` instead of `this.hub.error(ws)`: same cleanup path
- Added `protected onAllDisconnected(): void {}` no-op: subclasses override instead of passing callbacks
- `alarm()` reads `this.states.size` directly
- Updated class-level JSDoc: `initHub` reference replaced with `onAllDisconnected` override pattern
- Updated module-level JSDoc: removed `createConnectionHub` from module structure list

**`document-room.ts`** (minor)
- Removed `this.initHub({ onAllDisconnected: ... })` call from constructor
- Promoted closure-scoped `lastSavedSv` to `private lastSavedSv: Uint8Array | null = null` class field
- Added `protected override onAllDisconnected(): void` method with identical logic

**`workspace-room.ts`** (1 line)
- Removed `this.initHub()` call. Constructor body is now just `super()`.

### What stayed the same
- `sync-handlers.ts`: untouched. Pure functions returning effects. Correct boundary.
- Effect pattern (`respond`/`broadcast`/`persistAttachment`): preserved exactly.
- `constants.ts`: untouched.
- `app.ts`: untouched. Auth guard stays at the Worker boundary.
- All existing behavior preserved: hibernation restoration, compaction alarm scheduling, awareness cleanup.

### Verification
- LSP diagnostics: 0 errors on all 3 changed files
- `tsc --noEmit`: passes (via `bun typecheck --filter=@epicenter/server-remote`)
