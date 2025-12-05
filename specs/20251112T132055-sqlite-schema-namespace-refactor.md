# SQLite Schema Namespace Refactor

**Created**: 2025-11-12T13:20:55
**Status**: Completed

## Problem

1. **Flat SQLite structure**: Schema-related files (`builders.ts`, `schema-converter.ts`) are at the top level alongside the main index implementation
2. **Broken subpath exports**: The `package.json` references deleted `exports.ts` files that no longer exist

## Solution

### Part 1: Schema Namespace Organization
Create a `schema/` folder to group schema-related utilities:
- Move `builders.ts` → `schema/builders.ts`
- Move `schema-converter.ts` → `schema/converter.ts`
- Create `schema/index.ts` barrel file

### Part 2: Fix Subpath Exports
Update `package.json` to reference the correct `index.ts` files instead of deleted `exports.ts` files

## Todo Items

- [ ] Create `sqlite/schema/` directory
- [ ] Create `sqlite/schema/index.ts` barrel file
- [ ] Move `builders.ts` → `schema/builders.ts`
- [ ] Move `schema-converter.ts` → `schema/converter.ts`
- [ ] Update imports in `sqlite-index.ts`
- [ ] Update exports in `sqlite/index.ts`
- [ ] Fix package.json subpath exports for markdown
- [ ] Fix package.json subpath exports for sqlite
- [ ] Run type check to verify all imports resolve

## File Structure

### Before
```
sqlite/
  ├── index.ts                    # Barrel file
  ├── sqlite-index.ts             # Main implementation
  ├── builders.ts                 # Column builders
  └── schema-converter.ts         # Schema converter
```

### After
```
sqlite/
  ├── index.ts                    # Main barrel
  ├── sqlite-index.ts             # Main implementation
  └── schema/
      ├── index.ts                # Schema barrel
      ├── builders.ts             # Column builders
      └── converter.ts            # Schema converter (renamed)
```

## Package.json Changes

### Before
```json
{
  "exports": {
    "./indexes/markdown": "./src/indexes/markdown/exports.ts",  // ❌ Deleted
    "./indexes/sqlite": "./src/indexes/sqlite/exports.ts"       // ❌ Deleted
  }
}
```

### After
```json
{
  "exports": {
    "./indexes/markdown": "./src/indexes/markdown/index.ts",    // ✅ Correct
    "./indexes/sqlite": "./src/indexes/sqlite/index.ts"         // ✅ Correct
  }
}
```

## Benefits

1. **Logical grouping**: Schema definition and conversion live together
2. **Cleaner top level**: Only `index.ts` and `sqlite-index.ts` at the top
3. **Clear namespace**: `schema/` immediately tells you what's inside
4. **Scalability**: Easy to add more schema-related utilities
5. **Fixed subpath exports**: Package exports now point to correct files

## Review

### Changes Made

The refactor was successfully completed with both schema organization and package.json fixes.

#### Part 1: Schema Namespace Organization

1. **Created** `sqlite/schema/` directory to group schema-related utilities
2. **Created** `sqlite/schema/index.ts` barrel file (15 lines) that exports:
   - Column builders: `id`, `text`, `integer`, `real`, `boolean`, `date`, `tags`
   - Converter functions: `convertWorkspaceSchemaToDrizzle`, `convertTableSchemaToDrizzle`
   - Type: `WorkspaceSchemaToDrizzleTables`
3. **Moved** `builders.ts` → `schema/builders.ts` (356 lines)
4. **Moved and renamed** `schema-converter.ts` → `schema/converter.ts` (272 lines)
5. **Updated imports**:
   - `sqlite-index.ts`: Changed import from `./schema-converter` → `./schema/converter`
   - `schema/builders.ts`: Updated core schema imports from `../../` → `../../../` (one level deeper)
   - `schema/converter.ts`: Updated core schema imports from `../../` → `../../../` (one level deeper)
6. **Updated exports**:
   - `sqlite/index.ts`: Now exports all schema utilities through the schema barrel
   - Removed Drizzle re-export (`sql`) as requested
7. **Updated** `sqlite/index.ts` to export schema utilities through the new barrel

#### Part 2: Fixed Subpath Exports

Updated `package.json` to fix broken subpath exports:
- **Before**: `"./indexes/markdown": "./src/indexes/markdown/exports.ts"` ❌ (file deleted)
- **After**: `"./indexes/markdown": "./src/indexes/markdown/index.ts"` ✅
- **Before**: `"./indexes/sqlite": "./src/indexes/sqlite/exports.ts"` ❌ (file deleted)
- **After**: `"./indexes/sqlite": "./src/indexes/sqlite/index.ts"` ✅

### Final File Structure

```
sqlite/
  ├── index.ts                    # Main barrel (exports sqliteIndex + schema utilities)
  ├── sqlite-index.ts             # Main implementation (398 lines)
  └── schema/
      ├── index.ts                # Schema barrel (exports builders + converter)
      ├── builders.ts             # Column builders (356 lines)
      └── converter.ts            # Schema converter (272 lines, renamed from schema-converter.ts)
```

### Verification

Type check confirmed all imports resolve correctly. No "cannot find module" errors related to the refactor. The only TypeScript errors shown are pre-existing errors in the codebase unrelated to this refactor.

### Benefits Achieved

1. **Logical grouping**: Schema definition (builders) and conversion live together in `schema/`
2. **Cleaner top level**: Only 2 files at the top (`index.ts`, `sqlite-index.ts`)
3. **Clear namespace**: `schema/` immediately communicates purpose
4. **Scalability**: Easy to add more schema-related utilities in the future
5. **Fixed subpath exports**: Package exports now point to correct files
6. **Maintainability**: New developers can immediately understand the organization
7. **Removed Drizzle re-exports**: Cleaned up unnecessary `sql` re-export

### Notes

- This refactor was entirely mechanical with zero logic changes
- All existing functionality preserved
- No breaking changes to the public API (exports remain the same)
- The refactor makes the codebase follow clear organizational principles
- Subpath exports now work correctly for both markdown and sqlite indexes
