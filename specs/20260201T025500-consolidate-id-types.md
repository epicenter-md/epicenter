# Specification: Consolidate Row ID Types

**Date**: 2026-02-01
**Status**: Implemented
**Scope**: `packages/epicenter/src/`

## Problem Statement

The codebase has two overlapping branded types for row identifiers:

1. **`Id`** (`core/schema/fields/id.ts:23`) - Generated row IDs (10-char nanoid)
2. **`RowId`** (`dynamic/tables/keys.ts:16`) - Storage-layer branded IDs with colon validation

This creates confusion:

- The `Id` brand is immediately lost when entering table operations (typed as `string`)
- `RowId` re-validates what `generateId()` already guarantees (no colons in alphabet)
- Two brands for the same domain concept

## Solution

Consolidate to a single `Id` type that:

1. Is returned by `generateId()` (existing)
2. Can be constructed from arbitrary strings via `Id()` constructor (new)
3. Validates no colons (moved from `RowId`)
4. Is used throughout the table system instead of `string`

**Delete `RowId`** - it becomes unnecessary.

## Design Decisions

### Why require `Id` instead of accepting `string`?

- **Type safety**: Prevents accidentally passing wrong identifiers
- **Explicit intent**: Users must acknowledge they're creating an ID
- **Colon validation**: Caught at construction time, not deep in storage layer

### Why add `Id()` constructor?

- **Testing**: Allows `Id('test-1')` instead of requiring `generateId()` everywhere
- **Migration**: Existing string IDs can be wrapped
- **Flexibility**: User-defined IDs remain supported (with validation)

### What about `FieldId`?

Keep `FieldId` unchanged. It serves a different purpose (column identifiers from schema) and remains internal to the keys module.

## Files to Change

### Phase 1: Add `Id()` Constructor

**File: `packages/epicenter/src/core/schema/fields/id.ts`**

Add constructor function with colon validation:

````typescript
// After line 23 (after type Id definition)

/**
 * Create a branded Id from an arbitrary string.
 *
 * Validates that the string does not contain ':' (reserved for cell-key separator).
 * Use this when you have a string ID that needs to be used as a row identifier.
 *
 * @param value - The string to brand as an Id
 * @returns A branded Id
 * @throws If the value contains ':'
 *
 * @example
 * ```typescript
 * const id = Id('my-custom-id');
 * const generated = generateId(); // Also returns Id
 * ```
 */
export function Id(value: string): Id {
	if (value.includes(':')) {
		throw new Error(`Id cannot contain ':': "${value}"`);
	}
	return value as Id;
}
````

Export from `core/schema/index.ts`:

```typescript
// Change line 37-38 from:
export type { Guid, Id } from './fields/id.js';
export { generateGuid, generateId } from './fields/id.js';

// To:
export type { Guid, Id } from './fields/id.js';
export { generateGuid, generateId, Id } from './fields/id.js';
```

### Phase 2: Update Core Types

**File: `packages/epicenter/src/core/schema/fields/types.ts`**

1. Add import for `Id` type (line ~36):

```typescript
import type { Id } from './id.js';
```

2. Change `CellValue<IdField>` (line 459-460):

```typescript
// From:
export type CellValue<C extends Field = Field> = C extends IdField
  ? string

// To:
export type CellValue<C extends Field = Field> = C extends IdField
  ? Id
```

3. Change `PartialRow` (line 595-597):

```typescript
// From:
export type PartialRow<TFields extends readonly Field[] = readonly Field[]> = {
	id: string;
} & Partial<Omit<Row<TFields>, 'id'>>;

// To:
export type PartialRow<TFields extends readonly Field[] = readonly Field[]> = {
	id: Id;
} & Partial<Omit<Row<TFields>, 'id'>>;
```

### Phase 3: Update Table Helper

**File: `packages/epicenter/src/dynamic/tables/table-helper.ts`**

1. Add import for `Id` (around line 27):

```typescript
import { Id } from '../../core/schema/fields/id.js';
```

2. Change `InvalidRowResult` (line 68-73):

```typescript
export type InvalidRowResult = {
	status: 'invalid';
	id: Id; // was: string
	errors: ValidationError[];
	row: unknown;
};
```

3. Change `NotFoundResult` (line 79-83):

```typescript
export type NotFoundResult = {
	status: 'not_found';
	id: Id; // was: string
	row: undefined;
};
```

4. Change `UpdateManyResult` (line 115-122):

```typescript
export type UpdateManyResult =
	| { status: 'all_applied'; applied: Id[] } // was: string[]
	| {
			status: 'partially_applied';
			applied: Id[]; // was: string[]
			notFoundLocally: Id[]; // was: string[]
	  }
	| { status: 'none_applied'; notFoundLocally: Id[] }; // was: string[]
```

5. Change `DeleteManyResult` (line 142-149):

```typescript
export type DeleteManyResult =
	| { status: 'all_deleted'; deleted: Id[] } // was: string[]
	| {
			status: 'partially_deleted';
			deleted: Id[]; // was: string[]
			notFoundLocally: Id[]; // was: string[]
	  }
	| { status: 'none_deleted'; notFoundLocally: Id[] }; // was: string[]
```

6. Change `ChangedRowIds` (line 162):

```typescript
export type ChangedRowIds = Set<Id>; // was: Set<string>
```

7. Change `TRow` in `createTableHelper` (line 187):

```typescript
type TRow = Row<TTableDef['fields']> & { id: Id }; // was: { id: string }
```

8. Update internal functions - replace `validateId(rowData.id, 'RowId')` and `RowId(rowData.id)` patterns with just using `Id()`:

In `setRowCells` (around line 237-244):

```typescript
// From:
function setRowCells(rowData: { id: string } & Record<string, unknown>): void {
  validateId(rowData.id, 'RowId');
  const rowId = RowId(rowData.id);
  ...
}

// To:
function setRowCells(rowData: { id: Id } & Record<string, unknown>): void {
  // Id already validated at construction time
  for (const [fieldId, value] of Object.entries(rowData)) {
    const cellKey = CellKey(rowData.id, FieldId(fieldId));
    ...
  }
}
```

9. Update method signatures:

- `get(id: string)` → `get(id: Id)` (line 316)
- `has(id: string)` → `has(id: Id)` (line 351)
- `delete(id: string)` → `delete(id: Id)` (line 355)

### Phase 4: Update Keys Module

**File: `packages/epicenter/src/dynamic/tables/keys.ts`**

1. Import `Id` from core:

```typescript
import type { Id } from '../../core/schema/fields/id.js';
```

2. Delete `RowId` type and function (lines 5-79)

3. Update `CellKey` type (line 43):

```typescript
// From:
export type CellKey = `${RowId}${typeof KEY_SEPARATOR}${FieldId}`;

// To:
export type CellKey = `${Id}${typeof KEY_SEPARATOR}${FieldId}`;
```

4. Update `RowPrefix` type (line 58):

```typescript
// From:
export type RowPrefix = `${RowId}${typeof KEY_SEPARATOR}`;

// To:
export type RowPrefix = `${Id}${typeof KEY_SEPARATOR}`;
```

5. Update `CellKey` function (line 118):

```typescript
// From:
export function CellKey(rowId: RowId, fieldId: FieldId): CellKey;

// To:
export function CellKey(rowId: Id, fieldId: FieldId): CellKey;
```

6. Update `RowPrefix` function (line 138):

```typescript
// From:
export function RowPrefix(rowId: RowId): RowPrefix;

// To:
export function RowPrefix(rowId: Id): RowPrefix;
```

7. Update `parseCellKey` return type (line 159):

```typescript
// From:
export function parseCellKey(key: string): { rowId: RowId; fieldId: FieldId }

// To:
export function parseCellKey(key: string): { rowId: Id; fieldId: FieldId }

// And inside the function, change:
return {
  rowId: RowId(rowIdStr),  // From
  rowId: Id(rowIdStr),     // To
  ...
}
```

8. Keep `validateId` for `FieldId` usage, or inline it.

### Phase 5: Update UntypedTableHelper

**File: `packages/epicenter/src/dynamic/tables/table-helper.ts`** (continued)

Update `UntypedTableHelper` type (lines 516-548) - change all `id: string` to `id: Id`:

```typescript
export type UntypedTableHelper = {
	update(partialRow: { id: Id } & Record<string, unknown>): UpdateResult;
	upsert(rowData: { id: Id } & Record<string, unknown>): void;
	upsertMany(rows: ({ id: Id } & Record<string, unknown>)[]): void;
	updateMany(rows: ({ id: Id } & Record<string, unknown>)[]): UpdateManyResult;
	get(id: Id): GetResult<{ id: Id } & Record<string, unknown>>;
	// ... etc
	inferRow: { id: Id } & Record<string, unknown>;
};
```

Update `createUntypedTableHelper` similarly (lines 557+).

### Phase 6: Update Tests

**Files: `packages/epicenter/src/dynamic/tables/*.test.ts`**

All hardcoded string IDs need to be wrapped:

```typescript
// From:
tables.get('posts').upsert({ id: 'post-1', title: 'Test' });

// To:
tables.get('posts').upsert({ id: Id('post-1'), title: 'Test' });
```

This affects approximately 40-50 test locations across:

- `create-tables.test.ts`
- `create-tables.crdt-sync.test.ts`
- `create-tables.offline-sync.test.ts`

### Phase 7: Update Exports

**File: `packages/epicenter/src/dynamic/index.ts`**

No changes needed - `RowId` was never exported.

**File: `packages/epicenter/src/index.ts`**

Ensure `Id` constructor is exported (should flow through from `core/schema/index.ts`).

## Migration Path

### For Internal Code

The TypeScript compiler will catch all breaking changes. Fix them mechanically.

### For External Consumers

This is a **breaking change** for anyone using the table API:

```typescript
// Before (accepted)
tables.get('posts').upsert({ id: 'my-id', ... });

// After (required)
import { Id } from '@epicenter/hq';
tables.get('posts').upsert({ id: Id('my-id'), ... });
// OR
tables.get('posts').upsert({ id: generateId(), ... });
```

Consider adding a deprecation period or major version bump.

## Verification Checklist

- [x] `bun run typecheck` passes in `packages/epicenter`
- [x] `bun test` passes in `packages/epicenter`
- [x] `Id('valid-id')` returns branded `Id`
- [x] `Id('invalid:id')` throws error
- [x] `generateId()` returns `Id` (unchanged)
- [x] `CellKey(Id('row'), FieldId('col'))` works
- [x] No references to `RowId` type or function remain
- [x] All test IDs wrapped with `Id()`

## Implementation Notes

**Completed**: 2026-02-01

Key changes made:
1. Added `Id()` constructor function with colon validation in `core/schema/fields/id.ts`
2. Updated `CellValue<IdField>` to return `Id` instead of `string`
3. Updated `PartialRow.id` to use `Id` type
4. Deleted `RowId` type and function from `dynamic/tables/keys.ts`
5. Updated all table helper types (`InvalidRowResult`, `NotFoundResult`, `UpdateManyResult`, `DeleteManyResult`, `ChangedRowIds`)
6. Updated extensions (`sqlite`, `markdown`) to convert string IDs to branded `Id` at deserialization boundaries
7. Updated `server/tables.ts` to wrap URL params with `Id()`
8. Updated all test files to use `Id()` constructor
9. Exported `Id` function from package root (`@epicenter/hq`)

Related commits:
- `1b65057a3` - Removed duplicate `dynamic/keys.ts` and public API exports of key utilities

## Rollback Plan

If issues arise, revert the commits. The change is atomic and contained within `packages/epicenter`.

## Open Questions

1. **Should `ChangedRowIds` stay as `Set<Id>` or become `Set<string>`?**
   - Recommend `Set<Id>` for consistency
   - Callers can use the ID directly with `table.get(id)`

2. **Should we export `Id` from the main package entry?**
   - Yes, it's now required for all row operations

3. **Should there be an `unsafeId()` that skips validation?**
   - Not recommended; validation is cheap and prevents bugs
