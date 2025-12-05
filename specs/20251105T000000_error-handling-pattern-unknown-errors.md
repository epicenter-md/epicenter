# Error Handling Pattern for Unknown Errors in trySync/tryAsync

**Created**: 2025-11-05
**Status**: Implemented

## Overview

This specification defines the correct pattern for handling errors of type `unknown` in `trySync` and `tryAsync` catch handlers. Based on updates to the WellCrafted library, error constructors should no longer receive `cause: error` when the caught error is type `unknown`.

## The Pattern

### Before (Incorrect)
```typescript
await tryAsync({
  try: async () => {
    const result = await externalOperation();
    return result;
  },
  catch: (error) =>
    ServiceErr({
      message: 'Operation failed',
      cause: error, // ❌ Don't pass unknown as cause
      context: { someContext },
    }),
});
```

### After (Correct)
```typescript
await tryAsync({
  try: async () => {
    const result = await externalOperation();
    return result;
  },
  catch: (error) =>
    ServiceErr({
      message: `Operation failed: ${extractErrorMessage(error)}`, // ✅ Extract message
      context: { someContext },
    }),
});
```

## Key Principles

### 1. Unknown Errors Should Be Flattened
When catching errors of type `unknown` (which is always the case in catch blocks), extract the error message using `extractErrorMessage(error)` and embed it in your error message string.

### 2. Omit the `cause` Field
Do not pass `cause: error` when the error is type `unknown`. This avoids type safety issues and provides clearer error information.

### 3. Preserve Context
Use the `context` field to include relevant contextual information (like file paths, IDs, etc.) that helps debugging.

## Where This Applies

This pattern applies to:
- All `tryAsync` catch handlers
- All `trySync` catch handlers
- Any custom error constructor wrapping an error of type `unknown`

## Example: Parser.ts

```typescript
export async function parseMarkdownFile(filePath: string): Promise<
  Result<
    {
      data: Record<string, unknown>;
      body: string;
    },
    MarkdownError
  >
> {
  return tryAsync({
    try: async () => {
      const file = Bun.file(filePath);
      const content = await file.text();
      // ... parsing logic
      return { data, body: bodyContent };
    },
    catch: (error) =>
      MarkdownErr({
        message: `Failed to parse markdown file ${filePath}: ${extractErrorMessage(error)}`,
        context: { filePath },
        // Note: No `cause: error` field
      }),
  });
}
```

## Rationale

1. **Type Safety**: Unknown errors can be any JavaScript value (string, number, Error object, null, undefined). Passing them as `cause` creates type safety problems.

2. **Clarity**: Extracting the message provides flat, readable error information without nested error chains.

3. **Stack Traces**: The important stack trace is from your custom error (where it occurred in YOUR code), not from the caught error (which might be from external libraries).

4. **Consistency**: This creates a consistent error handling pattern across the codebase.

## Exception: Known Error Types

This pattern does NOT apply when you're catching or wrapping a known error type from another service in your codebase:

```typescript
// When wrapping a known error type, you CAN preserve it as cause
const result = await someService.operation();
if (result.error) {
  return Err(
    ServiceErr({
      message: 'Higher-level operation failed',
      cause: result.error, // ✅ OK because this is a known error type
    })
  );
}
```

## Implementation Checklist

- [x] Search for all `tryAsync` usages with `cause: error` in catch handlers
- [x] Search for all `trySync` usages with `cause: error` in catch handlers
- [x] Replace `cause: error` with `extractErrorMessage(error)` in message
- [x] Verify `extractErrorMessage` is imported from `wellcrafted/error`
- [x] Test error messages are still informative

## Implementation Summary

All instances in the `packages/epicenter` directory have been updated:

1. **packages/epicenter/src/indexes/markdown/parser.ts** (reference implementation)
   - Already implemented the correct pattern

2. **packages/epicenter/src/indexes/markdown/operations.ts**
   - Updated `writeMarkdownFile` catch handler
   - Updated `deleteMarkdownFile` catch handler
   - Added `extractErrorMessage` import

3. **packages/epicenter/src/indexes/markdown/index.ts**
   - Updated `pushToMarkdown` catch handler
   - Updated `pullFromMarkdown` catch handler
   - Added `extractErrorMessage` import

4. **packages/epicenter/src/indexes/sqlite/index.ts**
   - Updated `pushToSqlite` catch handler
   - Updated `pullFromSqlite` catch handler
   - Added `extractErrorMessage` import

All catch handlers now follow the pattern:
- Extract error message using `extractErrorMessage(error)`
- Embed it in the error message string
- Omit the `cause` field entirely

## Related Files

- packages/epicenter/src/indexes/markdown/parser.ts (reference implementation)
- packages/epicenter/src/indexes/markdown/operations.ts
- packages/epicenter/src/indexes/markdown/index.ts
- packages/epicenter/src/indexes/sqlite/index.ts
