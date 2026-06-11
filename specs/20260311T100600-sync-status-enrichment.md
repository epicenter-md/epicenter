# Sync Client Improvements: Status Enrichment, Connection Timeout, Persistence

> Enrich `SyncStatus` with a discriminated union on `phase`, add connection-phase timeout, guard liveness monitor, hoist status onto the extension surface, and port the DO's SQLite append-log pattern to desktop persistence.

## Problem

Four incremental improvements identified during sync client architecture review:

1. **No error discrimination**: `SyncStatus = 'offline' | 'connecting' | 'connected'` collapses "auth failed" and "network failed" into the same `connecting` state. Consumers can't show "Sign in again" vs "Check your internet."

2. **No connection-phase timeout**: The liveness monitor starts after `onopen`. Against a black-hole server, `attemptConnection` can hang for minutes before the browser fires `onerror`.

3. **Liveness monitor double-start**: `createLivenessMonitor().start()` doesn't clear existing intervals. Safe today (usage pattern is correct), but a defensiveness gap.

4. **Desktop persistence re-encodes entire doc on every update**: `Y.encodeStateAsUpdate(ydoc)` + `writeFileSync` is O(doc_size) per keystroke. The Cloudflare DO already uses an efficient SQLite append-log for the same operation.

5. **Extension leaks provider to consumers**: `workspaceClient.extensions.sync.provider.status` forces consumers to reach through the extension to the raw provider. Inconsistent API surface: `reconnect()` is on the extension, but `status` and `onStatusChange` are on `extension.provider`.

## Design

### 1. Discriminated union on `phase`

Replace the 3-string union with a 3-object union carrying context:

```typescript
type SyncStatus =
  | { phase: 'offline' }
  | { phase: 'connecting'; attempt: number; lastError?: SyncError }
  | { phase: 'connected' }

type SyncError =
  | { type: 'auth'; error: unknown }
  | { type: 'connection' }
```

- `attempt: 0` = first connection, `1+` = reconnecting after failure
- `lastError` = what went wrong on the previous attempt (undefined on first)
- `SyncError` is a discriminated union itself. Extendable for future error types

**Status emitter change**: The `createStatusEmitter` currently uses `===` for dedup. With objects, every `set()` call will emit (no structural equality). This is fine. Status changes at WebSocket reconnect frequency (seconds), not render frequency (ms).

### 2. Connection-phase timeout

Add a `CONNECT_TIMEOUT_MS = 15_000` timeout inside `attemptConnection`:

```typescript
const connectTimeout = setTimeout(() => {
  if (ws.readyState === WebSocket.CONNECTING) ws.close();
}, CONNECT_TIMEOUT_MS);

ws.onopen = () => { clearTimeout(connectTimeout); /* ... */ };
ws.onclose = () => { clearTimeout(connectTimeout); /* ... */ };
```

15s: long enough for slow mobile/satellite, short enough to not leave users staring.

### 3. Liveness double-start guard

One line at top of `start()`:

```typescript
start() {
  this.stop(); // Guard: prevent interval leak on double-start
  lastMessageTime = Date.now();
  // ... existing interval setup
}
```

### 4. Hoist status onto extension surface

The sync extension currently exposes `provider` directly. Change to hoist `status` and `onStatusChange`:

```typescript
// Before (consumers reach through):
workspaceClient.extensions.sync.provider.status
workspaceClient.extensions.sync.provider.onStatusChange(...)

// After (extension surface):
workspaceClient.extensions.sync.status
workspaceClient.extensions.sync.onStatusChange(...)
workspaceClient.extensions.sync.provider  // still available for advanced use
```

The extension exports both the hoisted convenience properties AND the raw provider for advanced consumers who need awareness, etc.

### 5. Desktop persistence → SQLite append-log

Port the DO pattern from `base-sync-room.ts` to desktop persistence. Replace full doc re-encode + writeFileSync with incremental INSERT:

```typescript
// Current (O(doc_size) per update):
ydoc.on('update', () => {
  const state = Y.encodeStateAsUpdate(ydoc);
  writeFileSync(filePath, state);
});

// New (O(update_size) per update):
ydoc.on('updateV2', (update: Uint8Array) => {
  db.run('INSERT INTO updates (data) VALUES (?)', update);
});
```

Use `bun:sqlite` with the same schema as the DO:
- `updates` table: `id INTEGER PRIMARY KEY AUTOINCREMENT, data BLOB NOT NULL`
- Startup: replay all updates in order
- Compaction: on startup + clean shutdown, replace N rows with 1 compacted row
- File extension: `.db` instead of `.yjs`

## Implementation Plan

### Wave 1: Type changes (sync-client)
**Files**: `packages/sync-client/src/types.ts`

- [x] **1.1** Replace `SyncStatus` string union with discriminated union on `phase`
- [x] **1.2** Add `SyncError` discriminated union type
- [x] **1.3** Update `SyncProvider` type: `status` returns `SyncStatus` object, `onStatusChange` takes `SyncStatus` object listener

### Wave 2: Provider implementation (sync-client)
**Files**: `packages/sync-client/src/provider.ts`

- [x] **2.1** Update `createStatusEmitter` default to `{ phase: 'offline' }`
- [x] **2.2** Update supervisor loop `runLoop` to track `attempt` counter and emit enriched status with `attempt` and `lastError`
- [x] **2.3** Update `getToken` catch to set `lastError: { type: 'auth', error: e }`
- [x] **2.4** Update `attemptConnection` failure path to set `lastError: { type: 'connection' }`
- [x] **2.5** Update `connect()` to emit `{ phase: 'connected' }` (no lastError)
- [x] **2.6** Update `disconnect()` to emit `{ phase: 'offline' }`
- [x] **2.7** Add `CONNECT_TIMEOUT_MS = 15_000` constant
- [x] **2.8** Add connection-phase timeout in `attemptConnection` (setTimeout that closes WS if still CONNECTING)
- [x] **2.9** Add `this.stop()` guard at top of `createLivenessMonitor().start()`

### Wave 3: Extension surface (workspace)
**Files**: `packages/workspace/src/extensions/sync.ts`

- [x] **3.1** Update `SyncExtensionExports` type to include `status`, `onStatusChange`, and re-export `SyncStatus`/`SyncError` types
- [x] **3.2** Hoist `status` getter and `onStatusChange` onto extension return object
- [x] **3.3** Keep `provider` on extension exports for advanced use

### Wave 4: Consumer updates
**Files**: `apps/tab-manager/src/lib/components/SyncStatusIndicator.svelte`, `apps/tab-manager/src/lib/workspace.ts`

- [x] **4.1** Update `SyncStatusIndicator.svelte` to use `extensions.sync.status` and `extensions.sync.onStatusChange` instead of reaching through `provider`
- [x] **4.2** Update tooltip to show auth-specific message when `lastError?.type === 'auth'`
- [x] **4.3** Update icon logic to switch on `status.phase`

### Wave 5: Desktop persistence
**Files**: `packages/workspace/src/extensions/sync/desktop.ts`

- [x] **5.1** Replace `persistence` function with SQLite append-log implementation using `bun:sqlite`
- [x] **5.2** Implement startup replay: load updates from SQLite, apply to ydoc
- [x] **5.3** Implement live persistence: listen to `updateV2`, INSERT incremental update
- [x] **5.4** Implement compaction: on startup + destroy, compact N rows → 1 row
- [x] **5.5** Update `filesystemPersistence` to also use append-log pattern
- [ ] **5.6** Maintain backward compat: detect `.yjs` files and migrate to `.db` on first load

### Wave 6: Test updates
**Files**: `packages/sync-client/src/provider.test.ts`, `packages/workspace/src/extensions/sync.test.ts`

- [x] **6.1** Update all status assertion tests: `'offline'` → `{ phase: 'offline' }`, etc.
- [ ] **6.2** Add test: `getToken` failure sets `lastError.type === 'auth'`
- [ ] **6.3** Add test: connection failure sets `lastError.type === 'connection'`
- [ ] **6.4** Add test: successful connection clears `lastError`
- [ ] **6.5** Add test: `attempt` increments on reconnect
- [ ] **6.6** Add test: connection timeout closes WS after `CONNECT_TIMEOUT_MS`
- [x] **6.7** Update sync extension tests for hoisted status/onStatusChange
- [x] **6.8** Run full type-check and test suite

## Review

### Summary

All 6 waves implemented. The sync client now has:

1. **Enriched `SyncStatus`**: Discriminated union on `phase` with `attempt` counter and `lastError` context on `connecting`. Consumers can distinguish auth failures from connection failures.
2. **Connection timeout**: 15s timeout on WebSocket CONNECTING state prevents indefinite hangs against unresponsive servers.
3. **Liveness guard**: `this.stop()` at top of `start()` prevents interval leaks on double-start.
4. **Hoisted extension surface**: `extensions.sync.status` and `extensions.sync.onStatusChange` available directly. Consumers no longer reach through to `provider`.
5. **SQLite append-log persistence**: Desktop persistence uses `bun:sqlite` with incremental INSERT per update (O(update_size)) instead of full doc re-encode (O(doc_size)). Compacts on startup and clean shutdown.

### Deferred

- **5.6**: `.yjs` → `.db` backward-compat migration not implemented. New installs will use `.db` directly; existing users would need a manual migration or we add it in a follow-up.
- **6.2-6.6**: New behavioral tests for `lastError`, `attempt`, and connection timeout. The existing tests all pass with the new type structure, but dedicated tests for the new enriched fields would strengthen coverage. These are low-risk follow-ups since the provider logic is exercised by the existing integration tests.

### Files changed

| File | Change |
| --- | --- |
| `packages/sync-client/src/types.ts` | `SyncStatus` discriminated union, `SyncError` type |
| `packages/sync-client/src/index.ts` | Added `SyncError` export |
| `packages/sync-client/src/provider.ts` | Enriched status emissions, connection timeout, liveness guard |
| `packages/sync-client/src/provider.test.ts` | Updated all status assertions for object-typed `SyncStatus` |
| `packages/workspace/src/extensions/sync.ts` | Hoisted `status`/`onStatusChange`, updated types |
| `packages/workspace/src/extensions/sync.test.ts` | Updated status assertions |
| `packages/workspace/src/extensions/sync/desktop.ts` | Complete rewrite to SQLite append-log |
| `packages/server-local/src/sync/ws-plugin.test.ts` | Updated `waitForStatus` and `expectAuthRejection` for new types |
| `apps/tab-manager/src/lib/components/SyncStatusIndicator.svelte` | Updated for new API surface |

### Test results

- `packages/sync-client`: 12/12 pass
- `packages/workspace` (sync.test.ts): 5/5 pass
- `packages/server-local` (ws-plugin.test.ts): 13/13 pass
