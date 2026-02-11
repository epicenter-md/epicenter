# Spec: Consolidate Cell Key Primitives

## Problem

Three independent implementations of colon-separated compound key encoding (`rowId:columnId`) exist across the codebase:

1. **`dynamic/tables/keys.ts`** -- Branded types (`CellKey`, `FieldId`, `RowPrefix`), regex parsing via `arkregex`, both sides reject colons
2. **`y-cell-store.ts` lines 200-216** -- Private `cellKey()` and `parseCellKey()`, `indexOf`-based, only `rowId` rejects colons
3. **`y-row-store.ts` lines 201-206** -- Private `extractRowId()` and `SEPARATOR`, `indexOf`-based, no validation

All three define their own separator constant (`':'`), their own compose/parse functions, and their own validation. Additionally, `y-row-store.ts` line 333 does inline key construction with template literals (`` `${rowId}${SEPARATOR}${columnId}` ``) instead of using any utility function.

## Solution

Create a single shared module `shared/cell-keys.ts` as the source of truth for all compound key operations. Eliminate `dynamic/tables/keys.ts` entirely -- its branded wrappers don't pull their weight (the branded types immediately widen to `string` at every call site except `parseCellKey` returning `rowId: Id`, which needs only a trivial `Id()` cast).

### Design Decisions

**PascalCase constructors, camelCase utilities**: Functions that return typed values (`CellKey`, `RowPrefix`) use PascalCase to match the codebase's constructor convention (like `Id()`). Functions that return plain strings (`parseCellKey`, `extractRowId`) stay camelCase.

**Template literal types over branded types**: `type RowPrefix = \`${string}:\`` and `type CellKey = \`${RowPrefix}${string}\`` provide self-documenting hover information without the import coupling or constructor ceremony of `wellcrafted/brand`. The branded types from `keys.ts` were not kept.

**No `arkregex` dependency**: The old regex `[^:]+` for fieldId rejected colons in columnId, which was a bug. The `indexOf`-based approach is faster and correctly handles colons in columnId.

### New file: `packages/epicenter/src/shared/cell-keys.ts`

```ts
/**
 * Cell key primitives for compound key encoding.
 *
 * Encodes (rowId, columnId) pairs as colon-separated strings.
 * - rowId MUST NOT contain ':' (validated, throws on violation)
 * - columnId MAY contain ':' (split on first colon only)
 *
 * ## Type Encoding
 *
 * Template literal types encode the structure of each string shape:
 * ```
 * RowPrefix = `${string}:`              <- "row-1:"
 * CellKey   = `${RowPrefix}${string}`   <- "row-1:title"
 * ```
 *
 * ## Naming Convention
 *
 * PascalCase functions (`CellKey`, `RowPrefix`) are constructors that return
 * typed values. camelCase functions (`parseCellKey`, `extractRowId`) are
 * utilities that return plain strings.
 *
 * @module
 */

/** The separator character used in compound cell keys. */
export const KEY_SEPARATOR = ':' as const;

/** A row prefix: `rowId:`. Used for scanning all cells in a row. */
export type RowPrefix = `${string}${typeof KEY_SEPARATOR}`;

/** A compound cell key: `rowId:columnId`. Composed from a RowPrefix + columnId. */
export type CellKey = `${RowPrefix}${string}`;

/** Compose a cell key from rowId and columnId. Throws if rowId contains ':'. */
export function CellKey(rowId: string, columnId: string): CellKey {
	if (rowId.includes(KEY_SEPARATOR)) {
		throw new Error(`rowId cannot contain '${KEY_SEPARATOR}': "${rowId}"`);
	}
	return `${rowId}${KEY_SEPARATOR}${columnId}`;
}

/** Parse a cell key into rowId and columnId. Splits on first ':' only. */
export function parseCellKey(key: string): { rowId: string; columnId: string } {
	const idx = key.indexOf(KEY_SEPARATOR);
	if (idx === -1) throw new Error(`Invalid cell key: "${key}"`);
	return { rowId: key.slice(0, idx), columnId: key.slice(idx + 1) };
}

/** Create a row prefix for scanning all cells in a row. Throws if rowId contains ':'. */
export function RowPrefix(rowId: string): RowPrefix {
	if (rowId.includes(KEY_SEPARATOR)) {
		throw new Error(`rowId cannot contain '${KEY_SEPARATOR}': "${rowId}"`);
	}
	return `${rowId}${KEY_SEPARATOR}`;
}

/** Extract rowId from a cell key. Faster than parseCellKey when columnId isn't needed. */
export function extractRowId(key: string): string {
	const idx = key.indexOf(KEY_SEPARATOR);
	if (idx === -1) throw new Error(`Invalid cell key: "${key}"`);
	return key.slice(0, idx);
}
```

Two types, four functions, one constant, no dependencies.

## Changes by file

### 1. Delete `packages/epicenter/src/dynamic/tables/keys.ts`

Delete the entire file. It provided:
- `FieldId` type + constructor: Eliminated entirely -- field names from `Object.entries` can't contain colons, and `CellKey()` already validates `rowId`
- `CellKey` branded constructor: Replace with `CellKey()` from shared (returns template literal type instead of brand)
- `RowPrefix` branded constructor: Replace with `RowPrefix()` from shared (same)
- `parseCellKey`: Replace with `parseCellKey()` from shared + `Id()` cast on the result

The `arkregex` dependency is eliminated from this module entirely. The old regex `[^:]+` for fieldId rejected colons in columnId, which was a bug -- columnId may legitimately contain colons.

### 2. Update `packages/epicenter/src/dynamic/tables/table-helper.ts`

Replace:
```ts
import { CellKey, FieldId, parseCellKey, RowPrefix } from './keys';
```

With:
```ts
import { CellKey, extractRowId, parseCellKey, RowPrefix } from '../../shared/cell-keys.js';
```

Update call sites:

```ts
// setRowCells:
function setRowCells(rowData: { id: Id } & Record<string, unknown>): void {
	for (const [fieldId, value] of Object.entries(rowData)) {
		ykv.set(CellKey(rowData.id, fieldId), value);
	}
}

// reconstructRow:
function reconstructRow(rowId: Id): Record<string, unknown> | undefined {
	const prefix = RowPrefix(rowId);
	const cells: Record<string, unknown> = {};
	let found = false;
	for (const [key, entry] of ykv.map) {
		if (key.startsWith(prefix)) {
			const { columnId } = parseCellKey(key);
			cells[columnId] = entry.val;
			found = true;
		}
	}
	return found ? cells : undefined;
}

// collectRows:
function collectRows(): Map<Id, Record<string, unknown>> {
	const rows = new Map<Id, Record<string, unknown>>();
	for (const [key, entry] of ykv.map) {
		const { rowId, columnId } = parseCellKey(key);
		const id = Id(rowId);
		const existing = rows.get(id) ?? {};
		existing[columnId] = entry.val;
		rows.set(id, existing);
	}
	return rows;
}

// deleteRowCells:
function deleteRowCells(rowId: Id): boolean {
	const prefix = RowPrefix(rowId);
	// ... rest unchanged
}

// observe handler:
const handler = (...) => {
	const changedIds = new Set<Id>();
	for (const key of changes.keys()) {
		changedIds.add(Id(extractRowId(key)));
	}
	// ...
};
```

Key changes:
- `FieldId(fieldId)` calls removed -- `CellKey()` already validates `rowId`, and field names from `Object.entries` won't contain colons
- `RowPrefix(rowId)` is now a PascalCase function (matching constructor convention), takes plain string, `Id` widens to `string`
- `parseCellKey(key).fieldId` -> `parseCellKey(key).columnId` (property rename)
- `parseCellKey(key).rowId` returns `string` now -- wrap in `Id()` where needed for type safety (2-3 places)
- Use `extractRowId(key)` in the observe handler instead of full `parseCellKey` (slightly faster, only need rowId)

### 3. Update `packages/epicenter/src/shared/y-cell-store.ts`

Delete lines 196-216 (the `KEY UTILITIES (Private)` section: `SEPARATOR`, `cellKey`, `parseCellKey`).

Add import at top:
```ts
import { CellKey, parseCellKey } from './cell-keys.js';
```

All call sites now use `CellKey(...)` (PascalCase) and `parseCellKey(...)` -- no further changes needed in the function body beyond the casing update.

### 4. Update `packages/epicenter/src/shared/y-row-store.ts`

Delete lines 197-206 (the `ROW UTILITIES (Private)` section: `SEPARATOR`, `extractRowId`).

y-row-store.ts was further refactored to use `cellStore.deleteCell()` instead of `ykv.delete(CellKey(...))`. It no longer imports from `cell-keys.ts` at all -- all cell key encoding is delegated to CellStore. The inline template literal key construction (`` `${rowId}${SEPARATOR}${columnId}` ``) and the private `extractRowId` are both eliminated.

Row deletion uses `cellStore.deleteCell(rowId, columnId)` instead of directly constructing keys:
```ts
// BEFORE:
ykv.delete(`${rowId}${SEPARATOR}${columnId}`);

// AFTER:
cellStore.deleteCell(rowId, columnId);
```

Batch delete scans `cellStore.cells()` (which includes pending writes from the same batch) so that merge-then-delete in the same batch correctly removes new columns:
```ts
batch(fn) {
	doc.transact(() => {
		fn({
			merge(rowId, data) {
				for (const [columnId, value] of Object.entries(data)) {
					cellStore.setCell(rowId, columnId, value);
				}
			},
			delete(rowId) {
				for (const cell of cellStore.cells()) {
					if (cell.rowId === rowId) {
						cellStore.deleteCell(rowId, cell.columnId);
					}
				}
			},
		});
	});
},
```

### 5. Create `packages/epicenter/src/shared/cell-keys.test.ts`

Test the four functions:
- `CellKey`: compose, roundtrip, rejects colon in rowId, allows colon in columnId
- `parseCellKey`: parse, first-colon split, throws on no separator
- `RowPrefix`: appends separator, rejects colon in rowId
- `extractRowId`: extracts, throws on no separator

### 6. Check exports

Check if `keys.ts` is re-exported from any barrel files (index.ts). If so, remove those re-exports. The shared `cell-keys.ts` should be exported from the shared barrel if one exists.

## Behavioral changes

1. **`RowPrefix` gains validation**: Current RowStore `rowPrefix` has no validation. Shared version throws if rowId contains ':'. This is strictly an improvement -- the old code would silently produce wrong prefix matches.

2. **`extractRowId` gains error handling**: Current RowStore version returns `key.slice(0, -1)` when no separator found (bug -- `indexOf` returns `-1`). Shared version throws instead.

3. **`FieldId` validation removed from `table-helper`**: Field names coming from `Object.entries(rowData)` are JavaScript property names which can't contain colons in normal usage. The `CellKey()` call still validates `rowId`. If explicit field name validation is desired, it can be a one-line guard in `setRowCells`.

4. **Error messages change**: Dynamic `parseCellKey` currently throws "Invalid cell key format" (regex-based). Shared version throws "Invalid cell key" (indexOf-based). Same intent, different wording.

5. **RowStore `delete`/`batch.delete` gain validation**: Inline `` `${rowId}${SEPARATOR}${columnId}` `` replaced with `cellStore.deleteCell(rowId, columnId)` which delegates to `CellKey()` validation. Previously unvalidated at this call site.

6. **`arkregex` dependency eliminated**: The old regex `[^:]+` for fieldId rejected colons in columnId, which was a bug. The indexOf-based approach is faster and correctly handles colons in columnId.

7. **Branded types replaced with template literal types**: `RowPrefix` and `CellKey` are now template literal types (`\`${string}:\`` and `\`${RowPrefix}${string}\``) instead of branded strings from `wellcrafted/brand`. Same hover documentation, no import coupling.

## Files touched

| File | Action |
|------|--------|
| `packages/epicenter/src/shared/cell-keys.ts` | Create |
| `packages/epicenter/src/shared/cell-keys.test.ts` | Create |
| `packages/epicenter/src/shared/y-cell-store.ts` | Edit (remove private utils, add import, `cellKey` -> `CellKey`) |
| `packages/epicenter/src/shared/y-row-store.ts` | Edit (remove private utils, delegate to `cellStore.deleteCell()`, no cell-keys import) |
| `packages/epicenter/src/dynamic/tables/keys.ts` | Delete |
| `packages/epicenter/src/dynamic/tables/table-helper.ts` | Edit (update imports to shared `cell-keys.js`, PascalCase functions) |
| Any barrel re-exporting `keys.ts` | Edit (remove re-export) |

## Verification

1. `bun test packages/epicenter/src/shared/cell-keys.test.ts` -- new tests pass
2. `bun test packages/epicenter/src/shared/y-cell-store.test.ts` -- existing tests pass
3. `bun test packages/epicenter/src/shared/y-row-store.test.ts` -- existing tests pass
4. `bun test packages/epicenter/src/dynamic/tables/` -- existing tests pass
5. `bun run --filter epicenter typecheck` -- no type errors
6. Full test suite: `bun test packages/epicenter/`
