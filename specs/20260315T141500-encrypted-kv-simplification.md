# Encrypted KV Internal Simplification

**Date**: 2026-03-15
**Status**: Implemented
**Author**: AI-assisted

## Overview

Two internal simplifications to `y-keyvalue-lww-encrypted.ts`: (1) replace the quarantine map with a computed property, and (2) replace direct `ykv.map` property access with method-based iteration. Both reduce indirection in the encrypted wrapper without changing external behavior.

## Motivation

### Current State

The encrypted KV wrapper (`y-keyvalue-lww-encrypted.ts`, 539 lines) maintains three internal data structures:

```typescript
const map = new Map<string, YKeyValueLwwEntry<T>>();           // decrypted cache
const quarantine = new Map<string, YKeyValueLwwEntry<EncryptedBlob | T>>(); // failed decrypts
const changeHandlers = new Set<YKeyValueLwwChangeHandler<T>>(); // observers
```

Table helpers (`create-table.ts`) access the decrypted cache directly as a property:

```typescript
// create-table.ts: 7 call sites
for (const [key, entry] of ykv.map) { ... }  // getAll, getAllValid, getAllInvalid, filter, find
Array.from(ykv.map.keys())                     // clear
ykv.map.size                                   // count
```

This creates problems:

1. **Quarantine adds a third map for minimal value.** `activateEncryption()` already does a full `map.clear()` + rebuild from `inner.map` (lines 485-492). Every entry is re-decrypted regardless of quarantine state. The quarantine map's only functional contribution is the exposed `ReadonlyMap` so consumers can show "N entries failed to decrypt". But that count is computable as `inner.map.size - map.size` without a dedicated map.

2. **Raw `map` property leaks the internal cache.** `YKeyValueLwwEncrypted<T>` exposes `readonly map: Map<string, YKeyValueLwwEntry<T>>`. TypeScript's `readonly` prevents reassignment but not mutation. Any consumer with a type assertion can call `.set()` or `.clear()` on the wrapper's internal cache. A method returning an iterator is safer.

### Desired State

```typescript
// BEFORE: quarantine map + exposed map property
kv.quarantine.size       // → 2
kv.quarantine.has('key') // → true
for (const [k, e] of kv.map) { ... }
kv.map.size              // → 5

// AFTER: computed count + method-based iteration
kv.failedDecryptCount    // → 2
for (const [k, e] of kv.cachedEntries()) { ... }
kv.cachedSize            // → 5
```

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Kill quarantine map entirely | Yes | `activateEncryption()` already rebuilds from scratch. Quarantine adds 15 lines of set/delete/clear bookkeeping across 5 call sites for one scenario (wrong-key → correct-key without page reload). |
| Replace with `failedDecryptCount` getter | Computed `inner.map.size - map.size` | Zero storage, always accurate, covers the UI warning use case. |
| Expose iteration via method | `cachedEntries()` returning `IterableIterator` | Prevents external mutation of internal map. Matches how `entries()` already works. |
| Expose size via getter | `cachedSize` returning `number` | Read-only by design. No `.size` on a raw map. |
| Keep `entries()` method unchanged | Yes | `entries()` handles the transaction gap (pending values not yet in cache). `cachedEntries()` is the "fast path" for bulk reads that don't need gap coverage. |
| Remove defensive tail in `entries()` | Yes | Lines 450-452 yield wrapper.map entries "not in inner (shouldn't happen, but safe)." If it can't happen, remove it. |
| Change in single phase | Yes | Both changes modify `YKeyValueLwwEncrypted<T>` and `create-table.ts`. Doing them together avoids two passes through the same type definition. |

## Architecture

### Before: Three Maps

```
┌────────────────────────────────────────────┐
│  createEncryptedYkvLww<T>()                │
│                                            │
│  inner: YKeyValueLww<EncryptedBlob | T>    │
│    └── inner.map (encrypted entries)       │
│                                            │
│  map: Map<string, Entry<T>>                │  ← decrypted cache
│  quarantine: Map<string, Entry<Blob|T>>    │  ← failed decrypts
│  changeHandlers: Set<Handler>              │
│                                            │
│  PUBLIC:                                   │
│    .map        → raw Map reference         │
│    .quarantine → raw Map reference         │
└────────────────────────────────────────────┘
         │
         ▼ consumers read .map directly
┌────────────────────────────────────────────┐
│  create-table.ts                           │
│  for (const [key, entry] of ykv.map) ...   │
└────────────────────────────────────────────┘
```

### After: Two Maps, Method Access

```
┌────────────────────────────────────────────┐
│  createEncryptedYkvLww<T>()                │
│                                            │
│  inner: YKeyValueLww<EncryptedBlob | T>    │
│    └── inner.map (encrypted entries)       │
│                                            │
│  map: Map<string, Entry<T>>                │  ← decrypted cache (internal only)
│  changeHandlers: Set<Handler>              │
│                                            │
│  PUBLIC:                                   │
│    .cachedEntries() → IterableIterator     │
│    .cachedSize      → number (getter)      │
│    .failedDecryptCount → number (getter)   │
└────────────────────────────────────────────┘
         │
         ▼ consumers iterate via method
┌────────────────────────────────────────────┐
│  create-table.ts                           │
│  for (const [k, e] of ykv.cachedEntries()) │
└────────────────────────────────────────────┘
```

## Implementation Plan

### Phase 1: Kill Quarantine Map

- [x] **1.1** Remove `quarantine` map declaration (line 252)
- [x] **1.2** In `tryDecryptEntry` (lines 301-320): remove `quarantine.set(key, entry)` and `quarantine.delete(key)`. The function already returns `undefined` on failure. Callers already handle this.
- [x] **1.3** In observer callback (lines 355-381): remove `quarantine.delete(key)` on delete action (line 361)
- [x] **1.4** In `delete()` (lines 428-432): remove `quarantine.delete(key)` (line 430)
- [x] **1.5** In `activateEncryption()` (lines 479-528): remove `quarantine.clear()` (line 486)
- [x] **1.6** Replace `quarantine` property in return object with `failedDecryptCount` getter:
  ```typescript
  get failedDecryptCount() {
      return inner.map.size - map.size;
  },
  ```
- [x] **1.7** Update `YKeyValueLwwEncrypted<T>` type: remove `quarantine` readonly map, add `readonly failedDecryptCount: number`
- [x] **1.8** Update module JSDoc header: remove quarantine references from the data flow diagram and error containment section

### Phase 2: Method-Based Map Access

- [x] **2.1** Add `cachedEntries()` method and `cachedSize` getter to `createEncryptedYkvLww` return object:
  ```typescript
  *cachedEntries(): IterableIterator<[string, YKeyValueLwwEntry<T>]> {
      yield* map.entries();
  },
  get cachedSize() {
      return map.size;
  },
  ```
- [x] **2.2** Update `YKeyValueLwwEncrypted<T>` type: remove `readonly map`, add `cachedEntries()` and `readonly cachedSize: number`
- [x] **2.3** Update `create-table.ts`: 7 call sites:
  - `getAll()` line 102: `ykv.map` → `ykv.cachedEntries()`
  - `getAllValid()` line 111: `ykv.map` → `ykv.cachedEntries()`
  - `getAllInvalid()` line 122: `ykv.map` → `ykv.cachedEntries()`
  - `filter()` line 137: `ykv.map` → `ykv.cachedEntries()`
  - `find()` line 147: `ykv.map` → `ykv.cachedEntries()`
  - `clear()` line 169: `Array.from(ykv.map.keys())` → `Array.from(ykv.cachedEntries()).map(([k]) => k)` or add a `cachedKeys()` method
  - `count()` line 198: `ykv.map.size` → `ykv.cachedSize`

### Phase 3: Clean Up

- [x] **3.1** Remove defensive tail in `entries()` generator (lines 450-452): the "shouldn't happen" wrapper.map-not-in-inner fallback
- [x] **3.2** Update module JSDoc: replace `wrapper.map` references with `cachedEntries()` in data flow diagram
- [x] **3.3** Update tests:
  - `kv.quarantine?.has(...)` → `kv.failedDecryptCount`
  - `kv.quarantine?.size` → `kv.failedDecryptCount`
  - `kv.map.get(...)` → use `kv.get(...)` or iterate `kv.cachedEntries()`
  - `kv.map.size` → `kv.cachedSize`
- [x] **3.4** Run `bun test` in `packages/workspace` to verify all tests pass
- [x] **3.5** Run `bun typecheck` to verify no type errors

## Edge Cases

### Wrong key → correct key without page reload

1. User signs in → `activateEncryption(wrongKey)` → entries fail to decrypt
2. `failedDecryptCount` returns `inner.map.size - map.size` (shows N failed)
3. User signs in with correct key → `activateEncryption(correctKey)`
4. `activateEncryption()` does `map.clear()` + full rebuild from `inner.map`: entries decrypt successfully
5. `failedDecryptCount` returns 0

No quarantine map needed. The full rebuild in `activateEncryption()` handles retry implicitly.

### Corrupted blob during observation

1. Remote peer syncs a tampered blob
2. Observer calls `tryDecryptEntry()` → returns `undefined`
3. Entry is not added to `map` (no quarantine either)
4. `failedDecryptCount` = `inner.map.size - map.size` = 1
5. `get('corrupted-key')` returns `undefined` (same behavior as today)

### Table helper calls during transaction gap

1. `kv.set('key', value)` → inner.set() called
2. Before observer fires, `getAll()` calls `cachedEntries()`
3. `cachedEntries()` yields from `map`: the new entry is NOT yet in map
4. This is the same behavior as today (`ykv.map` also doesn't have the entry yet)
5. `get('key')` still works via the fallback path (inner.get → decrypt on the fly)

No regression. `cachedEntries()` and `map` iteration have identical gap behavior.

### `clear()` needs keys, not entries

1. `clear()` currently does `Array.from(ykv.map.keys())` then deletes each
2. With `cachedEntries()`, this becomes `Array.from(ykv.cachedEntries()).map(([k]) => k)`
3. Slightly more allocation (entry tuples created then discarded)

Option: add a `cachedKeys()` method that yields only keys. Low priority: `clear()` is infrequent.

## Open Questions

1. **Naming: `cachedEntries()` vs `mapEntries()` vs `decryptedEntries()`?**
   - `cachedEntries()` is accurate (they're cached decryptions) but might imply staleness
   - `mapEntries()` preserves the current mental model (`map` → `mapEntries`)
   - `decryptedEntries()` is most descriptive but longer
   - **Recommendation**: `mapEntries()`: least disruption, most aligned with existing code. The internal variable is still called `map`, the JSDoc already says "decrypted in-memory index."

2. **Should `clear()` get a dedicated `cachedKeys()` method?**
   - Avoids materializing full entries just to extract keys
   - Only one call site uses it
   - **Recommendation**: Skip for now. Add later if profiling shows it matters. The extra allocation in `clear()` is negligible.

3. **Should `failedDecryptCount` distinguish "never attempted" vs "failed"?**
   - In plaintext mode, `inner.map.size - map.size` is always 0 (no encryption, no failures)
   - In locked mode, it could be nonzero (entries arrived while locked, can't decrypt)
   - **Recommendation**: The count is correct in all modes. No special handling needed.

4. **Test assertions on quarantine behavior: rewrite or remove?**
   - Tests like `expect(kv.quarantine?.has('corrupt')).toBe(true)` need updating
   - Could replace with `expect(kv.failedDecryptCount).toBe(1)`: less granular but sufficient
   - The "activateEncryption rebuilds map and fires synthetic events" test (line 730) specifically tests quarantine→retry. This test still works because `failedDecryptCount` reflects the same state.
   - **Recommendation**: Rewrite to use `failedDecryptCount`. The specific key-level quarantine checks are testing implementation, not behavior.

## Success Criteria

- [ ] `quarantine` map removed: no references in source code
- [ ] `failedDecryptCount` getter returns correct count in all modes (plaintext, encrypted, locked)
- [ ] `ykv.map` property removed from `YKeyValueLwwEncrypted<T>` type
- [ ] All 7 `create-table.ts` call sites use method-based access
- [ ] All existing tests pass (rewritten where needed)
- [ ] No new type errors (`bun typecheck`)
- [ ] Module JSDoc updated to reflect new architecture

## References

- `packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww-encrypted.ts`: Primary file, all changes
- `packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww-encrypted.test.ts`: Test updates
- `packages/workspace/src/workspace/create-table.ts`: Consumer, 7 call sites to update
- `packages/workspace/src/workspace/types.ts`: Type definition for `YKeyValueLwwEncrypted<T>` (if re-exported here)
- `packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww.ts`: Inner CRDT, unchanged (reference only)

## Execution Notes

**Execution order**: 1st (no dependencies)

**Can parallel with**: Encryption Wiring Factory (spec `20260315T141700`): different files entirely.

**Naming resolution**: Use `cachedEntries()` and `cachedSize` for the new public API. Add `cachedKeys()` if `clear()` ergonomics demand it, but defer unless needed.

**Open question resolutions**:
- `failedDecryptCount` does not need to distinguish "never attempted" vs "failed": the count is correct in all modes
- Rewrite quarantine test assertions to use `failedDecryptCount`: test behavior, not implementation
- Skip dedicated `cachedKeys()` for now: `clear()` is infrequent, the extra allocation is negligible

**Note**: If the mode renaming spec (`20260315T083500`) executes later, it will rename string literals in `y-keyvalue-lww-encrypted.ts`. No conflict: quarantine removal and string renames are independent changes.


## Review

**Completed**: 2026-03-15

### Summary

Removed the quarantine map and replaced it with a computed `failedDecryptCount` getter (`inner.map.size - map.size`). Replaced direct `ykv.map` property access with `cachedEntries()` generator and `cachedSize` getter. Removed the defensive tail in `entries()`. Updated all 7 call sites in `create-table.ts`, the `YKeyValueLwwEncrypted<T>` type, module JSDoc, and test assertions.

### Deviations from Spec

- Also updated `types.ts` JSDoc for `WorkspaceClient.activateEncryption()` which referenced quarantine: not in the spec but necessary for consistency.
- Kept `wrapper.map` references in internal JSDoc comments (variable is still called `map` internally): only public API references were updated to `cachedEntries()`.

### Follow-up Work

- `cachedKeys()` method deferred as spec recommended: add if `clear()` ergonomics become a concern.
- Remaining `quarantine` references in `crypto/index.ts` (line 257) describe general behavior, not the removed map: no change needed.