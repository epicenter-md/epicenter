# Type-Tighten TableHelper.observe() to Use Row-Specific ID Types

## Problem

`TableHelper<TRow>.observe()` passed `Set<string>` for changed IDs, forcing consumers
with branded ID types (like `FileId`) to cast at every usage point.

## Solution

Changed the callback signature to `ReadonlySet<TRow['id']>` so the set carries the
branded type through. One cast in infrastructure replaces N casts at consumer sites.

## Changes

### `packages/workspace/src/workspace/types.ts`
- Updated `observe` signature: `Set<string>` -> `ReadonlySet<TRow['id']>`
- Updated JSDoc to reflect `ReadonlySet<TRow['id']>`

### `packages/workspace/src/workspace/table-helper.ts`
- Updated `observe` implementation signature to match
- Added single `as ReadonlySet<TRow['id']>` cast (safe: keys ARE the row IDs)

### `packages/workspace/src/workspace/table-helper.test.ts`
- Changed one `Set<string>[]` array to `ReadonlySet<string>[]` (line that pushes changedIds directly)

### `apps/tab-manager/src/lib/state/browser-state.svelte.ts`
- Removed 3 redundant casts (`id as TabCompositeId`, `id as WindowCompositeId`, `id as GroupCompositeId`)
- These are now unnecessary because iterating `ReadonlySet<TabCompositeId>` yields `TabCompositeId` directly

## Why ReadonlySet

`ReadonlySet` is covariant (no `.add()`), so `ReadonlySet<FileId>` is assignable to
`ReadonlySet<string>`. `Set` is invariant and would break consumers expecting `Set<string>`.

## Why the cast in table-helper.ts remains

`YKeyValueLww<T>` is generic over value type only. Keys are hardcoded as `string` in
`YKeyValueLwwEntry<T> = { key: string; val: T; ts: number }`. So `ykv.observe()` yields
`Map<string, ...>` and `new Set(changes.keys())` is `Set<string>`. Since `ReadonlySet<string>`
is NOT assignable to `ReadonlySet<BrandedId>` (covariance goes the other direction), the single
cast in infrastructure is necessary.

The proper elimination would be `YKeyValueLww<T, K extends string = string>` to make the
class generic over its key type. That's a larger refactor (separate PR).

## Validation

- [x] LSP diagnostics: zero errors on all changed files
- [x] `bun test` in packages/workspace/: 394 tests pass
- [x] `tsc --noEmit` in packages/workspace/ and packages/filesystem/: only pre-existing errors
- [x] Consumer files (sqlite-index, path-index, browser-state) compile without errors
- [x] 3 redundant `as` casts removed from browser-state.svelte.ts