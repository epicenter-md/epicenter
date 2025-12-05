# Parser Validation Refactor

## Goal
Refactor `parseMarkdownWithValidation` to:
1. Use `createRow()` and `row.validate()` for validation (instead of manual validation)
2. Simplify return type to union of parse error and `RowValidationResult`
3. Support `bodyField` parameter to merge markdown body content into row data

## Current Behavior

### Reading (markdown → YJS)
In `index.ts` lines 605-616:
```typescript
case 'success':
  const rowData = tableConfig?.bodyField
    ? {
        ...parseResult.data,
        [tableConfig.bodyField]: parseResult.content,
      }
    : parseResult.data;
```

### Writing (YJS → markdown)
In `index.ts` lines 376-395:
```typescript
const frontmatter = Object.fromEntries(
  Object.entries(serialized).filter(([key, value]) => {
    const isBodyField = key === bodyFieldKey;
    if (isBodyField) return false; // Exclude from frontmatter
    // ...
  }),
);
const content = bodyFieldKey ? serialized[bodyFieldKey] : '';
```

## Changes

### 1. Update `ParseMarkdownResult` type
**Before:**
```typescript
type ParseMarkdownResult<T> =
  | { status: 'failed-to-parse', error: MarkdownError }
  | { status: 'failed-to-validate', validationResult: RowValidationResult, data: unknown }
  | { status: 'success', data: T, content: string }
```

**After:**
```typescript
type ParseMarkdownResult<T> =
  | { status: 'failed-to-parse', error: MarkdownError }
  | RowValidationResult<T>
```

### 2. Update `parseMarkdownWithValidation` signature
**Before:**
```typescript
async function parseMarkdownWithValidation<T extends Row>(
  filePath: string,
  schema: TableSchema,
): Promise<ParseMarkdownResult<T>>
```

**After:**
```typescript
async function parseMarkdownWithValidation<T extends Row>({
  filePath,
  schema,
  bodyField,
}: {
  filePath: string;
  schema: TableSchema;
  bodyField?: string;
}): Promise<ParseMarkdownResult<T>>
```

### 3. Update implementation logic

**Steps:**
1. Parse markdown file (frontmatter + content)
2. If parsing fails → return `{ status: 'failed-to-parse', error }`
3. Validate data is an object
4. If `bodyField` is provided, merge content: `{ ...data, [bodyField]: content }`
5. Create YRow from the merged data (convert strings to Y.Text, arrays to Y.Array)
6. Create Row proxy with `createRow({ yrow, schema })`
7. Call `row.validate()` and return the result directly

### 4. Update callers in `index.ts`

**Line 569-571:** Add `bodyField` parameter
```typescript
const parseResult = await parseMarkdownWithValidation({
  filePath,
  schema: tableSchema,
  bodyField: tableConfig?.bodyField,
});
```

**Lines 574-633:** Update switch statement
- Remove `'failed-to-validate'` case
- Add `'invalid-structure'` case
- Add `'schema-mismatch'` case
- Change `'success'` to `'valid'`
- Remove the manual merge of `parseResult.content` (now done in parser)

## Benefits
1. **Consistency**: Use the same validation logic everywhere (`row.validate()`)
2. **Simplicity**: Return type is just parse error OR validation result
3. **No duplication**: Content is merged once in parser, not in caller
4. **Type safety**: Validation statuses match `RowValidationResult` exactly

## Todo
- [ ] Update `ParseMarkdownResult` type
- [ ] Update `parseMarkdownWithValidation` signature and implementation
- [ ] Update caller in `registerFileWatcher` to pass `bodyField`
- [ ] Update caller in `registerFileWatcher` to handle new status cases
- [ ] Remove old manual validation logic
- [ ] Test with bodyField and without bodyField

## Review

### Implementation Complete

All changes have been successfully implemented:

1. **Type Simplification**: `ParseMarkdownResult` is now just a union of parse error OR `RowValidationResult`
   - Removed the intermediate `failed-to-validate` wrapper
   - Removed the `success` status in favor of `valid`
   - Status types now match exactly: `failed-to-parse | invalid-structure | schema-mismatch | valid`

2. **New Function**: `createRowFromJSON` in schema.ts:
   - Takes a `SerializedRow` (output of `toJSON()`) and converts it back to a `Row`
   - Converts plain values to Y.js types: strings → Y.Text, arrays → Y.Array
   - Centralizes the serialization/deserialization logic
   - Used by both parser and potentially other parts of the system

3. **Parser Refactor**: `parseMarkdownWithValidation` now:
   - Accepts destructured params: `{ filePath, schema, bodyField? }`
   - Merges markdown body content into row data at `bodyField` (if provided)
   - Uses `createRowFromJSON()` + `row.validate()` for consistent validation
   - Returns validation result directly (no content wrapper)
   - Much simpler: only 12 lines of logic

4. **Caller Update**: `registerFileWatcher` in index.ts now:
   - Passes `bodyField: tableConfig?.bodyField` (optional)
   - Handles all four validation statuses properly
   - No longer manually merges content (done in parser)

### Architecture Improvements

1. **New Utility Functions**:
   - `updateYTextFromString()`: Renamed from `syncYTextToDiff` for clarity
   - `updateYArrayFromArray()`: Renamed from `syncYArrayToDiff` for clarity
   - `updateYRowFromSerializedRow()`: New utility to update YRow from plain JS object with minimal diffs
   - `isSerializedCellValue()`: Type guard for validating serialized cell values
   - `isSerializedRow()`: Type guard for validating serialized rows

2. **Parser Enhancement**:
   - Accepts optional `yrow` parameter for updating existing rows
   - Uses `isSerializedRow()` to validate parsed data structure
   - Calls `updateYRowFromSerializedRow()` for unified conversion logic
   - Updates existing YRow in place or creates new one

3. **Eliminated Redundancy**:
   - Removed `updateYJSRowFromMarkdown()` function (135 lines deleted!)
   - Parser now handles both creation and update scenarios
   - No duplicate conversion logic between parser and index

### Key Benefits

- **Consistency**: All validation uses the same `row.validate()` logic
- **Simplicity**: No duplication of validation status types or conversion logic
- **Minimal Diffs**: Updates use character/element-level diffs, not full replacement
- **Single Responsibility**: Parser handles content merging and YRow updates
- **Type Safety**: Return type is straightforward union without nesting
- **Reusability**: Utility functions can be used across the codebase
- **Preserves Extra Fields**: Non-schema fields in markdown frontmatter are preserved

### Breaking Changes

- `parseMarkdownWithValidation` signature changed to use destructured params
- Return type changed from 3 statuses to 4 (split validation failures into 2 types)
- Content no longer returned separately (merged into row data if `bodyField` provided)

### Behavior Notes

- `bodyField` is optional: if not provided, only frontmatter is parsed
- When `bodyField` is provided, markdown body content is merged into row data at that field
- This matches the existing write behavior where `bodyField` controls whether body content is extracted
