# Fix Stale Read After Delete in YKeyValue

**Date**: 2026-02-14
**Status**: Complete
**PR**: [#1355](https://github.com/EpicenterHQ/epicenter/pull/1355): Merged 2026-02-14. Added `pendingDeletes` Set to both `YKeyValue` and `YKeyValueLww`. Oracle-reviewed.

## Overview

Add a `pendingDeletes` Set to YKeyValue and YKeyValueLww to fix the stale-read-after-delete bug. This is the symmetric counterpart to the existing `pending` Map that already solves write-then-read for `set()`.

## Problem

### The Bug

When `delete()` is called on a pre-existing key during a batch/transaction, `get()` and `has()` return stale data until the transaction ends:

```typescript
kv.set('foo', 'bar'); // foo exists in map

ydoc.transact(() => {
	kv.delete('foo');
	kv.has('foo'); // TRUE (stale: map not yet updated)
	kv.get('foo'); // 'bar' (stale: returns old value)
});

kv.has('foo'); // FALSE (correct: observer has updated map)
```

### Why This Happens

The single-writer architecture means only the observer updates `map`:

```
delete('foo') during batch:
  │
  ├─► pending.delete('foo')     ← Clears pending (if key was pending)
  │
  └─► yarray.delete(index)      ← Queued, observer deferred until batch ends

has('foo') during batch:
  │
  ├─► pending.has('foo')?       ← FALSE (was cleared by delete)
  │
  └─► map.has('foo')?           ← TRUE (stale! observer hasn't fired yet)
      └─► Returns TRUE ❌
```

The `pending` Map solves this for `set()`: writes go into `pending`, reads check `pending` first. But `delete()` only clears `pending`; it doesn't mark the key as "pending deletion" so reads can skip the stale `map` entry.

### Current Workaround

The limitation is documented in three places:

1. `y-keyvalue-lww.ts`: `delete()` JSDoc (line 503)
2. `y-keyvalue.ts`: `delete()` JSDoc (line 472)
3. `static/types.ts`: `batch()` JSDoc (line 805)

Users are told to track deletions manually if they need accurate reads within a batch.

## Solution

Add `pendingDeletes: Set<string>` to both classes. This mirrors the existing `pending` Map pattern:

| Operation   | `pending` Map (writes)                  | `pendingDeletes` Set (deletes)               |
| ----------- | --------------------------------------- | -------------------------------------------- |
| **Purpose** | Track keys written but not yet in `map` | Track keys deleted but still in `map`        |
| **Writer**  | `set()` adds to `pending`               | `delete()` adds to `pendingDeletes`          |
| **Reader**  | `get()`/`has()` check `pending` first   | `get()`/`has()` check `pendingDeletes` first |
| **Cleanup** | Observer clears from `pending`          | Observer clears from `pendingDeletes`        |

### Data Flow After Fix

```
delete('foo') during batch:
  │
  ├─► pending.delete('foo')           ← Clear pending (if was pending)
  │
  ├─► pendingDeletes.add('foo')       ← NEW: Mark as pending delete
  │
  └─► yarray.delete(index)            ← Queued, observer deferred

has('foo') during batch:
  │
  ├─► pendingDeletes.has('foo')?     ← TRUE
  │   └─► Returns FALSE ✅
  │
  └─► (never reaches map check)

Observer fires after batch:
  │
  ├─► map.delete('foo')               ← Update map
  │
  └─► pendingDeletes.delete('foo')    ← NEW: Clear from pendingDeletes
```

## Implementation Plan

Both YKeyValue and YKeyValueLww need identical changes:

- [ ] **1. Add field**: `private pendingDeletes: Set<string> = new Set();`
- [ ] **2. Update `delete()`**: Add key to `pendingDeletes` after clearing `pending`
- [ ] **3. Update `get()`**: Check `pendingDeletes` before checking `map`: return `undefined` if key is pending delete
- [ ] **4. Update `has()`**: Check `pendingDeletes` before checking `map`: return `false` if key is pending delete
- [ ] **5. Update observer**: Clear processed keys from `pendingDeletes` when they're removed from `map`
- [ ] **6. Update existing tests**: Change stale-read tests (line 669 in y-keyvalue-lww.test.ts, line 707 in y-keyvalue.test.ts) to assert correct (non-stale) behavior
- [ ] **7. Add new tests**: Edge cases for `pendingDeletes` (see Test Plan below)

## Edge Cases

### `delete()` then `set()` same key in same transaction

```typescript
ydoc.transact(() => {
	kv.delete('foo');
	kv.set('foo', 'new');
	kv.get('foo'); // Should return 'new'
});
```

**Solution**: `set()` must clear the key from `pendingDeletes`:

```typescript
set(key: string, val: T): void {
  const entry = { key, val, ts: this.getTimestamp() };

  this.pending.set(key, entry);
  this.pendingDeletes.delete(key);  // NEW: Clear pending delete

  // ... rest of set() logic
}
```

### Double-delete

```typescript
ydoc.transact(() => {
	kv.delete('foo');
	kv.delete('foo'); // Second delete
});
```

**Solution**: Already idempotent. `delete()` checks `map.has(key)` and returns early if not found. The second delete will see `pendingDeletes.has('foo')` is true but `map.has('foo')` is still true (observer hasn't fired), so it will try to delete from yarray again. This is harmless: `deleteEntryByKey()` will find no entry (already deleted) and do nothing.

Actually, we should check `pendingDeletes` in `delete()` to avoid the redundant yarray scan:

```typescript
delete(key: string): void {
  const wasPending = this.pending.delete(key);

  // NEW: If already pending delete, no-op
  if (this.pendingDeletes.has(key)) return;

  if (!this.map.has(key) && !wasPending) return;

  this.pendingDeletes.add(key);  // NEW: Mark as pending delete
  this.deleteEntryByKey(key);
}
```

### `entries()` iterator

The `entries()` method already handles `pending` correctly (yields pending entries, skips keys that are in pending). It needs to also skip keys in `pendingDeletes`:

```typescript
*entries(): IterableIterator<[string, YKeyValueLwwEntry<T>]> {
  const yieldedKeys = new Set<string>();

  // Yield pending entries first
  for (const [key, entry] of this.pending) {
    yieldedKeys.add(key);
    yield [key, entry];
  }

  // Yield map entries that aren't pending and aren't pending delete
  for (const [key, entry] of this.map) {
    if (!yieldedKeys.has(key) && !this.pendingDeletes.has(key)) {  // NEW
      yield [key, entry];
    }
  }
}
```

## Test Plan

### Update existing tests

1. **y-keyvalue-lww.test.ts:669**: Change test name from "known limitation" to "delete during batch: has() returns false immediately". Change assertion from `expect(hasDuringBatch).toBe(true)` to `expect(hasDuringBatch).toBe(false)`.

2. **y-keyvalue.test.ts:707**: Same change as above.

### Add new tests

Add to both `y-keyvalue-lww.test.ts` and `y-keyvalue.test.ts`:

3. **`delete()` then `get()` in batch returns undefined**: Verify `get()` returns undefined after delete in same transaction.

4. **`delete()` then `set()` in batch**: Verify `set()` clears `pendingDeletes` and `get()` returns new value.

5. **Double-delete is idempotent**: Call `delete()` twice on same key in batch, verify no errors and correct final state.

6. **`entries()` skips pending deletes**: Delete a key in batch, verify `entries()` doesn't yield it.

7. **Observer clears `pendingDeletes`**: Verify `pendingDeletes` is empty after transaction ends.

## Documentation Cleanup

Once this ships, remove or update the "Known Limitation" sections in:

- [ ] **`y-keyvalue-lww.ts`**: Remove "Known Limitation" section from `delete()` JSDoc (lines 503-517)
- [ ] **`y-keyvalue.ts`**: Remove "Known Limitation" section from `delete()` JSDoc (lines 472-486)
- [ ] **`static/types.ts`**: Remove "Known Limitation: Stale reads after delete" section from `batch()` JSDoc (lines 805-828)
- [ ] **`specs/20260127T180000-ykeyvalue-transaction-fix.md`**: Update "Known Limitations" section (line 406) to note this is now fixed
- [ ] **`specs/20260214T105600-workspace-level-batch.md`**: Check if it mentions the stale-read limitation (it doesn't appear to based on the read above)

## Files Changed

| File                                                              | Change                                                                                          |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `packages/epicenter/src/shared/y-keyvalue/y-keyvalue-lww.ts`      | Add `pendingDeletes` field, update `delete()`, `get()`, `has()`, `set()`, `entries()`, observer |
| `packages/epicenter/src/shared/y-keyvalue/y-keyvalue.ts`          | Add `pendingDeletes` field, update `delete()`, `get()`, `has()`, `set()`, `entries()`, observer |
| `packages/epicenter/src/shared/y-keyvalue/y-keyvalue-lww.test.ts` | Update existing test, add 5 new tests                                                           |
| `packages/epicenter/src/shared/y-keyvalue/y-keyvalue.test.ts`     | Update existing test, add 5 new tests                                                           |
| `packages/epicenter/src/static/types.ts`                          | Remove "Known Limitation" section from `batch()` JSDoc                                          |
| `specs/20260127T180000-ykeyvalue-transaction-fix.md`              | Update to note limitation is now fixed                                                          |

## Success Criteria

- [ ] All existing tests pass
- [ ] New tests for `pendingDeletes` edge cases pass
- [ ] Stale-read tests now assert correct (non-stale) behavior
- [ ] No type errors
- [ ] Documentation updated to remove "Known Limitation" references
- [ ] `get()` and `has()` return correct values immediately after `delete()` in batch
- [ ] `entries()` correctly skips pending deletes
- [ ] `set()` after `delete()` in same transaction works correctly

## Complexity Assessment

This is a ~10-line-per-class fix:

- 1 line: Add `pendingDeletes` field
- 1 line: Add to `pendingDeletes` in `delete()`
- 1 line: Check `pendingDeletes` in `delete()` for idempotency
- 1 line: Clear from `pendingDeletes` in `set()`
- 1 line: Check `pendingDeletes` in `get()`
- 1 line: Check `pendingDeletes` in `has()`
- 1 line: Check `pendingDeletes` in `entries()`
- 1 line: Clear from `pendingDeletes` in observer

Total: ~8 lines of actual logic per class, plus test updates and documentation cleanup.
