# Workspace-Level `batch()`: Replace Per-Table/Per-KV Batch with `client.batch()`

**Date**: 2026-02-14
**Status**: Complete
**PR**: [#1353](https://github.com/EpicenterHQ/epicenter/pull/1353): Merged 2026-02-14. `client.batch()` replaces per-table/per-KV batch; no transaction object needed.

## Overview

Move the `batch()` API from individual table helpers and KV helpers up to the workspace client. All tables and KV in a workspace share a single `Y.Doc`, so the transaction boundary should reflect that, not pretend it's per-table.

## Problem

### Per-table `batch()` lies about scope

Every table helper and KV helper has its own `batch()` method:

```typescript
tables.tabs.batch((tx) => {
  tx.set({ id: '1', ... });
  tx.set({ id: '2', ... });
});
```

Under the hood, this calls `ydoc.transact()` on the shared workspace Y.Doc. But the API implies the transaction is scoped to that one table. Nothing stops you from doing this:

```typescript
tables.tabs.batch((tx) => {
  tx.set({ id: '1', ... });
  tables.windows.set({ ... }); // Also batched! Same ydoc.transact()
});
```

That works because it's all one Y.Doc. The `tx` object's constrained surface (`set`/`delete` for one table) creates a false impression of isolation that doesn't exist.

### The `tx` parameter is redundant

`tx.set(row)` is identical to `tables.posts.set(row)`: both call through to the same `ykv.set()`. The transaction object adds no behavior beyond what the normal table methods already do inside a `ydoc.transact()` wrapper.

### Cross-table batching requires escaping to raw Yjs

When users need to batch across tables (common in sync code), they have to drop to `ydoc.transact()`:

```typescript
// From background.ts: user has to reach for raw Yjs
ydoc.transact(() => {
	for (const row of rows) {
		tables.tabs.set(row);
	}
	for (const existing of stale) {
		tables.tabs.delete(existing.id);
	}
});
```

This leaks the Yjs implementation detail. The workspace API exists to abstract over Yjs.

## Solution

### Add `client.batch(fn: () => void): void`

```typescript
// create-workspace.ts: in buildClient()
batch(fn: () => void): void {
  ydoc.transact(fn);
}
```

No callback parameter. No `tx` object. The user already has `client.tables` and `client.kv`: calling their normal methods inside the callback automatically batches everything into one Y.js transaction.

```typescript
// Single table
client.batch(() => {
  tables.tabs.set({ id: '1', ... });
  tables.tabs.set({ id: '2', ... });
  tables.tabs.delete('3');
});

// Cross-table + KV: all one transaction
client.batch(() => {
  tables.tabs.set({ id: '1', ... });
  tables.windows.set({ id: 'w1', ... });
  kv.set('lastSync', new Date().toISOString());
});
```

### Remove per-table and per-KV `batch()`

Remove `batch()` from:

- `TableHelper` type and implementation (`static/types.ts`, `static/table-helper.ts`)
- `KvHelper` type and implementation (`static/types.ts`, `static/create-kv.ts`)
- `TableBatchTransaction` type (`static/types.ts`)
- `KvBatchTransaction` type (`static/types.ts`)

### Why no callback parameter?

The callback receives nothing because there's nothing special to pass:

- `tables` and `kv` are the same objects whether you're inside `batch()` or not
- Passing them back as `({ tables, kv }) => { ... }` would falsely imply they're transactional versions with special behavior
- The entire point is that `ydoc.transact()` makes ALL operations on the shared doc atomic: no wrapper needed

## Implementation Plan

- [x] 1. Add `batch()` to `WorkspaceClient` type in `static/types.ts`
- [x] 2. Add `batch()` implementation in `create-workspace.ts` `buildClient()`
- [x] 3. Write tests for `client.batch()` (see Test Plan below)
- [x] 4. Remove `batch()` from `TableHelper` type and `TableBatchTransaction` type in `static/types.ts`
- [x] 5. Remove `batch()` from `KvHelper` type and `KvBatchTransaction` type in `static/types.ts`
- [x] 6. Remove `batch()` implementation from `static/table-helper.ts`
- [x] 7. Remove `batch()` implementation from `static/create-kv.ts`
- [x] 8. Update all call sites that use `table.batch()` or `kv.batch()` to use `client.batch()` (or `ydoc.transact()` where client isn't available: tests, benchmarks, low-level code)
- [x] 9. Run tests and fix any breakage
- [x] 10. Update benchmark test that compares batch vs individual insert

## Test Plan

Tests go in a new file: `static/create-workspace.test.ts`

### Core behavior

1. **`batch()` batches table operations**: multiple `set()` calls, observer fires once
2. **`batch()` batches table deletes**: multiple `delete()` calls, observer fires once
3. **`batch()` batches mixed set + delete**: observer fires once with all changed IDs
4. **`batch()` works across multiple tables**: set on table A + table B, both observers fire once each
5. **`batch()` works across tables and KV**: set on table + KV, both observers fire once each
6. **`batch()` with no operations is a no-op**: no observer fires
7. **Nested `batch()` calls work**: inner batch is absorbed by outer (Yjs transact is reentrant)

### Observer semantics

8. **Without `batch()`, each `set()` fires observer separately**: baseline comparison showing N calls = N notifications
9. **With `batch()`, N calls = 1 notification**: the whole point

### Edge cases

10. **Error inside `batch()` still applies prior operations**: Yjs transact doesn't roll back; verify this behavior is documented/expected

## Files Changed

| File                                                     | Change                                                                                                                                |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/epicenter/src/static/types.ts`                 | Add `batch` to `WorkspaceClient`; remove `batch` from `TableHelper`, `KvHelper`; remove `TableBatchTransaction`, `KvBatchTransaction` |
| `packages/epicenter/src/static/create-workspace.ts`      | Add `batch()` implementation                                                                                                          |
| `packages/epicenter/src/static/table-helper.ts`          | Remove `batch()` method                                                                                                               |
| `packages/epicenter/src/static/create-kv.ts`             | Remove `batch()` method                                                                                                               |
| `packages/epicenter/src/static/create-workspace.test.ts` | New test file                                                                                                                         |
| `packages/epicenter/src/static/table-helper.test.ts`     | Update tests that use `helper.batch()`                                                                                                |
| `packages/epicenter/src/static/benchmark.test.ts`        | Update batch benchmark to use workspace-level batch                                                                                   |
| `packages/epicenter/src/ingest/reddit/index.ts`          | Update `batch()` call sites                                                                                                           |
| External consumers (tab-manager background.ts etc.)      | Replace `ydoc.transact()` / `table.batch()` with `client.batch()`                                                                     |

## Non-Goals

- No changes to the **dynamic** table API (`packages/epicenter/src/dynamic/`). That's a separate system with its own `batch()` / `upsertMany()` / `deleteMany()`. It can be aligned later if desired.
- No changes to the low-level `YKeyValue` or `YKeyValueLww` classes: they keep their internal `transact()` calls for their own atomicity guarantees.

## Review

Implemented in 4 atomic commits:

1. **`feat(static): add batch() to WorkspaceClient`**: Added `batch(fn: () => void): void` to the `WorkspaceClient` type and implementation. The method wraps `ydoc.transact(fn)` directly. Detailed JSDoc explains semantics (no rollback, reentrant nesting, no tx object needed).

2. **`test(static): add workspace-level batch tests`**: New `create-workspace.test.ts` with all 10 test cases from the test plan. All pass. Key tests: observer fires once for batched ops, cross-table+KV atomicity, nested batch absorption, error-doesn't-rollback behavior.

3. **`refactor: migrate batch call sites`**: Updated 5 files:
   - `tab-manager/background.ts`: 3× `ydoc.transact()` → `client.batch()`, removed `ydoc` destructuring (now uses `client.ydoc` for the remaining debug listener)
   - `tab-manager/saved-tab-state.svelte.ts`: 2× `popupWorkspace.ydoc.transact()` → `popupWorkspace.batch()`
   - `ingest/reddit/index.ts`: Refactored `importTableRows` to accept `{ set }` instead of `{ batch }`, wrapped entire import (all tables + KV) in a single `workspace.batch()` call
   - `table-helper.test.ts`: 12× `helper.batch((tx) => ...)` → `ydoc.transact(() => ...)` with direct `helper.set()`/`helper.delete()` calls
   - `benchmark.test.ts`: 1× `tables.batch((tx) => ...)` → `ydoc.transact(() => ...)`

4. **`refactor(static): remove per-table and per-kv batch()`**: Removed `TableBatchTransaction`, `KvBatchTransaction` types, `batch()` from `TableHelper`/`KvHelper` types and implementations, cleaned up re-exports from `index.ts`.

128 tests pass across 9 test files. No type errors. Dynamic API batch left untouched per spec.
