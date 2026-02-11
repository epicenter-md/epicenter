# Unify TableHelper: Remove UntypedTableHelper

**Date**: 2026-02-02
**Status**: Completed
**Scope**: `packages/epicenter/src/dynamic/tables/`

## Overview

Remove the separate `UntypedTableHelper` type and `createUntypedTableHelper` function to enforce schema-first design. Tables not defined in the workspace definition cannot be accessed.

**Simplified from original spec**: The `tables.raw()` escape hatch was deferred. If a table isn't in the definition, you shouldn't access it. This enforces cleaner architecture.

## Motivation

### Current State

The codebase has two separate helper implementations:

```typescript
// table-helper.ts - TWO implementations

// 1. Typed helper (lines 168-486)
export function createTableHelper<TTableDef extends TableDefinition>({
  ydoc,
  tableDefinition: { id: tableId, fields },
}: {
  ydoc: Y.Doc;
  tableDefinition: TTableDef;
}) {
  // Creates TypeBox validator
  const typeboxSchema = fieldsToTypebox(fields);
  const rowValidator = Compile(typeboxSchema);

  // get() validates with TypeBox
  get(id: Id): GetResult<TRow> {
    const row = reconstructRow(id);
    if (row === undefined) return { status: 'not_found', id, row: undefined };
    return validateRow(id, row);  // <-- VALIDATES
  }
}

// 2. Untyped helper (lines 536-754)
export function createUntypedTableHelper({
  ydoc,
  tableName,
}: {
  ydoc: Y.Doc;
  tableName: string;
}): UntypedTableHelper {
  // NO TypeBox validator

  // get() NEVER validates - always returns 'valid'
  get(id: Id): GetResult<TRow> {
    const row = reconstructRow(id);
    if (row === undefined) return { status: 'not_found', id, row: undefined };
    return { status: 'valid', row: row as TRow };  // <-- NO VALIDATION
  }

  // getAllInvalid() always returns empty
  getAllInvalid(): InvalidRowResult[] {
    return [];  // No validation = nothing ever invalid
  }
}
```

The `createTables` function switches between them:

```typescript
// create-tables.ts (lines 199-218)
get(name: string) {
  if (name in tableHelpers) {
    return tableHelpers[name];  // Typed helper
  }
  // Fallback to untyped
  let helper = dynamicTableHelpers.get(name);
  if (!helper) {
    helper = createUntypedTableHelper({ ydoc, tableName: name });
  }
  return helper;
}
```

This creates problems:

1. **Silent degradation**: `tables.get('typo')` silently returns untyped helper with no validation
2. **Behavioral inconsistency**: Same API, different runtime behavior (validates vs never validates)
3. **Code duplication**: Two nearly identical implementations (~200 lines each)
4. **Confusing semantics**: "Untyped" doesn't mean "no TypeScript types"; it means "no runtime validation"

### Desired State

```typescript
// Single implementation, TypeScript overloads for DX
const tables = createTables(ydoc, definitions);

// Static schema (full type inference)
tables.get('posts').upsert({ id: Id('1'), title: 'Hello' }); // Typed
tables.get('posts').get(Id('1')); // Returns GetResult<PostRow>

// Dynamic schema (loose types, same runtime behavior)
const dynamicTables = createTables(ydoc, JSON.parse(schemaJson).tables);
dynamicTables.get('posts').upsert({ id: Id('1'), title: 'Hello' }); // any-ish
dynamicTables.get('posts').get(Id('1')); // Still validates at runtime!

// Raw access (escape hatch for debugging/migration)
tables.raw('posts').getAll(); // No validation, no schema required
tables.raw.names(); // All tables in YJS
```

## Research Findings

### Current Usage Analysis

| Location                        | Usage Pattern                             | Impact of Change                                   |
| ------------------------------- | ----------------------------------------- | -------------------------------------------------- |
| `create-tables.ts`              | Creates untyped helper for unknown tables | **Must change**: Remove fallback                   |
| `create-tables.test.ts:776-796` | Tests dynamic table access                | **Must update**: Change test expectations          |
| `sqlite.ts`, `markdown.ts`      | Uses `tables.get(tableName)` with string  | **No change needed**: Already uses string overload |
| Specs (6 files)                 | Reference `UntypedTableHelper`            | **Document only**: Update or archive               |

### Files Containing UntypedTableHelper References

From grep search:

- `packages/epicenter/src/dynamic/tables/table-helper.ts` - Definition (DELETE)
- `packages/epicenter/src/dynamic/tables/create-tables.ts` - Usage (UPDATE)
- `specs/*.md` (6 files) - Documentation (UPDATE or ARCHIVE)

### TypeScript Overload Behavior

When you have overloads:

```typescript
// Overload signatures (what callers see)
get<K extends TTableDefinitions[number]['id']>(name: K): TableHelper<TypedRow<K>>;
get(name: string): TableHelper<{ id: Id } & Record<string, unknown>>;

// Implementation signature (what runs)
get(name: string): TableHelper<any> { ... }
```

**Key insight**: The implementation is ONE function. TypeScript picks the overload based on call-site types, but runtime behavior is identical.

## Design Decisions

| Decision                          | Choice          | Rationale                                                             |
| --------------------------------- | --------------- | --------------------------------------------------------------------- |
| Remove `UntypedTableHelper`       | Yes             | Behavioral inconsistency (no validation) is confusing and error-prone |
| Remove `createUntypedTableHelper` | Yes             | No longer needed; single implementation handles all cases             |
| Accessing undefined table         | **Throw error** | Prevents silent fallback to schema-less mode                          |
| Add `tables.raw()`                | Yes             | Explicit escape hatch for debugging/migration                         |
| Raw helper validates?             | **No**          | Intentionally raw; no schema to validate against                      |
| TypeScript overloads              | Yes             | Best-effort DX; full inference for static, loose for dynamic          |

## Architecture

### Before

```
┌─────────────────────────────────────────────────────────────┐
│                     createTables()                           │
│                                                              │
│  ┌──────────────────┐      ┌────────────────────────┐       │
│  │ tableHelpers     │      │ dynamicTableHelpers    │       │
│  │ (Map)            │      │ (Map)                  │       │
│  │                  │      │                        │       │
│  │ posts → Typed    │      │ unknown → Untyped      │       │
│  │ users → Typed    │      │ custom → Untyped       │       │
│  └──────────────────┘      └────────────────────────┘       │
│         ↓                           ↓                        │
│   TypeBox validates          NEVER validates                 │
└─────────────────────────────────────────────────────────────┘
```

### After

```
┌─────────────────────────────────────────────────────────────┐
│                     createTables()                           │
│                                                              │
│  ┌──────────────────────────────────────────┐               │
│  │ tableHelpers (Map)                       │               │
│  │                                          │               │
│  │ posts → TableHelper (with validator)     │               │
│  │ users → TableHelper (with validator)     │               │
│  └──────────────────────────────────────────┘               │
│         ↓                                                    │
│   TypeBox validates (always)                                 │
│                                                              │
│  ┌──────────────────────────────────────────┐               │
│  │ tables.raw(name) → RawTableHelper        │               │
│  │                                          │               │
│  │ - No schema                              │               │
│  │ - No validation                          │               │
│  │ - Inspection only                        │               │
│  └──────────────────────────────────────────┘               │
│                                                              │
│  tables.get('unknown') → THROWS ERROR                        │
└─────────────────────────────────────────────────────────────┘
```

### Type Hierarchy After Change

```
TablesFunction<TDefs>
├── get<K extends KnownIds>(name: K): TableHelper<Row<K>>     // Static: full inference
├── get(name: string): TableHelper<LooseRow>                  // Dynamic: loose types
├── raw(name: string): RawTableHelper                         // Escape hatch
├── raw.names(): string[]                                     // All tables in YJS
├── has(name: string): boolean
├── names(): string[]
├── clear(): void
├── definitions: TDefs
└── toJSON(): Record<string, unknown[]>

TableHelper<TRow>
├── upsert(row: TRow): void
├── get(id: Id): GetResult<TRow>
├── getAll(): RowResult<TRow>[]
├── getAllValid(): TRow[]
├── getAllInvalid(): InvalidRowResult[]
├── update(partial: PartialRow<TRow>): UpdateResult
├── delete(id: Id): DeleteResult
├── filter(pred: (row: TRow) => boolean): TRow[]
├── find(pred: (row: TRow) => boolean): TRow | null
├── observe(callback): () => void
├── count(): number
├── clear(): void
└── inferRow: TRow

RawTableHelper
├── getAll(): RawRow[]
├── get(id: Id): RawRow | undefined
├── has(id: Id): boolean
└── count(): number

RawRow = { id: Id } & Record<string, unknown>
LooseRow = { id: Id } & Record<string, unknown>
```

## Implementation Plan

### Phase 1: Remove UntypedTableHelper from table-helper.ts

**File: `packages/epicenter/src/dynamic/tables/table-helper.ts`**

- [x] **1.1** Keep `createTableHelper` unchanged (requires tableDefinition)
  - Decision: Schema is always required; no optional definition

- [x] **1.2** Delete `UntypedTableHelper` type (~30 lines removed)
- [x] **1.3** Delete `createUntypedTableHelper` function (~220 lines removed)
- [x] **1.4** Exports automatically clean (types were internal)

### Phase 2: Update createTables to Throw for Undefined Tables

**File: `packages/epicenter/src/dynamic/tables/create-tables.ts`**

- [x] **2.1** Remove `UntypedTableHelper` import and type references
- [x] **2.2** Remove `dynamicTableHelpers` cache
- [x] **2.3** Update `get()` to throw for unknown tables:

```typescript
get(name) {
  if (name in tableHelpers) {
    return tableHelpers[name as keyof typeof tableHelpers];
  }
  const availableTableNames = tableDefinitions.map((t) => t.id).join(', ');
  throw new Error(
    `Table '${name}' not found in workspace definition. Available tables: ${availableTableNames}`,
  );
}
```

- [x] **2.4** Update `has()` to return `false` for undefined tables (no longer checks Y.Array)
- [x] **2.5** Update `names()` to only return defined table names that have data
- [x] **2.6** Update `toJSON()` to only serialize defined tables

**Deferred**: `tables.raw()` escape hatch not implemented. If needed later, can add.

### Phase 3: Add RawTableHelper

**Status**: DEFERRED

The `tables.raw()` escape hatch was not implemented. Decision: enforce schema-first design. If you need to access a table, define it in your workspace.

Future consideration: If migration tooling needs raw access, can revisit.

### Phase 4: Update Exports

**File: `packages/epicenter/src/dynamic/tables/create-tables.ts`**

- [x] **4.1** `UntypedTableHelper` was never in public exports (internal type)

**File: `packages/epicenter/src/dynamic/index.ts`**

- [x] **4.2** Verified clean - no stale exports

### Phase 5: Update Tests

**File: `packages/epicenter/src/dynamic/tables/create-tables.test.ts`**

- [x] **5.1** Update test to `get() throws for undefined tables`:
  - Uses `as any` to bypass TypeScript (testing runtime error handling)
  - Tests error message includes table name and available tables

- [x] **5.2** Raw access tests: SKIPPED (raw() not implemented)

- [x] **5.3** Update test `get() returns the same helper instance on repeated calls`:
  - Simplified to test defined tables only

- [x] **5.4** Update test `has() checks if defined table has data`:
  - Returns `false` for undefined tables (doesn't check Y.Array)

- [x] **5.5** Update test `names() returns defined table names that have data`:
  - Only returns defined tables, not all Y.Arrays

- [x] **5.6** All 50 table tests pass:
  ```bash
  bun test packages/epicenter/src/dynamic/tables/
  # 50 pass, 0 fail
  ```

### Phase 6: Update Type Tests

**File: `packages/epicenter/src/dynamic/tables/create-tables.types.test.ts`**

- [x] **6.1** Existing type tests pass (they use defined tables)
- [x] **6.2** TypeScript now correctly rejects undefined table names at compile-time
  - Test uses `as any` to test runtime behavior

### Phase 7: Documentation Updates

- [x] **7.1** `packages/epicenter/README.md`: No changes needed
  - README documents `tables.get()` with defined table names
  - No mention of "untyped" or dynamic table access

- [ ] **7.2** Spec files that reference `UntypedTableHelper` are historical documentation
  - These specs document past thinking and are kept for reference
  - No updates needed (they reflect the state at time of writing)

## Edge Cases

### Accessing Undefined Table with Static Schema

1. User defines workspace with `['posts', 'users']`
2. User calls `tables.get('comments')`
3. **New behavior**: Throws with helpful error message
4. **Migration path**: Use `tables.raw('comments')` if intentional

### Dynamic Schema from JSON

1. Schema loaded from JSON at runtime
2. TypeScript types are loose (`TableDefinition[]` not literal)
3. **Behavior**: Overload resolves to loose helper type
4. **Runtime**: Still validates against TypeBox schema
5. **If table not in JSON schema**: Still throws (consistent behavior)

### Data Exists for Table Not in Schema

1. YJS document has `table:legacy` from previous sync
2. Current schema doesn't define `legacy`
3. **Old behavior**: `tables.get('legacy')` returns untyped helper silently
4. **New behavior**: `tables.get('legacy')` throws
5. **Access path**: `tables.raw('legacy').getAll()` works for inspection

### Extension (SQLite/Markdown) Access

1. Extensions iterate tables using `tables.definitions`
2. Call `tables.get(tableDef.id)` for each
3. **No change needed**: Always use defined table names

## Open Questions

1. **Should `raw()` helpers be cached?**
   - Options: (a) Cache like typed helpers, (b) Create fresh each time
   - **Recommendation**: Create fresh. Raw access is for debugging; caching adds complexity for little benefit.

2. **Should `raw()` support write operations?**
   - Options: (a) Read-only, (b) Full CRUD
   - **Recommendation**: Read-only for now. Writes without validation are dangerous. Can extend later if needed.

3. **Error message format for undefined tables?**
   - **Recommendation**: Include table name, list of valid tables, and suggestion to use `raw()`.

4. **Should we add a way to create helpers without schema for dynamic tables?**
   - This would be for cases where you want to write to a table not in definition
   - **Recommendation**: Defer. Force schema-first approach. If truly needed, can add `tables.dynamic(name)` later.

## Success Criteria

- [x] `UntypedTableHelper` type no longer exists in codebase
- [x] `createUntypedTableHelper` function no longer exists
- [x] `tables.get('unknown')` throws helpful error (not silent fallback)
- [x] All existing tests pass (with updated expectations) - 50 tests passing
- [x] Type inference works for both static (`as const`) and dynamic schemas
- [x] Extensions (SQLite, Markdown) still work correctly (use defined table names)
- [x] Typecheck passes (pre-existing errors in cli.test.ts unrelated)
- [x] Tests pass: `bun test packages/epicenter/src/dynamic/tables/`

**Deferred**:

- [ ] `tables.raw('unknown')` works for schema-less inspection (not implemented)

## References

- `packages/epicenter/src/dynamic/tables/table-helper.ts` - Main implementation to modify
- `packages/epicenter/src/dynamic/tables/create-tables.ts` - `TablesFunction` type and `get()` logic
- `packages/epicenter/src/dynamic/tables/create-tables.test.ts` - Tests to update
- `packages/epicenter/src/dynamic/tables/create-tables.types.test.ts` - Type tests
- `packages/epicenter/src/dynamic/index.ts` - Exports to update
- `packages/epicenter/src/extensions/sqlite/sqlite.ts` - Consumer to verify (uses `tables.get`)
- `packages/epicenter/src/extensions/markdown/markdown.ts` - Consumer to verify (uses `tables.get`)

---

## Review

**Completed**: 2026-02-02

### Summary of Changes

Removed `UntypedTableHelper` and `createUntypedTableHelper` to enforce schema-first design.

| File                    | Lines Removed | Lines Added | Change                                                                    |
| ----------------------- | ------------- | ----------- | ------------------------------------------------------------------------- |
| `table-helper.ts`       | ~263          | 0           | Deleted `UntypedTableHelper` type and `createUntypedTableHelper` function |
| `create-tables.ts`      | ~60           | ~20         | Updated `get()` to throw, simplified `has()`, `names()`, `toJSON()`       |
| `create-tables.test.ts` | ~20           | ~25         | Updated test expectations for new behavior                                |

**Total**: -381 lines, +64 lines (net -317 lines)

### Key Decisions Made During Implementation

1. **Simplified from original spec**: The `tables.raw()` escape hatch was deferred. The original spec proposed adding raw access for debugging/migration, but we decided to enforce schema-first design instead. If a table isn't defined, you shouldn't access it.

2. **TypeScript compile-time safety**: With the changes, TypeScript now correctly rejects undefined table names at compile-time (when using `as const`). Tests use `as any` to test runtime error handling.

3. **Behavioral clarification**: The distinction was never about "typed" vs "untyped" TypeScript types. It was about whether runtime validation happened. Now validation always happens (if you can access a table, it has a schema).

### What Works Now

- `tables.get('posts')` - Returns typed helper with validation (unchanged)
- `tables.get('unknown')` - Throws clear error with available table names
- `tables.has('unknown')` - Returns `false` (doesn't check Y.Array)
- `tables.names()` - Returns only defined tables that have data

### Migration Path

If you were relying on accessing tables not in the definition:

1. **Add the table to your definition** (preferred)
2. If truly needed for migration tooling, the `tables.raw()` API can be added later
