# Alarm-Based Compaction for Durable Object Sync Rooms

**Date**: 2026-03-11
**Status**: Implemented
**Author**: AI-assisted

## Overview

Add alarm-based compaction to `BaseSyncRoom` so the SQLite update log is compacted when the last WebSocket client disconnects (not just on cold start), and switch the compaction encoding from `Y.mergeUpdatesV2` to `Y.encodeStateAsUpdateV2` for smaller, faster output.

## Motivation

### Current State

Compaction runs only during cold start, inside `blockConcurrencyWhile`. It uses `Y.mergeUpdatesV2` to merge all rows, then replaces them with a single compacted row:

```typescript
// base-sync-room.ts: constructor, inside blockConcurrencyWhile
const rows = ctx.storage.sql
  .exec('SELECT data FROM updates ORDER BY id')
  .toArray();

if (rows.length > 0) {
  const merged = Y.mergeUpdatesV2(
    rows.map((r) => new Uint8Array(r.data as ArrayBuffer)),
  );
  Y.applyUpdateV2(this.doc, merged);

  if (rows.length > 1 && merged.byteLength <= MAX_COMPACTED_BYTES) {
    ctx.storage.transactionSync(() => {
      ctx.storage.sql.exec('DELETE FROM updates');
      ctx.storage.sql.exec(
        'INSERT INTO updates (data) VALUES (?)',
        merged,
      );
    });
  }
}
```

When the last WebSocket disconnects, the hub fires `onAllDisconnected` but performs no compaction:

```typescript
// base-sync-room.ts: createConnectionHub.close()
close(ws: WebSocket, code: number, reason: string) {
  const state = states.get(ws);
  if (!state) return;

  handleWsClose(state);
  states.delete(ws);

  swallow(() => ws.close(code, reason));

  if (states.size === 0) {
    onAllDisconnected?.();
  }
},
```

`BaseSyncRoom` has no `alarm()` override. The Cloudflare Alarm API is unused.

This creates problems:

1. **Unbounded update log growth**: A DO with long-lived WebSocket connections accumulates one SQLite row per keystroke. The log grows without bound until the next cold start.
2. **Progressively slower cold starts**: Each cold start reads and merges all accumulated rows. A DO that was active for hours could have tens of thousands of rows.
3. **Suboptimal compaction encoding**: `Y.mergeUpdatesV2` preserves deleted item data as full `Item` structs (content, parent pointers, origins) instead of lightweight `GC` structs. It also has a documented exponential performance edge case for many updates (yjs#710).

### Desired State

When the last WebSocket disconnects, schedule a DO alarm 30 seconds later. When the alarm fires, compact the update log using `Y.encodeStateAsUpdateV2(doc)`. If a client reconnects before the alarm fires, cancel it. Cold-start compaction switches to the same encoding.

## Research Findings

### Cloudflare Durable Objects Hibernation Lifecycle

| Aspect | Behavior |
|---|---|
| Hibernation trigger | Idle 10-60s with Hibernation WebSocket API (`ctx.acceptWebSocket`) |
| After all WS close | DO remains in memory ~60s before eviction |
| "About to hibernate" hook | Does not exist |
| State lost on hibernation | All JS variables (including `this.doc`); only `ctx.storage` and WS attachments (2KB each) survive |
| Alarm API | `ctx.storage.setAlarm(date)` persists across hibernation and eviction; one alarm per DO at a time |
| Constructor on wake | Re-runs including `blockConcurrencyWhile` |

**Key finding**: There is no pre-hibernation callback. The only way to run deferred logic after all clients leave is to schedule an alarm.

**Implication**: A 30-second alarm delay is the right mechanism: long enough to skip reconnect storms (user refresh, network blip), short enough to fire before the ~60s eviction window.

### Comparison with y-durableobjects

Source: Direct analysis of [napolab/y-durableobjects](https://github.com/napolab/y-durableobjects), commit `e6d6d06`.

| Feature | Our implementation | y-durableobjects |
|---|---|---|
| Storage | DO SQLite (row-per-update) | DO KV (key-per-update) |
| Encoding | V2 | V1 only |
| Max doc size | 2 MB per compacted row | 128 KB (hard KV limit) |
| Compaction trigger | Cold-start only (current) | Threshold (10KB or 500 updates) + last disconnect |
| Compaction method | `Y.mergeUpdatesV2(rows)` (current) | `Y.encodeStateAsUpdate(doc)` |
| Alarm usage | None (current) | None |

**Key finding**: y-durableobjects already compacts on last disconnect (what we're adding) and uses `encodeStateAsUpdate(doc)` (what we're switching to). Their 128KB KV limit is a hard constraint we don't have with SQLite.

**Implication**: Our approach aligns with the only other known DO-based Yjs implementation. We improve on it with V2 encoding, SQLite storage, and alarm-based deferral instead of inline compaction on disconnect.

### `mergeUpdatesV2` vs `encodeStateAsUpdateV2` for Compaction

Sources: Yjs source (`src/utils/updates.js#L331`, `src/utils/encoding.js#L500`), yjs#710.

| Dimension | `mergeUpdatesV2` | `encodeStateAsUpdateV2` |
|---|---|---|
| Approach | Log-level merge: decode to `BlockSet` + `DeleteSet`, re-encode | State-level encode: iterate Doc's `StructStore` |
| Deleted items (`gc: true`) | Preserved as full `Item` structs | Converted to lightweight `GC` structs (ID + length only) |
| Deleted items (`gc: false`) | Preserved as full `Item` structs | Preserved (no GC), but better struct merging |
| Many-update performance | Exponential edge case (yjs#710) | Linear: apply each update, encode once |
| Yjs author recommendation | Avoid for batch operations | Recommended: `doc.transact(() => updates.forEach(u => applyUpdate(doc, u)))` |
| State equivalence | Guaranteed (CRDT) | Guaranteed (CRDT) |

**Key finding**: `encodeStateAsUpdateV2` produces equal or smaller output in all cases. With `gc: true` (WorkspaceRoom), deleted items become lightweight `GC` structs. With `gc: false` (DocumentRoom), deleted content is preserved but struct merging is more thorough. Both avoid the exponential edge case.

**Implication**: Switch both cold-start and alarm compaction to: apply updates individually to the Y.Doc, then `Y.encodeStateAsUpdateV2(doc)`.

### V2 Encoding Validation

V2 uses specialized encoders (`IntDiffOptRleEncoder`, `UintOptRleEncoder`) that compress CRDT metadata 10-20x better than V1. Real-world: ~9MB (V1) to ~450KB (V2) for large documents (yjs#675). V1 and V2 are not wire-compatible. Our codebase uses V2 consistently throughout `sync-handlers.ts` and all RPC methods, no changes needed.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Alarm delay | 30 seconds | Long enough to skip reconnect storms, short enough to fire before DO eviction (~60s) |
| Fire-and-forget alarm scheduling | `void ctx.storage.setAlarm(...)` | `setAlarm`/`deleteAlarm` are effectively synchronous in DO SQLite; Promise is API surface only |
| Compaction in alarm, not inline | Deferred to alarm handler | Avoids CPU spike during disconnect; cancellable if client reconnects |
| `encodeStateAsUpdateV2` over `mergeUpdatesV2` | Doc-level encoding | Smaller output (GC structs with `gc: true`, better struct merging with `gc: false`), avoids exponential edge case (yjs#710), Yjs author recommended |
| No subclass changes | Base class owns alarm lifecycle | Both WorkspaceRoom and DocumentRoom benefit automatically; DocumentRoom's `onAllDisconnected` auto-snapshot is orthogonal |
| No update count threshold | Deferred | Alarm + cold-start covers the main cases; threshold needs a persistent counter that resets on hibernation |

## Architecture

### Disconnect → Alarm → Compact Flow

```
  Last client disconnects
          │
          ▼
    hub.close(ws)
          │
          ├── states.delete(ws)
          │
          └── states.size === 0?
                  │
          YES ◀──┤──▶ NO (noop)
                  │
                  ▼
       onAllDisconnected()          ◀── DocumentRoom auto-snapshot fires here
                  │
                  ▼
       setAlarm(now + 30s)          ◀── NEW: schedule compaction
                  │
                  │
     ┌────────────┼────────────┐
     │            │            │
  Client       No client    DO evicted
  reconnects   reconnects   before alarm
     │            │            │
     ▼            ▼            ▼
  upgrade()    alarm()      alarm() wakes DO
     │            │            │
     ▼            │            ▼
  deleteAlarm()   │       constructor re-runs
  (cancelled)     │       cold-start compacts
                  │       alarm finds 1 row → noop
                  ▼
          Read update rows
                  │
          rows ≤ 1? → noop
                  │
                  ▼
          Apply each row to doc
          encodeStateAsUpdateV2(doc)
                  │
          size ≤ 2MB? → replace all rows
          size > 2MB? → skip
```

### Cold-Start Flow (Updated Encoding)

```
  DO wakes (alarm, fetch, or WebSocket)
          │
          ▼
    constructor → blockConcurrencyWhile
          │
          ├── CREATE TABLE IF NOT EXISTS updates
          ├── SELECT all rows
          ├── for (row of rows) Y.applyUpdateV2(doc, row)    ◀── CHANGED from mergeUpdatesV2
          ├── compacted = Y.encodeStateAsUpdateV2(doc)        ◀── CHANGED from merged blob
          └── rows > 1 && size ≤ 2MB? → replace rows with compacted
```

## Implementation Plan

### Phase 1: Switch compaction encoding

- [x] **1.1** Replace `Y.mergeUpdatesV2(rows.map(...))` + `Y.applyUpdateV2(doc, merged)` with a loop: apply each row individually via `Y.applyUpdateV2(doc, row.data)`
- [x] **1.2** Encode the compacted blob from the live doc: `Y.encodeStateAsUpdateV2(this.doc)`
- [x] **1.3** Update the size guard and `transactionSync` to use the new compacted blob
- [x] **1.4** Update the `MAX_COMPACTED_BYTES` JSDoc to reflect the new encoding approach

### Phase 2: Alarm-based compaction on disconnect

- [x] **2.1** Add `COMPACTION_DELAY_MS = 30_000` constant
- [x] **2.2** Schedule alarm in `createConnectionHub.close()` when `states.size === 0` (after `onAllDisconnected`)
- [x] **2.3** Cancel pending alarm in `createConnectionHub.upgrade()` via `void ctx.storage.deleteAlarm()`
- [x] **2.4** Add `alarm()` override to `BaseSyncRoom`: read update log, skip if already compacted (rows <= 1) or clients connected, compact using `encodeStateAsUpdateV2`, replace rows in a transaction
- [x] **2.5** Extract compaction logic into a shared helper (used by both cold-start and alarm paths)

### Phase 3: Verification

- [x] **3.1** `lsp_diagnostics` clean on `base-sync-room.ts`
- [x] **3.2** Build passes
- [x] **3.3** Subclasses (`DocumentRoom`, `WorkspaceRoom`) compile without changes

## Edge Cases

### Alarm fires after DO eviction

1. DO is evicted before the 30s alarm fires
2. Alarm wakes the DO → constructor re-runs → `blockConcurrencyWhile` runs cold-start compaction
3. Cold-start already compacts to 1 row
4. Alarm handler finds 1 row → no-op

Harmless. Double-compaction is idempotent.

### Client reconnects before alarm fires

1. Last client disconnects → alarm scheduled for T+30s
2. Client reconnects at T+10s → `upgrade()` calls `deleteAlarm()`
3. Alarm cancelled. No wasted work.

### Alarm fires while clients are connected

1. Alarm scheduled at T=0 (last disconnect)
2. Client reconnects at T=15s
3. `upgrade()` cancels alarm: but if `deleteAlarm()` races with the alarm firing, the handler could still run
4. Guard: check connection count in `alarm()` and skip. Even without the guard, compaction is safe: `doc.on('updateV2')` continues appending new updates after compaction.

### Document exceeds 2MB compacted

1. Compaction runs (cold-start or alarm)
2. Compacted blob > `MAX_COMPACTED_BYTES` (2 MB)
3. Row replacement skipped (existing behavior preserved)
4. With more frequent alarm-based compaction, reaching 2MB is far less likely: the log stays compact between cold starts.

### Concurrent writes during alarm compaction

Impossible. DO isolate is single-threaded. The `alarm()` handler is synchronous (no awaits between reading rows and writing the compacted row), so no WebSocket messages can interleave.

### DocumentRoom `onAllDisconnected` interaction

1. Last client disconnects
2. `hub.close()` fires `onAllDisconnected` → DocumentRoom's auto-snapshot writes to `snapshots` table (synchronous)
3. Base class schedules alarm for compaction of `updates` table
4. Orthogonal: different tables, different concerns. Ordering is deterministic: snapshot always fires before alarm is scheduled.

## Open Questions

1. **Should we add a threshold-based compaction guard later?**
   - y-durableobjects compacts at 10KB or 500 updates in addition to last-disconnect
   - A threshold would catch long-lived sessions that accumulate thousands of updates without a disconnect cycle
   - **Recommendation**: Defer. Alarm + cold-start covers the primary cases. A threshold requires a persistent update counter, which resets on hibernation (defeating the purpose). Revisit if monitoring shows DOs with sustained long-lived connections and large update logs.

2. **Should `COMPACTION_DELAY_MS` be configurable per room?**
   - WorkspaceRoom (small metadata docs) could use a shorter delay
   - DocumentRoom (large content docs with `gc: false`) might benefit from a longer delay to batch more updates
   - **Recommendation**: Start with a single constant. Make it a `SyncRoomConfig` option only if real-world usage shows different rooms need different values.

3. **Should alarm compaction log metrics?**
   - Row count before/after, byte size before/after, time elapsed
   - Useful for understanding compaction behavior in production
   - **Recommendation**: Add a single `console.log` with row count and compacted size. Structured logging or analytics can come later.

## Success Criteria

- [x] Cold-start compaction uses `encodeStateAsUpdateV2(doc)` instead of `mergeUpdatesV2(rows)`
- [x] Alarm schedules when the last WebSocket client disconnects
- [x] Alarm cancels when a new WebSocket client connects
- [x] `alarm()` handler compacts the update log correctly
- [x] No changes required in `DocumentRoom`, `WorkspaceRoom`, or `sync-handlers.ts`
- [x] `lsp_diagnostics` clean on all changed files
- [x] Build passes

## References

- `packages/server-remote/src/base-sync-room.ts`: primary file, all changes here
- `packages/server-remote/src/document-room.ts`: subclass with `onAllDisconnected` auto-snapshot (`gc: false`)
- `packages/server-remote/src/workspace-room.ts`: bare subclass (`gc: true`)
- `packages/server-remote/src/sync-handlers.ts`: WebSocket protocol handlers, V2 encoding usage throughout
- [yjs#710](https://github.com/yjs/yjs/issues/710): `mergeUpdatesV2` exponential performance edge case
- [yjs#675](https://github.com/yjs/yjs/issues/675): V1 vs V2 encoding size comparison
- [Cloudflare Durable Objects Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/): Alarm API docs
- [y-durableobjects](https://github.com/napolab/y-durableobjects): reference DO-based Yjs implementation
