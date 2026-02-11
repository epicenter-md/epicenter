# packages/epicenter Type Check Fixes

**Created**: 2026-02-01
**Status**: Draft
**Scope**: Fix all TypeScript errors in `packages/epicenter`

## Summary

The `packages/epicenter` package has 237 type errors across ~15 files. This spec enumerates all error categories and proposes fixes that can be executed in parallel.

## Error Summary by File

| File | Error Count | Category |
|------|-------------|----------|
| `src/dynamic/tables/create-tables.test.ts` | 68 | TRow type inference |
| `src/dynamic/tables/create-tables.crdt-sync.test.ts` | 55 | TRow type inference |
| `src/dynamic/tables/create-tables.offline-sync.test.ts` | 49 | TRow type inference |
| `src/dynamic/tables/create-tables.types.test.ts` | 32 | TRow type inference |
| `scripts/demo-yjs-nested-map-lww.ts` | 8 | Y.Map toJSON typing |
| `src/cli/cli.test.ts` | 5 | Unknown (needs investigation) |
| `scripts/yjs-vs-sqlite-comparison.ts` | 3 | Removed export + WorkspaceDefinition `id` |
| `scripts/yjs-gc-benchmark.ts` | 3 | string \| undefined |
| `scripts/email-storage-simulation.ts` | 3 | Removed export + WorkspaceDefinition `id` |
| `scripts/email-minimal-simulation.ts` | 3 | Removed export + WorkspaceDefinition `id` |
| `src/dynamic/tables/keys.ts` | 2 | string \| undefined handling |
| `src/core/schema/workspace-definition-validator.ts` | 2 | Unused import |
| `scripts/yjs-data-structure-benchmark.ts` | 2 | Unused variables |
| `scripts/ymap-vs-ykeyvalue-benchmark.ts` | 1 | Missing module |
| `scripts/ykeyvalue-write-benchmark.ts` | 1 | Missing module |

## Error Categories

### Category 1: TRow Type Inference (204 errors)

**Affected files**:
- `src/dynamic/tables/create-tables.test.ts`
- `src/dynamic/tables/create-tables.crdt-sync.test.ts`
- `src/dynamic/tables/create-tables.offline-sync.test.ts`
- `src/dynamic/tables/create-tables.types.test.ts`

**Error codes**: TS2353, TS2339, TS2345

**Symptoms**:
```typescript
// TS2353: Object literal may only specify known properties, and 'title' does not exist in type 'TRow'
doc.get('posts').upsert({ id: '1', title: 'Test' });

// TS2339: Property 'title' does not exist on type 'TRow'
expect(row.title).toBe('Test');
```

**Root cause**: The `createTables()` function's generics are not properly inferring the row type from the table definition. `TRow` is resolving to just `{ id: string }` instead of the full row type with all fields.

**Fix options**:

1. **Fix the generic inference in `createTables()`** (preferred)
   - Investigate why generics don't flow from `table()` → `createTables()` → `get()` → row type
   - This is likely a missing `as const` assertion or incorrect generic constraint

2. **Add explicit type annotations in tests** (workaround)
   - Type the `doc` variable explicitly with the expected table types
   - Less ideal because tests should verify type inference works

**Investigation needed**:
- Read `src/dynamic/tables/create-tables.ts` to understand generic structure
- Read `src/core/schema/table.ts` to understand `TableDefinition` type
- Check if there's a missing `as const` in the test files or the implementation

---

### Category 2: Removed Exports (6 errors)

**Affected files**:
- `scripts/email-minimal-simulation.ts`
- `scripts/email-storage-simulation.ts`
- `scripts/yjs-vs-sqlite-comparison.ts`

**Error codes**: TS2305

**Symptom**:
```typescript
// Module '"../src/index"' has no exported member 'createClient'
import { createClient } from '../src/index';
```

**Root cause**: The `createClient` export was removed from the public API. These scripts use an outdated API.

**Fix**: Update scripts to use the new API. Need to determine:
- What replaced `createClient`?
- Are these scripts still needed or can they be deleted?

---

### Category 3: Missing WorkspaceDefinition `id` (3 errors)

**Affected files**:
- `scripts/email-minimal-simulation.ts`
- `scripts/email-storage-simulation.ts`
- `scripts/yjs-vs-sqlite-comparison.ts`

**Error codes**: TS2345

**Symptom**:
```typescript
// Property 'id' is missing in type '{ name: string; ... }' but required in type 'WorkspaceDefinition'
```

**Root cause**: `WorkspaceDefinition` now requires an `id` property that wasn't required before.

**Fix**: Add `id` property to all workspace definitions in these scripts.

---

### Category 4: Implicit `any` on `ctx` parameter (3 errors)

**Affected files**:
- `scripts/email-minimal-simulation.ts:106`
- `scripts/email-storage-simulation.ts:221`
- `scripts/yjs-vs-sqlite-comparison.ts:193`

**Error codes**: TS7006

**Symptom**:
```typescript
// Parameter 'ctx' implicitly has an 'any' type
.withExtensions({ persistence: (ctx) => ... })
```

**Fix**: Add type annotation to `ctx` parameter, e.g., `(ctx: ExtensionContext) => ...`

---

### Category 5: Y.Map `toJSON` typing (8 errors)

**Affected file**: `scripts/demo-yjs-nested-map-lww.ts`

**Error codes**: TS2339

**Symptom**:
```typescript
// Property 'toJSON' does not exist on type '{}'
doc1Nested.get('user').toJSON()
```

**Root cause**: `Y.Map.get()` returns `T | undefined` where T defaults to `{}`. The type doesn't include Yjs methods.

**Fix**: Cast to `Y.Map` or use type assertion, e.g.:
```typescript
(doc1Nested.get('user') as Y.Map<unknown>).toJSON()
```

---

### Category 6: `string | undefined` not assignable to `string` (5 errors)

**Affected files**:
- `src/dynamic/tables/keys.ts:168-169`
- `scripts/yjs-gc-benchmark.ts:93, 130, 134`

**Error codes**: TS2345

**Symptom**:
```typescript
// In parseCellKey():
const [rowIdStr, fieldIdStr] = parts; // parts[0] and parts[1] could be undefined
return { rowId: RowId(rowIdStr), fieldId: FieldId(fieldIdStr) }; // Error!
```

**Fix for keys.ts**:
```typescript
const [rowIdStr, fieldIdStr] = parts;
if (!rowIdStr || !fieldIdStr) {
  throw new Error(`Invalid cell key format: "${key}"`);
}
return { rowId: RowId(rowIdStr), fieldId: FieldId(fieldIdStr) };
```

**Fix for yjs-gc-benchmark.ts**: Add nullish checks or assertions.

---

### Category 7: Unused Variables (2 errors)

**Affected file**: `scripts/yjs-data-structure-benchmark.ts`

**Error codes**: TS6133

**Symptom**:
```typescript
// 'COLUMNS' is declared but its value is never read
// 'doc' is declared but its value is never read
```

**Fix**: Either use the variables, prefix with `_`, or delete them.

---

### Category 8: Unused Import (2 errors)

**Affected file**: `src/core/schema/workspace-definition-validator.ts`

**Error codes**: TS2614, TS6133

**Symptom**:
```typescript
// Module '"typebox/compile"' has no exported member 'TCompileReturn'
import { Compile, type TCompileReturn } from 'typebox/compile';
```

**Root cause**: `TCompileReturn` doesn't exist in this version of typebox, and it's not used anyway.

**Fix**: Remove the unused import:
```typescript
import { Compile } from 'typebox/compile';
```

---

### Category 9: Missing Module (2 errors)

**Affected files**:
- `scripts/ymap-vs-ykeyvalue-benchmark.ts`
- `scripts/ykeyvalue-write-benchmark.ts`

**Error codes**: TS2307

**Symptom**:
```typescript
// Cannot find module '../src/core/utils/y-keyvalue'
```

**Root cause**: The `y-keyvalue` module was moved or deleted.

**Fix options**:
1. Update import path if module was moved
2. Delete scripts if they're obsolete

---

### Category 10: CLI Test Errors (5 errors)

**Affected file**: `src/cli/cli.test.ts`

**Investigation needed**: Extract specific errors from typecheck output.

---

## Execution Plan

### Phase 1: Quick Fixes (can run in parallel)

These are straightforward fixes that don't require investigation:

1. **Fix workspace-definition-validator.ts** - Remove unused `TCompileReturn` import
2. **Fix keys.ts** - Add nullish checks for destructured array elements
3. **Fix yjs-data-structure-benchmark.ts** - Prefix or remove unused variables
4. **Fix demo-yjs-nested-map-lww.ts** - Add Y.Map type assertions

### Phase 2: Script Updates (can run in parallel)

These scripts need API updates:

1. **Update email-minimal-simulation.ts** - New API + add workspace `id`
2. **Update email-storage-simulation.ts** - New API + add workspace `id`
3. **Update yjs-vs-sqlite-comparison.ts** - New API + add workspace `id`
4. **Update yjs-gc-benchmark.ts** - Add nullish checks
5. **Evaluate ykeyvalue benchmarks** - Delete or update based on module location

### Phase 3: Core Type Inference Fix

This is the critical fix affecting 204 errors:

1. **Investigate `createTables()` generic inference**
2. **Fix type inference** so `TRow` properly includes all fields from table definition
3. **Verify tests pass** without needing explicit type annotations

---

## Decision Points

### Decision 1: Script Disposition

For scripts using removed APIs, choose one:
- **A) Update scripts** to use new API
- **B) Delete scripts** if they're obsolete demo code
- **C) Move to archive** folder for reference

**Recommendation**: Audit each script's purpose before deciding.

### Decision 2: TRow Fix Location

For the 204 type inference errors, choose one:
- **A) Fix in createTables()** - Correct generic inference at source
- **B) Fix in tests** - Add explicit type annotations as workaround

**Recommendation**: Fix at source (option A) to ensure the library provides good type inference for users.

---

## Notes

- Total error count: 237
- Unique error codes: TS2305, TS2307, TS2339, TS2345, TS2353, TS2614, TS6133, TS7006, TS2769
- Most errors (86%) are from TRow type inference issues in test files
