# Symmetric `_v` for All Tables

**Date**: 2026-02-15
**Status**: Plan (pending approval)
**Depends on**: `specs/20260214T225000-version-discriminant-tables-only.md`

## Goal

Add `_v: 1` (number literal) to every table definition in the codebase. Change the recommended default from asymmetric `_v` (add later) to symmetric `_v` (include from v1). KV stores are unchanged.

## Key Decision: Numbers Not Strings

All existing `_v` code uses **strings** (`_v: '"1"'` in arktype → `_v: '1'` at runtime). We're switching to **numbers** (`_v: '1'` in arktype → `_v: 1` at runtime). This means existing test code with `'"1"'` / `'"2"'` / `'"3"'` all change to `'1'` / `'2'` / `'3'`.

## Implementation Plan

### Task 1: Production table schemas: Tab Manager

**File**: `apps/tab-manager/src/lib/workspace.ts`

Add `_v: '1'` to the arktype schema for all 6 tables: `devices`, `tabs`, `windows`, `tabGroups`, `savedTabs`. The `_v` goes last per convention.

```typescript
// Before
devices: defineTable(type({ id: 'string', name: 'string', ... }))

// After
devices: defineTable(type({ id: 'string', name: 'string', ..., _v: '1' }))
```

- [ ] Add `_v: '1'` to all 6 table schemas (last property)

### Task 2: Tab Manager write sites: Row converters

**File**: `apps/tab-manager/src/lib/sync/row-converters.ts`

3 functions (`tabToRow`, `windowToRow`, `tabGroupToRow`) construct row objects. Add `_v: 1` to each return value.

- [ ] `tabToRow`: add `_v: 1` to return object
- [ ] `windowToRow`: add `_v: 1` to return object
- [ ] `tabGroupToRow`: add `_v: 1` to return object

### Task 3: Tab Manager write sites: Manual set() calls

**Files**: `background.ts`, `saved-tab-state.svelte.ts`

- [ ] `background.ts:153`: `devices.set({...})`: add `_v: 1`
- [ ] `saved-tab-state.svelte.ts:88`: `savedTabs.set({...})`: add `_v: 1`
- [ ] `saved-tab-state.svelte.ts:174`: `savedTabs.set(savedTab)`: already passes full object, so once the type includes `_v` this should be fine (savedTab comes from a `.get()` which includes `_v`)

### Task 4: Production table schemas: Reddit Workspace

**File**: `packages/epicenter/src/ingest/reddit/workspace.ts`

Add `_v: '1'` to all 24 table schemas. KV entries (`statistics`, `preferences`) stay unchanged.

- [ ] Add `_v: '1'` to all 24 table schemas (last property)

### Task 5: Reddit ingestion: Inject `_v: 1` at insertion layer

**File**: `packages/epicenter/src/ingest/reddit/index.ts`

The `importTableRows` function does `schema.assert(row)` → `tableClient.set(row)`. CSV data doesn't have `_v`, so we inject it at insertion:

```typescript
// Before
for (const row of rows) tableClient.set(row);

// After
for (const row of rows) tableClient.set({ ...row, _v: 1 });
```

The type of `tableClient.set` will enforce `_v: 1` once the schemas change.

- [ ] Update `importTableRows` to spread `_v: 1` into each row

### Task 6: JSDoc/recommendations: Switch to symmetric `_v`

**Files**: `define-table.ts`, `define-kv.ts`, `index.ts`, `create-tables.ts`, `create-kv.ts`

Update all JSDoc to:

1. Recommend symmetric `_v` as default (was: asymmetric)
2. Use number literals (was: string literals)
3. Show `_v: '1'` in arktype (not `_v: '"1"'`)

- [ ] `define-table.ts`: Update JSDoc + type doc comments
- [ ] `define-kv.ts`: Update JSDoc (note: spec says KV \_v is "open": keep both patterns shown but use numbers)
- [ ] `index.ts`: Update module-level JSDoc examples
- [ ] `create-tables.ts`: Update JSDoc examples
- [ ] `create-kv.ts`: Update JSDoc examples

### Task 7: Test files: String→Number + Add `_v` where missing

**Files**: 6 test files

| File                         | Changes needed                                                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `define-table.test.ts`       | Change `'"1"'`→`'1'`, `'"2"'`→`'2'` in arktype schemas; change `'1'`→`1`, `'2'`→`2` in runtime assertions/data |
| `define-kv.test.ts`          | Same string→number conversion                                                                                  |
| `create-tables.test.ts`      | Same + update the non-\_v migration tests to use `_v`                                                          |
| `table-helper.test.ts`       | Migration tests: add `_v` to the versioned table definitions                                                   |
| `describe-workspace.test.ts` | Multi-version test: add `_v`                                                                                   |
| `benchmark.test.ts`          | `postDefinition` and `noteDefinition`: add `_v: '1'`                                                           |
| `define-workspace.test.ts`   | All `defineTable(type({...}))` calls: add `_v: '1'`                                                            |
| `create-workspace.test.ts`   | All `defineTable(type({...}))` calls: add `_v: '1'`                                                            |

- [ ] Update all test files

## What's NOT changing

- **KV stores**: No `_v` added. The spec leaves KV stance open.
- **`types.ts`**: No type changes needed. `_v` flows through generics naturally.
- **`define-table.ts` implementation**: No runtime code changes. Only JSDoc.
- **`define-kv.ts` implementation**: No runtime code changes. Only JSDoc.

## Review

### Summary

All tasks completed. **630 tests pass, 0 failures.**

### Files Modified (19 total)

**Production code (7 files):**

- `apps/tab-manager/src/lib/workspace.ts`: `_v: '1'` added to 5 table schemas
- `apps/tab-manager/src/lib/sync/row-converters.ts`: `_v: 1` in 3 row converter returns
- `apps/tab-manager/src/entrypoints/background.ts`: `_v: 1` in devices.set()
- `apps/tab-manager/src/lib/state/saved-tab-state.svelte.ts`: `_v: 1` in savedTabs.set()
- `packages/epicenter/src/ingest/reddit/workspace.ts`: `_v: '1'` added to 24 table schemas
- `packages/epicenter/src/ingest/reddit/index.ts`: `{ ...row, _v: 1 }` in importTableRows

**JSDoc updates (5 files):**

- `packages/epicenter/src/static/define-table.ts`: Symmetric `_v` now recommended default, numbers not strings
- `packages/epicenter/src/static/define-kv.ts`: Same string→number conversion
- `packages/epicenter/src/static/index.ts`: Module-level examples updated
- `packages/epicenter/src/static/create-tables.ts`: JSDoc examples updated
- `packages/epicenter/src/static/create-kv.ts`: JSDoc examples updated

**Test files (7 files):**

- `define-table.test.ts`: All `_v` string→number, all fixtures get `_v: '1'`, field-presence tests converted to symmetric
- `define-kv.test.ts`: Existing `_v` patterns converted string→number (KV without `_v` left as-is)
- `create-tables.test.ts`: All migration tests use numeric `_v`, field-presence tests converted
- `table-helper.test.ts`: All 22+ defineTable fixtures get `_v: '1'`, all set/assertion data updated
- `describe-workspace.test.ts`: Multi-version test uses numeric `_v`
- `benchmark.test.ts`: All 4 table definitions + 5 row-builder helpers updated
- `define-workspace.test.ts`: All 12 defineTable calls + 6 set calls updated
- `create-workspace.test.ts`: Both defineTable calls + ~20 set calls updated

### Verification

- `bun test` in `packages/epicenter/`: 630 pass, 2 skip, 0 fail
- Zero `_v: '"..."'` (old string pattern) remaining anywhere in codebase
- Zero `._v === '...'` (old string comparison) remaining
- All 29 table schemas (5 tab-manager + 24 reddit) confirmed to have `_v: '1'`
- KV stores unchanged (statistics, preferences, theme)
