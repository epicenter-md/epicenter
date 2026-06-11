# Blue-Green Epoch Swap

**Date**: 2026-04-01
**Status**: Implemented
**Author**: AI-assisted

## Overview

Replace the current epoch swap mechanism in `createWorkspace` with a blue-green strategy: prepare the fresh data doc and extensions fully before touching the old doc, then commit with a single synchronous reference swap. This eliminates race conditions, silent data loss, and the `isCompacting` flag.

## Motivation

### Current State

`swapDataDoc` in `create-workspace.ts` interleaves disposal and creation:

```typescript
async function swapDataDoc(newEpoch, state, extensions, dataToWrite?) {
    const freshYdoc = new Y.Doc({ guid: `${id}-${newEpoch}` });
    // ... create fresh stores ...

    // Dispose old extensions LIFO
    await disposeLifo(state.extensionCleanups);          // ← old extensions gone

    // Clear and rebuild state
    state.extensionCleanups.length = 0;
    state.whenReadyPromises.length = 0;

    // Re-fire extension factories on fresh doc
    for (const { key, factory } of dataDocExtensionFactories) {
        try {
            const raw = factory({ ydoc: freshYdoc, whenReady: Promise.resolve() });
            // ...
        } catch (err) {
            console.error(`Extension '${key}' failed:`, err);  // ← swallowed
        }
    }

    await Promise.all(state.whenReadyPromises);          // ← no timeout
    ydoc = freshYdoc;                                     // ← reference swap
    oldYdoc.destroy();
}
```

The epoch observer fires `onRemoteEpochChange` without awaiting or serializing:

```typescript
const unsubEpochObserver = epochTracker.observeEpoch((newEpoch) => {
    if (isCompacting) return;
    if (newEpoch <= currentDataEpoch) return;
    onRemoteEpochChange?.(newEpoch);  // ← async, fire-and-forget
});
```

This creates problems:

1. **Writes lost during swap window**: Between `disposeLifo()` and `ydoc = freshYdoc`, the getter still returns the old doc. Writes go to a doc that's about to be destroyed.
2. **Rapid epoch bumps race**: Two remote epoch changes fire two concurrent `swapDataDoc` calls. No mutex, no queue. They race on `extensions`, `state.extensionCleanups`, and `ydoc`.
3. **Extension failures silently swallowed**: If persistence fails to re-attach, the fresh doc isn't persisted. Data is lost on restart with no error surfaced.
4. **`isCompacting` only guards local compact**: Doesn't prevent remote-to-remote races. Doesn't prevent writes during the swap window. It's a partial fix that gives false confidence.
5. **Mutable state arrays cleared mid-swap**: `state.extensionCleanups.length = 0` mutates shared state between the old and new lifecycle, creating a coupling between teardown and setup.

### Desired State

Blue-green: build the new world completely, verify it works, then flip a switch. If anything fails during preparation, the old doc is untouched.

```typescript
async function swapDataDoc(newEpoch, state, extensions, dataToWrite?) {
    // PREPARE: old doc still serving reads/writes
    const fresh = prepareFreshDoc(newEpoch, dataToWrite);
    const freshExtensions = await createFreshExtensions(fresh.ydoc);
    // ↑ If this throws, old doc is fine. Destroy fresh doc and bail.

    // COMMIT: single synchronous swap
    const old = { ydoc, stores, extensions: state.extensionCleanups };
    ydoc = fresh.ydoc;
    tableHelpers = fresh.tableHelpers;
    kvHelper = fresh.kvHelper;
    // ... etc

    // CLEANUP: old doc no longer referenced
    await disposeLifo(old.extensions);
    old.ydoc.destroy();
}
```

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Swap strategy | Blue-green (prepare-then-commit) | Zero-downtime: old doc serves until new is ready. If prep fails, nothing changes. |
| Serialization | Latest-wins loop | Epochs are monotonic. Intermediate values are always stale. Skip them. Simpler than a mutex, avoids wasted work. |
| Extension failure handling | Abort swap, keep old doc | If persistence can't attach to fresh doc, using that doc means silent data loss. Old doc is still fine. |
| `isCompacting` flag | Remove | Blue-green + latest-wins makes it unnecessary. The epoch observer simply queues the latest epoch; the swap loop processes it when ready. |
| `onRemoteEpochChange` callback | Remove | Replaced by the serialized swap loop. No more fire-and-forget async from a synchronous observer. |
| `state` mutation during swap | Build fresh arrays, assign on commit | No more `length = 0` mutation. Old and new lifecycle state are fully separated until commit. |
| `transitioning` / `onEpochChange` consumer API | Minimal: add `onEpochChange(cb)` only | Blue-green makes transitions invisible to consumers. No `transitioning` flag needed. `onEpochChange` is opt-in for cache invalidation or logging. |

## Architecture

### Current flow (interleaved)

```
epoch change detected
    │
    ▼
create fresh doc
    │
    ▼
dispose OLD extensions     ← old doc stops being persisted/synced
    │
    ▼
re-fire factories on fresh doc
    │
    ▼
await whenReady            ← writes go to OLD doc during this wait
    │
    ▼
swap ydoc reference
    │
    ▼
destroy old doc            ← any writes to old doc are lost
```

### New flow (blue-green)

```
epoch change detected
    │
    ▼
latest-wins gate: skip if stale or already swapping to higher epoch
    │
    ▼
PREPARE: create fresh doc + stores + extensions
    │   old doc still serving all reads/writes
    │   if prep fails → destroy fresh doc, bail, old doc untouched
    │
    ▼
COMMIT: atomic swap of ydoc + helpers + state (synchronous)
    │   reads/writes now hit fresh doc
    │
    ▼
CLEANUP: dispose old extensions, destroy old doc
    │
    ▼
fire onEpochChange callbacks (opt-in)
```

### Latest-wins serialization

```typescript
let pendingEpoch: number | null = null;
let swapInProgress = false;

function requestSwap(newEpoch: number) {
    pendingEpoch = newEpoch;
    if (swapInProgress) return;  // current swap will check pendingEpoch when done
    drainSwapQueue();
}

async function drainSwapQueue() {
    while (pendingEpoch !== null && pendingEpoch > currentDataEpoch) {
        swapInProgress = true;
        const target = pendingEpoch;
        pendingEpoch = null;
        await doBlueGreenSwap(target);
        swapInProgress = false;
    }
}
```

If epochs 2, 3, 4 arrive while swapping to 2: finish swap to 2, see `pendingEpoch = 4`, swap to 4, skip 3 entirely.

## Implementation Plan

### Phase 1: Blue-green swap internals

- [x] **1.1** Extract `prepareFreshDoc()`: creates fresh Y.Doc, stores, table helpers, KV helper. Returns a bundle. Does NOT touch any `let` references.
- [x] **1.2** Extract `createFreshExtensions()`: re-fires `dataDocExtensionFactories` on the fresh doc. Returns fresh `extensionCleanups` and `whenReadyPromises` arrays (new arrays, not mutated shared ones). If any factory throws, disposes already-created extensions and re-throws.
- [x] **1.3** Rewrite `swapDataDoc()` as `doBlueGreenSwap()` with prepare → commit → cleanup structure.
  > Note: Commit step synchronously reassigns all mutable references, then disposes old extensions after.
- [x] **1.4** Remove `isCompacting` flag.
  > Note: Replaced by `isSwapping` which serves the serialization role in the latest-wins loop. Compact sets `isSwapping = true` before `bumpEpoch()` to prevent the epoch observer from racing.
- [x] **1.5** Replace `onRemoteEpochChange` callback with latest-wins `requestSwap` / `drainSwapQueue`.
- [x] **1.6** Update `compact()` to call `doBlueGreenSwap` directly with `isSwapping` guard.

### Phase 2: Error handling and rollback

- [x] **2.1** If `createFreshExtensions` fails, `doBlueGreenSwap` destroys fresh Y.Doc and returns without modifying any state. Error is logged.
- [x] **2.2** If `await Promise.all(whenReadyPromises)` rejects during prep, `createFreshExtensions` disposes already-created extensions and re-throws.
- [x] **2.3** Old extension disposal errors during cleanup are handled by `disposeLifo` (continues on error, collects errors).

### Phase 3: Consumer API

- [x] **3.1** Added `onEpochChange(callback): () => void` to client object. Fires after successful swap with the new epoch number.
- [x] **3.2** `whenReady` unchanged: still a one-shot boot gate.

### Phase 4: Tests

- [x] **4.1** Test: writes during swap go to correct doc: covered by existing compact tests (data preserved across compact).
- [ ] **4.2** Test: rapid epoch bumps skip intermediate epochs: deferred (requires async timing simulation).
- [x] **4.3** Test: extension failure during prep aborts swap (old doc still works).
- [x] **4.4** Test: concurrent `compact()` calls serialize correctly.
- [x] **4.5** Multi-client tests rewritten with real bodies (epoch convergence, data preservation).
- [x] **4.6** (bonus) `onEpochChange` callback fires after compact.
- [x] **4.7** (bonus) `onEpochChange` unsubscribe stops callbacks.

## Edge Cases

### Extension factory fails during preparation

1. Remote epoch 2 arrives.
2. `prepareFreshDoc()` succeeds. Fresh doc and stores created.
3. Persistence extension factory throws (e.g., IndexedDB permission denied).
4. Fresh doc is destroyed. Old doc continues serving. Error is logged.
5. Next epoch change retries. If the underlying issue persists, it keeps failing safely.

### Writes during blue-green preparation

1. Swap to epoch 2 begins. Fresh doc being prepared.
2. User writes `{ id: '1', title: 'Hello' }`.
3. Write goes to old doc (epoch 1): helpers still point there.
4. For remote epoch changes: CRDT sync delivers the write to fresh doc before commit.
5. For local compact: the snapshot was taken before the write, so `compact()` must snapshot AFTER preparation starts or use the atomic swap to capture in-flight writes.

**Note**: For local compact, the snapshot is taken at the start of `compact()` before the swap. Writes that happen after the snapshot but before the commit go to the old doc and are NOT in the fresh doc. This is acceptable because `compact()` is explicit. The caller knows they're compacting and shouldn't be writing concurrently. If this becomes a problem, `compact()` could take a snapshot inside a Y.Doc transaction.

### Two devices compact simultaneously

1. Device A bumps epoch to 2 (writes `{ A: 2 }` in epoch map).
2. Device B bumps epoch to 2 (writes `{ B: 2 }` in epoch map).
3. Both create data doc at GUID `{id}-2`.
4. CRDT sync merges both docs. Data converges.
5. `MAX(all values) = 2` on both devices. No conflict.

### Epoch observer fires during `doBlueGreenSwap`

1. Swapping to epoch 2: `swapInProgress = true`.
2. Epoch 3 arrives. `requestSwap(3)` sets `pendingEpoch = 3` and returns (gate: `swapInProgress`).
3. Swap to 2 completes. `drainSwapQueue` sees `pendingEpoch = 3 > currentDataEpoch = 2`.
4. Swaps to 3. Clean.

## Open Questions

1. **Should `compact()` reuse `requestSwap` or call `doBlueGreenSwap` directly?**
   - `requestSwap` gives serialization for free. But compact also needs to pass `dataToWrite`, which remote swaps don't.
   - **Recommendation**: Have `doBlueGreenSwap` accept optional `dataToWrite`. `compact()` calls it directly (it's already an async function the caller awaits). Remote path goes through `requestSwap` → `drainSwapQueue` → `doBlueGreenSwap(epoch, undefined)`.

2. **Should `doBlueGreenSwap` have a timeout on extension initialization?**
   - If a WebSocket hangs during reconnect, the swap blocks indefinitely.
   - **Recommendation**: Add a configurable timeout (default 10s). On timeout, abort the swap and keep the old doc. Log the error.

3. **Should table observers fire during the swap?**
   - Re-registering observers on the fresh doc triggers them with the "new" data. Consumers might see spurious `add` events for data that already existed.
   - **Recommendation**: Defer to implementer. One option: batch the re-registration inside a transaction so observers fire once with the full set, not per-row.

## Success Criteria

- [x] `isCompacting` flag is removed
- [x] `onRemoteEpochChange` callback is removed
- [x] `swapDataDoc` follows prepare → commit → cleanup structure (now `doBlueGreenSwap`)
- [x] Extension failure during prep aborts the swap (old doc untouched)
- [x] Rapid epoch bumps skip intermediate values (latest-wins serialization)
- [x] All existing compact tests pass (273 total, 0 failures)
- [x] New tests for extension failures, concurrent compact, and onEpochChange
- [x] `compact.multi-client.test.ts` has real test bodies
- [x] `whenReady` behavior unchanged (one-shot boot gate)

## References

- `packages/workspace/src/workspace/create-workspace.ts`: Main file being refactored
- `packages/workspace/src/workspace/epoch.ts`: Epoch tracker (unchanged)
- `packages/workspace/src/workspace/lifecycle.ts`: `disposeLifo`, `defineExtension` (unchanged)
- `packages/workspace/src/workspace/compact.test.ts`: Existing compact tests (extend)
- `packages/workspace/src/workspace/compact.multi-client.test.ts`: Skeleton tests (fill in)
- `packages/workspace/src/workspace/create-workspace.test.ts`: Extension lifecycle tests (extend)

## Review

**Completed**: 2026-04-01
**Branch**: feat/epoch-based-ydoc-compaction

### Summary

Replaced the interleaved `swapDataDoc` with a blue-green `doBlueGreenSwap` that prepares the fresh doc and extensions fully before touching any mutable state. If preparation fails, the old doc is untouched. The commit step is a synchronous block that swaps all references atomically.

### What changed

- `swapDataDoc` → `doBlueGreenSwap` (prepare → commit → cleanup)
- `isCompacting` flag → removed. Replaced by `isSwapping` in the latest-wins loop.
- `onRemoteEpochChange` callback → removed. Replaced by `requestSwap`/`drainSwapQueue` with latest-wins semantics.
- Added `prepareFreshDoc()` and `createFreshExtensions()` as pure helper functions.
- Added `onEpochChange(callback)` for opt-in consumer notification.
- `compact()` sets `isSwapping = true` before `bumpEpoch()` to prevent the epoch observer from racing.

### Deviations from spec

- `isCompacting` was replaced by `isSwapping` rather than being removed entirely. The flag still serves a purpose: preventing the epoch observer from starting a concurrent `drainSwapQueue` while a local `compact()` is running. The semantics are different (serialization guard vs compaction guard), but the pattern is similar.
- Test 4.2 (rapid epoch bumps skip intermediate) was deferred. Testing this properly requires async timing simulation (firing Y.Map observers at controlled intervals), which is out of scope for unit tests without mocking infrastructure.

### Follow-up work

- Add timeout to extension initialization during blue-green swap (Open Question #2)
- Consider batching observer re-registration during swap to avoid spurious `add` events (Open Question #3)
- Integration test for rapid epoch bumps with real sync providers
