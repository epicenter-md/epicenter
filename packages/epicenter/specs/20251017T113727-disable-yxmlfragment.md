# Disable Y.XmlFragment Feature

**Date**: 2025-10-17
**Status**: Completed
**Type**: Refactor

## Summary

Temporarily removing Y.XmlFragment (yxmlfragment) functionality from Epicenter. The feature will be kept in git history for future restoration when needed.

## Rationale

### Why Remove?

1. **Conversion Complexity**: Converting between markdown and Y.XmlFragment is non-trivial
   - No built-in parser for plain text/markdown → Y.XmlFragment
   - Requires two-step process: Markdown → HTML/ProseMirror JSON → Y.XmlFragment
   - Requires external libraries (markdown-it, remark, y-prosemirror)
   - Edge cases with nested structures, custom markdown extensions

2. **Lossy Conversion**: Current markdown persistence layer can't properly round-trip Y.XmlFragment
   - Converting Y.XmlFragment to string via `toString()` loses all structure
   - The bidirectional markdown sync already skips Y.XmlFragment ("future work")

3. **Wrong Tool for the Job**: Y.XmlFragment is designed for rich HTML editors (TipTap/ProseMirror)
   - Overkill for markdown-based storage
   - Y.Text is better suited for code/markdown editors with direct string operations

### When to Restore?

Restore Y.XmlFragment when:
- Moving to HTML-based storage instead of markdown
- Implementing rich document editing with TipTap/ProseMirror
- Building a proper HTML ↔ Y.XmlFragment conversion layer

## Research Findings

Based on NIA deep research on Y.XmlFragment:

### Pros
- Tree-structured CRDT matching HTML/XML semantics
- Fine-grained mutation tracking via Y.XmlEvent delta
- Easy conversion to browser DOM via `toDOM()`
- Well-supported by TipTap/ProseMirror bindings
- Better handles element-level operations than flat Y.Text

### Cons
- More complex API than Y.Text
- No built-in parser for HTML/Markdown conversion
- Poor performance for plain-text-heavy use cases
- Higher memory usage (node allocation overhead)
- Cloning/deserialization edge cases

### Conversion Difficulty
- **TO Y.XmlFragment**: Moderately complex (2-step process, external libs)
- **FROM Y.XmlFragment**: Straightforward (`toString()`, tree walker)

## Files Affected

### Core Schema
**File**: `src/core/schema.ts`
- Removed `YxmlfragmentColumnSchema` type (line ~79-82)
- Removed `yxmlfragment()` function and overloads (line ~368-379)
- Removed Y.XmlFragment case from `ColumnSchemaToType` (line ~174-177)
- Removed from `ColumnSchema` union (line ~55)
- Updated JSDoc examples removing yxmlfragment usage (line ~42)

### Validation
**File**: `src/core/validation.ts`
- Removed `value instanceof Y.XmlFragment` check from `isValidCellValue()` (line ~83)
- Removed `case 'yxmlfragment':` block from `validateRow()` (line ~220-232)

### Database Core
**File**: `src/db/core.ts`
- Removed Y.XmlFragment references from JSDoc comments (lines ~58-59, ~75, ~131, ~148, ~157)

### SQLite Index
**File**: `src/indexes/sqlite/index.ts`
- Removed Y.XmlFragment handling from `SQLiteRow` type (lines ~42-45)
- Removed `value instanceof Y.XmlFragment` check from `serializeRowForSQLite()` (line ~65)
- Updated JSDoc comments (lines ~39, ~59)

### SQLite Schema Converter
**File**: `src/indexes/sqlite/schema-converter.ts`
- Removed `YxmlfragmentColumnSchema` import (line ~30)
- Removed Y.XmlFragment case from `ColumnToDrizzle` type (lines ~103-108)
- Removed `case 'yxmlfragment':` from `convertColumnSchemaToDrizzle()` (lines ~207-212)

### Markdown Index
**File**: `src/indexes/markdown/index.ts`
- Removed `case 'yxmlfragment':` block from `updateYJSRowFromMarkdown()` (lines ~140-144)
- Updated JSDoc comment (line ~40)

### Markdown Parser
**File**: `src/indexes/markdown/parser.ts`
- Removed `value instanceof Y.XmlFragment` check from serialization (line ~117)

### Public API
**File**: `src/index.ts`
- Removed `yxmlfragment` export (line ~31)

### Tests
**File**: `src/db/core-types.test.ts`
- Removed all test cases using `yxmlfragment()`:
  - Test "should handle Y.Text and Y.XmlFragment columns" (lines ~23-67)
  - Test "should filter rows with Y.js types" (lines ~182-228)
  - Test "should observe Y.XmlFragment changes" (lines ~302-350)

### Documentation Examples
**File**: `src/core/workspace/config.ts`
- Updated JSDoc example removing yxmlfragment usage (line ~42)

**File**: `src/db/desktop.ts`
- Updated JSDoc example removing Y.XmlFragment reference (line ~45)

## How to Restore

### Quick Restoration via Git Tag

A git tag was created before removal:
```bash
# View the code before removal
git show before-xmlfragment-removal

# Create a branch from that tag
git checkout -b restore-xmlfragment before-xmlfragment-removal

# Or cherry-pick specific files
git checkout before-xmlfragment-removal -- src/core/schema.ts
```

### Manual Restoration

1. **Restore Core Types** (src/core/schema.ts):
   ```typescript
   export type YxmlfragmentColumnSchema<TNullable extends boolean = boolean> = {
     type: 'yxmlfragment';
     nullable: TNullable;
   };

   export function yxmlfragment(opts: { nullable: true }): YxmlfragmentColumnSchema<true>;
   export function yxmlfragment(opts?: { nullable?: false }): YxmlfragmentColumnSchema<false>;
   export function yxmlfragment({
     nullable = false,
   }: {
     nullable?: boolean;
   } = {}): YxmlfragmentColumnSchema<boolean> {
     return {
       type: 'yxmlfragment',
       nullable,
     };
   }
   ```

2. **Add to ColumnSchema union**:
   ```typescript
   export type ColumnSchema =
     | IdColumnSchema
     | TextColumnSchema
     | YtextColumnSchema
     | YxmlfragmentColumnSchema  // Add this back
     | IntegerColumnSchema
     // ... rest
   ```

3. **Restore validation, serialization, and test code** from git history

4. **Implement proper conversion layer** if moving to HTML storage

## Testing Impact

After removal, the following tests were removed:
- Y.XmlFragment column handling test
- Y.XmlFragment filtering test
- Y.XmlFragment observation test

These tests can be restored from git history when the feature is re-enabled.

## Related Documentation

- [Bidirectional Markdown Sync Spec](./20251014T105903%20bidirectional-markdown-sync.md) - Already noted Y.XmlFragment as "future work"
- [Column Schema Naming](../column-schema-naming.md) - Explains yxmlfragment naming convention

## Checklist

- [x] Create spec document
- [x] Create git tag `before-xmlfragment-removal`
- [x] Remove Y.XmlFragment from core schema
- [x] Remove Y.XmlFragment from validation
- [x] Remove Y.XmlFragment from database core
- [x] Remove Y.XmlFragment from SQLite index
- [x] Remove Y.XmlFragment from SQLite schema converter
- [x] Remove Y.XmlFragment from markdown index
- [x] Remove Y.XmlFragment from markdown parser
- [x] Remove Y.XmlFragment from public API
- [x] Remove Y.XmlFragment tests
- [x] Update JSDoc examples
- [x] Create commit with clear message
