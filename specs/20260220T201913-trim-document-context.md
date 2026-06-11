# Trim DocumentContext: Remove Unused Fields

## Problem

`DocumentContext` (the context passed to document extension factories) carries four fields that have zero consumers:

- `batch`: redundant with `ydoc.transact(fn)`, which every extension already has via `ydoc`
- `tableName`: speculative metadata, no extension reads it
- `documentName`: speculative metadata, no extension reads it
- `tags`: speculative metadata, no extension reads it (tag _filtering_ happens at registration level, not in factories)

These were added for API consistency with workspace `ExtensionContext`, but document extensions are fundamentally simpler. They operate on a single Y.Doc, not a full workspace.

## Changes

### 1. `lifecycle.ts`: Remove 4 keys from `DocumentContext`

Remove `batch`, `tableName`, `documentName`, `tags` from the type. Update the JSDoc example accordingly. Keep `id`, `ydoc`, `whenReady`, `extensions`.

### 2. `create-document-binding.ts`: Stop passing removed fields

Remove `tableName`, `documentName`, `batch`, `tags` from the `buildContext` callback in `open()`. Remove `tableName` and `documentName` from `CreateDocumentBindingConfig` (they were only passed through to context). Keep `documentTags` on the config since tag _filtering_ of registrations still uses it.

### 3. `create-workspace.ts`: Stop passing `tableName`/`documentName` to `createDocumentBinding`

Remove the `tableName` and `documentName` args from the `createDocumentBinding()` call.

### 4. Tests: Update assertions

- `create-document-binding.test.ts`: Remove the test `'hook receives correct flat metadata with tags'` or rewrite it to only assert fields that still exist.
- No other test changes expected since the fields were never consumed for behavior.

## What stays

- `id`: workspace ID. Can't be derived from `ydoc.guid` (which is the _document_ GUID). Future persistence extensions will need it for path building.
- `ydoc`: the whole point.
- `whenReady`: chaining pattern, consistent with ExtensionContext.
- `extensions`: chaining pattern, consistent with ExtensionContext.
- Tag _filtering_ at registration level (`documentTags` on config, `reg.tags` matching): unchanged.

## Review

All four fields removed. 61 tests pass, zero diagnostics.

### Files changed

| File                                         | Change                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `src/shared/lifecycle.ts`                    | Removed `batch`, `tableName`, `documentName`, `tags` from `DocumentContext` type. Updated JSDoc. |
| `src/static/create-document-binding.ts`      | Removed `tableName`/`documentName` from config type. Removed all 4 fields from `buildContext`.   |
| `src/static/create-workspace.ts`             | Removed `tableName`/`documentName` args from `createDocumentBinding()` call.                     |
| `src/static/create-document-binding.test.ts` | Removed passthrough assertion test. Updated `setupWithBinding` Pick type.                        |

### What's left on `DocumentContext`

```typescript
type DocumentContext<TDocExtensions> = {
  id: string;
  ydoc: Y.Doc;
  whenReady: Promise<void>;
  extensions: { [K in keyof TDocExtensions]?: Extension<...> };
};
```

Tag filtering at registration level (`documentTags` on `CreateDocumentBindingConfig`, `reg.tags` matching in `open()`) is unchanged.
