# YKeyValue Transaction Nesting Bug Fix

**Created**: 2025-01-27
**Status**: Implemented
**Affects**: `YKeyValue`, `YKeyValueLww`

## Problem Statement

Both `YKeyValue` and `YKeyValueLww` have a bug when used inside a wrapping Yjs transaction (e.g., via `batch()`). Entries added inside a wrapping transaction may be incorrectly processed by the observer, causing:

- **YKeyValueLww**: Valid entries are deleted (severe)
- **YKeyValue**: Wrong change events emitted (moderate)

## Root Cause

### The Dual-Writer Problem

Both implementations have two writers to `this.map`:

1. **`set()` method** - Updates map immediately after `transact()` returns
2. **Observer** - Updates map when processing Y.Array changes

```
BEFORE (dual-writer, buggy):
┌─────────────────────────────────────────────────────────┐
│                     YKeyValue(Lww)                      │
│                                                         │
│   Y.Array ──────────► Observer ──────► this.map         │
│                                            ▲            │
│   set() ───────────────────────────────────┘            │
│                                                         │
│   TWO WRITERS = Race condition with nested transactions │
└─────────────────────────────────────────────────────────┘
```

### Why It Breaks with Nested Transactions

Yjs merges nested transactions into the outermost one. Observers only fire after the **outermost** transaction completes.

```
Without batch (works):
─────────────────────────────────────────────────────────
kv.set('foo', 1)
    └─► transact() starts
            └─► yarray.push(entry)
        transact() ends
            └─► Observer fires (map not yet updated by set())
                    └─► Observer updates map correctly
        └─► set() updates map (redundant but harmless)


With batch (breaks):
─────────────────────────────────────────────────────────
batch() → outer transact() starts
    │
    kv.set('foo', 1)
        └─► inner transact() ← MERGES into outer, returns immediately
        └─► set() updates map ← HAPPENS NOW
    │
    kv.set('bar', 2)
        └─► inner transact() ← MERGES into outer
        └─► set() updates map ← HAPPENS NOW
    │
batch() ends
    └─► Observer fires
            └─► existing = this.map.get('foo')
                         = entry (already set by set()!)
            └─► existing === newEntry (same object!)
            └─► LWW comparison: equal timestamps, tiebreaker logic
            └─► INCORRECTLY DELETES ENTRY
```

### The Specific Bug in YKeyValueLww

In the observer (lines 272-289), when timestamps are equal:

```typescript
const oldIndex = allEntries.indexOf(existing);   // e.g., 5
const newIndex = allEntries.indexOf(newEntry);   // ALSO 5 (same object!)

if (newIndex > oldIndex) {
    // ... new wins
} else {
    // Falls through here because 5 > 5 is false
    indicesToDelete.push(newIndex);  // INCORRECTLY DELETES!
}
```

The code assumes `existing` and `newEntry` are different objects. When they're the same (because `set()` already updated the map), the tiebreaker logic breaks.

## Solution: Single Writer Architecture

**Principle**: The observer is the sole owner of `this.map`. The `set()` method should never directly update the map.

### The Architecture

```
AFTER (single-writer, correct):
┌─────────────────────────────────────────────────────────┐
│                     YKeyValue(Lww)                      │
│                                                         │
│   set() ──► pending ──► Y.Array                         │
│                │            │                           │
│                │      Observer                          │
│                │            │                           │
│                │            ▼                           │
│   get() ◄─────┴────────► this.map                       │
│                                                         │
│   SINGLE WRITER TO MAP = No race condition              │
└─────────────────────────────────────────────────────────┘
```

### Who Writes Where

| Writer   | `pending` | `Y.Array` | `map`     |
|----------|-----------|-----------|-----------|
| `set()`  | ✅ writes | ✅ writes | ❌ never  |
| Observer | ❌ never  | ❌ never  | ✅ writes |

### The Data Flow

```
set('foo', 1) is called:
─────────────────────────────────────────────────────────────

  set()
    │
    ├───► pending.set('foo', entry)    ← For immediate reads
    │
    └───► yarray.push(entry)           ← Source of truth (CRDT)
                │
                │  (observer fires after transaction ends)
                ▼
          Observer
                │
                ├───► map.set('foo', entry)      ← Observer writes to map
                │
                └───► pending.delete('foo')      ← Clears pending


get('foo') is called:
─────────────────────────────────────────────────────────────

  get()
    │
    ├───► Check pending.get('foo')  ← If found, return it
    │         │
    │         └── (entry found? return it)
    │
    └───► Check map.get('foo')      ← Fallback to map
              │
              └── (return it)
```

### Key Insight

- **`pending`** = temporary holding area for immediate reads, never writes to `map`
- **`map`** = authoritative cache, only written by observer
- **Observer** = watches `Y.Array`, writes to `map`, clears `pending`

The `pending` map bridges the gap between:
1. `set()` pushing to Y.Array
2. Observer processing that push and updating map

Once the observer fires, `pending` is cleared and `map` has the data.

### Why This Works

**Without batch:**
```
set('foo', 1)
  → pending.set('foo')
  → yarray.push()
  → transaction ends immediately
  → observer fires immediately
  → map.set('foo'), pending.delete('foo')

get('foo') → checks pending (empty), checks map → returns 1
```

**With batch:**
```
batch(() => {
  set('foo', 1)  → pending.set('foo'), yarray.push()
  set('bar', 2)  → pending.set('bar'), yarray.push()

  get('foo')     → checks pending → returns 1 ✓
})
→ outer transaction ends
→ observer fires once
→ map.set('foo'), map.set('bar')
→ pending.delete('foo'), pending.delete('bar')

get('foo') → checks pending (empty), checks map → returns 1
```

### Changes Required

#### 1. Add Pending Map for Immediate Reads

```typescript
class YKeyValueLww<T> {
    readonly map: Map<string, YKeyValueLwwEntry<T>>;

    // NEW: Track entries written but not yet processed by observer
    private pending: Map<string, YKeyValueLwwEntry<T>> = new Map();
```

#### 2. Modify `set()` to Not Update Map

```typescript
set(key: string, val: T): void {
    const entry: YKeyValueLwwEntry<T> = { key, val, ts: this.getTimestamp() };

    // Track in pending for immediate reads
    this.pending.set(key, entry);

    // Check if already inside a transaction
    const inTransaction = (this.doc as any)._transaction !== null;

    const doWork = () => {
        // Use map for existence check (pending entries aren't in yarray yet)
        if (this.map.has(key)) this.deleteEntryByKey(key);
        this.yarray.push([entry]);
    };

    if (inTransaction) {
        doWork();  // Already in transaction, don't nest
    } else {
        this.doc.transact(doWork);
    }

    // DO NOT update this.map here - observer handles it
}
```

#### 3. Modify `get()` to Check Pending First

```typescript
get(key: string): T | undefined {
    // Pending takes precedence (written but observer hasn't fired)
    const pending = this.pending.get(key);
    if (pending) return pending.val;

    return this.map.get(key)?.val;
}
```

#### 4. Modify `has()` to Check Pending

```typescript
has(key: string): boolean {
    return this.pending.has(key) || this.map.has(key);
}
```

#### 5. Modify Observer to Clear Pending

```typescript
// In observer, after processing an added entry:
for (const newEntry of addedEntries) {
    // ... existing LWW logic ...

    // Clear from pending once processed
    if (this.pending.get(newEntry.key) === newEntry) {
        this.pending.delete(newEntry.key);
    }
}
```

#### 6. Handle Delete with Pending

```typescript
delete(key: string): void {
    // Remove from pending if present
    this.pending.delete(key);

    if (!this.map.has(key)) return;

    this.deleteEntryByKey(key);
    // DO NOT update this.map here - observer handles it
}
```

## Why Not Simpler Fixes?

### Option A: Just check `existing === newEntry` in observer

```typescript
if (existing === newEntry) continue;  // Skip if same object
```

**Rejected because**:
- Band-aid fix that doesn't address root cause
- Dual-writer architecture remains fragile
- YKeyValue would still emit wrong change events

### Option B: Remove inner transaction from `set()`

```typescript
set(key, val) {
    if (this.map.has(key)) this.deleteEntryByKey(key);  // Fires observer!
    this.yarray.push([entry]);                           // Fires observer!
}
```

**Rejected because**:
- Single `set()` fires observers twice (delete + add)
- Emits "delete" + "add" events instead of "update"
- Forces users to always wrap in `batch()` for correct semantics

### Option C: Use Y.Map instead

**Rejected because**:
- Y.Map uses Yjs internal ordering (clientID-based), not wall-clock timestamps
- `YKeyValueLww` specifically exists for "latest edit wins" semantics in offline-first scenarios
- Different conflict resolution behavior would break existing use cases

## Why Use `doc._transaction`?

The internal `_transaction` property is used to check if we're inside a transaction:

```typescript
const inTransaction = (this.doc as any)._transaction !== null;
```

**Concerns**:
- Uses internal Yjs API (underscore prefix indicates private)
- Could break in future Yjs versions

**Mitigations**:
- This pattern is stable in Yjs (used since early versions)
- We can add a runtime check and fall back to always using `transact()`
- The check is isolated to one location, easy to update if Yjs changes

**Alternative considered**: Always use `transact()` (nested transactions merge anyway)
- Works but adds unnecessary overhead
- The check provides a small performance optimization

## Testing Strategy

### Unit Tests

1. **Single `set()` without batch**: Verify entry is added correctly
2. **Multiple `set()` with batch**: Verify all entries persist
3. **`get()` immediately after `set()` in batch**: Verify returns correct value
4. **`delete()` in batch**: Verify entry is removed
5. **Observer fires once per batch**: Verify single observer call with all changes
6. **Sync after batch**: Verify CRDT merge works correctly

### Integration Tests

1. **Dynamic workspace `batch()` operations**: Create table, fields, rows, cells in one batch
2. **Two-client sync with batched writes**: Verify LWW semantics preserved

### Regression Test

```typescript
test('batch does not delete entries (regression)', () => {
    const workspace = createDynamicWorkspace({ id: 'test' });

    workspace.batch((ws) => {
        ws.tables.create('posts', { name: 'Posts' });
        ws.fields.create('posts', 'title', { name: 'Title', type: 'text' });
        ws.fields.create('posts', 'body', { name: 'Body', type: 'text' });
        const rowId = ws.rows.create('posts');
        ws.cells.set('posts', rowId, 'title', 'Hello');
        ws.cells.set('posts', rowId, 'body', 'World');
    });

    // Previously this would fail - entries were deleted
    expect(workspace.tables.get('posts')).toBeDefined();
    expect(workspace.fields.get('posts', 'title')).toBeDefined();
    expect(workspace.fields.get('posts', 'body')).toBeDefined();
});
```

## Apply to Both Implementations?

**Yes**, both `YKeyValue` and `YKeyValueLww` should be fixed for consistency:

| Implementation | Current Bug | Severity |
|----------------|-------------|----------|
| YKeyValueLww | Deletes valid entries | Critical |
| YKeyValue | Emits wrong change events | Moderate |

Both share the same dual-writer architecture and should use the single-writer pattern.

## Implementation Order

1. Fix `YKeyValueLww` first (critical bug)
2. Add regression tests
3. Fix `YKeyValue` for consistency
4. Update `createDynamicWorkspace.batch()` to use `transact()` (currently disabled)
5. Remove skip from batch test

## Performance Impact

| Operation | Before | After | Impact |
|-----------|--------|-------|--------|
| `set()` without batch | 1 transact | 1 transact | None |
| `set()` in batch | 1 nested transact | 0 transacts | Slight improvement |
| `get()` | 1 map lookup | 2 map lookups | Negligible |
| Observer processing | Same | +1 pending.delete | Negligible |

## Known Limitations

### `delete()` + `has()` During Batch

When `delete()` is called on a **pre-existing key** during a batch, `has()` will
incorrectly return `true` until the batch ends.

```typescript
kv.set('foo', 'bar');  // foo exists in map

ydoc.transact(() => {
    kv.delete('foo');
    kv.has('foo');     // Returns TRUE (incorrect!)
});

kv.has('foo');         // Returns FALSE (correct)
```

**Why this happens:**

```
delete('foo') during batch:
  │
  ├─► pending.delete('foo')     ← No-op (wasn't in pending)
  │
  └─► yarray.delete(index)      ← Queued, observer deferred until batch ends

has('foo') during batch:
  │
  ├─► pending.has('foo')?       ← FALSE
  │
  └─► map.has('foo')?           ← TRUE (stale! observer hasn't updated map)
```

**Impact**: Low. This only affects code that:
1. Deletes a pre-existing key during a batch, AND
2. Checks `has()` for that same key within the same batch

**Workaround**: If you need accurate `has()` after `delete()` in a batch, track
deletions manually or restructure to avoid this pattern.

**Why not fix it?**: Adding a `pendingDeletes` set would add complexity for a
rare edge case. The current behavior is documented and tested.

## Risks

1. **Internal API usage**: `_transaction` could change
   - Mitigation: Isolated check, easy to update

2. **Pending map memory**: Entries stay in pending until observer fires
   - Mitigation: Pending is cleared when observer processes entries

3. **Behavioral change**: `set()` no longer updates map synchronously
   - Mitigation: `pending` provides same read-after-write semantics

## Conclusion

The single-writer architecture (Option 3) is the recommended fix because it:

1. Addresses the root cause (dual writers)
2. Maintains API ergonomics (`get()` works after `set()`)
3. Is consistent across both implementations
4. Enables `batch()` to work correctly with Yjs transactions
