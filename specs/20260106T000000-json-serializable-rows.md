# JSON-Serializable Rows Architecture

**Status:** Implemented
**Created:** 2026-01-06
**Author:** Braden
**Branch:** `feat/json-serializable-rows`

## Overview

This specification documents the migration from CRDT-embedded rows to JSON-serializable rows with ID-referenced rich content. The goal is to make workspace data backend-agnostic and drastically simplify storage complexity.

## Problem Statement

### Previous Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Row (Y.Map)                                                    │
│  ├── id: "post-001"              (string)                       │
│  ├── title: "My Post"            (string)                       │
│  ├── content: Y.Text             ◄── CRDT type embedded        │
│  ├── tags: Y.Array<string>       ◄── CRDT type embedded        │
│  └── status: "published"         (string)                       │
└─────────────────────────────────────────────────────────────────┘
                    │
                    ▼ serializeCellValue()
┌─────────────────────────────────────────────────────────────────┐
│  SerializedRow (plain JS)                                       │
│  ├── id: "post-001"                                             │
│  ├── title: "My Post"                                           │
│  ├── content: "Hello world..."   ◄── Y.Text.toString()         │
│  ├── tags: ["a", "b"]            ◄── Y.Array.toArray()         │
│  └── status: "published"                                        │
└─────────────────────────────────────────────────────────────────┘
```

**Problems:**

1. **Yjs-coupled**: `CellValue` differs from `SerializedCellValue`, requiring conversion
2. **Complex sync utilities**: `updateYTextFromString()` with character-level diffing
3. **Backend lock-in**: Can't use same schema with SQLite or Markdown directly
4. **Workspace bloat**: Every Y.Text/Y.Array creates CRDT metadata overhead
5. **Mixed concerns**: Row structure conflates structured data with collaborative content

### New Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Row (Y.Map, Markdown, or SQLite)                               │
│  ├── id: "post-001"              (string)                       │
│  ├── title: "My Post"            (string)                       │
│  ├── content: "rtxt_abc123xyz"   ◄── Just an ID reference      │
│  ├── tags: ["a", "b"]            ◄── Plain array               │
│  └── status: "published"         (string)                       │
└─────────────────────────────────────────────────────────────────┘
         │
         │  Same data in all backends - no conversion needed
         ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│  Y.Map row   │  │  .md file    │  │  SQLite row  │
│  (Yjs)       │  │  (Markdown)  │  │  (database)  │
└──────────────┘  └──────────────┘  └──────────────┘
```

**Benefits:**

1. **Backend agnostic**: Same schema works with Yjs, Markdown, SQLite
2. **No conversion needed**: `CellValue === SerializedCellValue` (identity)
3. **Simpler utilities**: No diff algorithms for row updates
4. **Smaller workspaces**: No CRDT metadata overhead for tags/simple text
5. **Clean separation**: Structured data (rows) vs collaborative content (separate Y.Docs)
6. **Future-ready**: Enables YKeyValue migration for even smaller documents

---

## What Was Implemented

### Commit 1: Remove Y.Array from tags

- Removed `updateYArrayFromArray()` function from `yjs.ts`
- Updated `updateYRowFromSerializedRow()` to store plain arrays with simple equality check
- Removed Y.Array handling from `serialization.ts`
- Updated `CellValue` for `TagsFieldSchema` to return `string[]` instead of `Y.Array`
- Deleted `yarray.test.ts`

### Commit 2: Replace ytext() with richtext()

- **Renamed** `ytext()` → `richtext()` factory function
- **Renamed** `YtextFieldSchema` → `RichtextFieldSchema` type
- **Simplified**: `richtext()` now stores a string ID (e.g., `"rtxt_abc123"`) instead of Y.Text
- **No type distinction**: Removed the `text` vs `blocks` distinction. Just a simple ID reference
- Removed `updateYTextFromString()` and `diffChars` import from `yjs.ts`
- Simplified `serialization.ts` to identity function
- Simplified `kv-helper.ts` (no Y.Text creation/update logic)
- Updated all exports in `index.ts` and `index.shared.ts`
- **Restored detailed JSDoc** for all public APIs

### Commit 3: Add createRichContentId() utility

Created `packages/epicenter/src/core/rich-content/id.ts`:

```typescript
export type RichContentId = string & Brand<'RichContentId'>;

export function createRichContentId(): RichContentId {
	return `rtxt_${nanoid()}` as RichContentId;
}
```

- Simple ID generation with `rtxt_` prefix
- Branded type for type safety
- Exported from `index.shared.ts`

### Commit 4: Update tests

- Updated `kv-helper.test.ts`: Tests now expect strings instead of Y.Text
- Updated `core-types.test.ts`: Tests now expect plain types
- Updated `core.test.ts`: Tests now expect plain types
- Deleted `ytext.test.ts` (tested removed `updateYTextFromString`)

### Commit 5: Remove diff dependency

- Removed `diff` package from `package.json` (was used for Y.Text character diffing)

---

## Key Design Decisions

| Decision               | Choice                              | Rationale                                           |
| ---------------------- | ----------------------------------- | --------------------------------------------------- |
| ID format              | `rtxt_` prefix only                 | Simpler than distinguishing text/blocks at ID level |
| No type in ID          | Single prefix for all rich content  | Type can be determined by schema, not ID            |
| Branded type           | `RichContentId`                     | Type safety without runtime overhead                |
| Identity serialization | `CellValue === SerializedCellValue` | No conversion needed anymore                        |
| Keep JSDoc             | Detailed documentation              | Public API should be well-documented                |

---

## Files Changed

| File                                   | Change                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------- |
| `core/utils/yjs.ts`                    | Removed `updateYTextFromString`, simplified `updateYRowFromSerializedRow` |
| `core/schema/runtime/serialization.ts` | Now identity function with updated JSDoc                                  |
| `core/schema/fields/factories.ts`      | `ytext()` → `richtext()` with detailed JSDoc                              |
| `core/schema/fields/types.ts`          | `YtextFieldSchema` → `RichtextFieldSchema`, updated `CellValue`           |
| `core/schema/index.ts`                 | Updated exports                                                           |
| `core/kv/kv-helper.ts`                 | Removed Y.Text handling, updated JSDoc                                    |
| `core/rich-content/id.ts`              | NEW: ID generation utility                                                |
| `index.shared.ts`                      | Updated exports, added rich-content exports                               |
| `package.json`                         | Removed `diff` dependency                                                 |
| Various `.test.ts` files               | Updated expectations for plain types                                      |

---

## Migration Guide

### For Consumers

```typescript
// BEFORE
import { ytext, tags } from '@epicenter/workspace';

const schema = {
	content: ytext(),
	labels: tags(),
};

// Access in row
const row = table.get('1');
row.content.toString(); // Y.Text method
row.labels.toArray(); // Y.Array method

// AFTER
import { richtext, tags, createRichContentId } from '@epicenter/workspace';

const schema = {
	content: richtext(),
	labels: tags(),
};

// Access in row - plain values!
const row = table.get('1');
row.content; // "rtxt_abc123xyz" (string)
row.labels; // ["a", "b"] (string[])

// Creating new rich content
const contentId = createRichContentId();
table.upsert({ id: '1', content: contentId, labels: ['draft'] });
```

### Breaking Changes

1. `ytext()` removed → use `richtext()`
2. `YtextFieldSchema` removed → use `RichtextFieldSchema`
3. Row values are now plain strings/arrays, not Y.Text/Y.Array
4. `updateYTextFromString()` removed (no replacement needed)
5. `updateYArrayFromArray()` removed (no replacement needed)

---

## Future Work

### Phase 2: Remove "Serialized" Terminology (Next PR)

Since `CellValue === SerializedCellValue`, we can simplify further:

- Remove `SerializedCellValue` type → use `CellValue`
- Remove `serializeCellValue()` function → identity, not needed
- Rename `SerializedRow` → `RowData` (or just inline)
- Rename `PartialSerializedRow` → `PartialRowData`
- Simplify or remove `toJSON()` method on Row

### Phase 3: YKeyValue Migration

With JSON-serializable rows, we can now migrate from Y.Map to YKeyValue:

- **Why**: YKeyValue is optimized for key-value storage patterns
- **Benefit**: Smaller document size, better performance for alternating key updates
- **Enabler**: This PR makes rows simple key-value pairs, perfect for YKeyValue

### Phase 4: Rich Content Store

Implement actual storage for collaborative rich content:

- `RichContentStore` interface
- Lazy loading Y.Docs by ID
- Provider integration (where does the Y.Doc live?)
- Separate spec when ready to implement

---

## Review Summary

This migration successfully:

1. ✅ Removed embedded CRDTs from rows (Y.Text, Y.Array)
2. ✅ Made rows JSON-serializable without conversion
3. ✅ Added `richtext()` factory storing ID references
4. ✅ Added `createRichContentId()` utility
5. ✅ Simplified sync utilities (no more character diffing)
6. ✅ Removed `diff` dependency
7. ✅ Updated all tests
8. ✅ Maintained detailed JSDoc documentation

The architecture is now ready for:

- YKeyValue migration (smaller documents)
- Multi-backend support (same schema for Yjs/Markdown/SQLite)
- Rich Content Store implementation (when needed)
