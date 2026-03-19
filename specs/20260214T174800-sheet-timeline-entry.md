# Sheet Timeline Entry

**Date**: 2026-02-14
**Status**: Draft
**Extends**: `specs/20260211T230000-timeline-content-storage-implementation.md`

---

## Overview

Add a `sheet` content mode to the per-file Y.Doc timeline. A sheet entry stores tabular data as nested Y.Maps — columns for definitions, rows for cell values — with all values as strings. Row and column ordering uses fractional indexing (property updates, not Y.Array position). Serializes to/from CSV for the filesystem `readFile`/`writeFile` interface.

---

## Motivation

### Current State

The timeline supports three content modes:

```typescript
type TextEntry    = { type: 'text';     content: Y.Text };
type RichTextEntry = { type: 'richtext'; content: Y.XmlFragment; frontmatter: Y.Map<unknown> };
type BinaryEntry  = { type: 'binary';   content: Uint8Array };
```

These handle text files and rich documents, but there's no structured tabular format. A user wanting spreadsheet-like data must either:

1. Store CSV as a plain text entry (no cell-level collaboration, no column metadata)
2. Store JSON as a plain text entry (same problems)

### Problems

1. **No cell-level collaboration**: Two users editing the same CSV string causes full-text conflicts. There's no way to merge concurrent cell edits.
2. **No column semantics**: A text entry doesn't know that column 3 is "Price" and should display as a number. Metadata lives nowhere.
3. **No structured reordering**: Reordering rows in a text file means rewriting the entire string.

### Desired State

A file with content mode `sheet` stores tabular data with:
- Cell-level CRDT collaboration (concurrent edits to different cells merge cleanly)
- Column definitions (name, kind, width, order)
- Row ordering via fractional indexing (drag-and-drop reorder = single property update)
- Transparent CSV serialization for the POSIX filesystem interface

---

## Research Findings

### How Production Yjs Apps Store Tabular Data

| Project | Cell Storage | Row Ordering | Cell Values |
|---------|-------------|--------------|-------------|
| **BlockSuite / AFFiNE** | Flat Y.Map, compound keys `rowId:colId` | Separate order property | Y.Text per cell |
| **AppFlowy** | Per-row Y.Doc, nested `Y.Map<fieldId, Y.Map>` | Y.Array + delete/insert (antipattern) | Mixed types per cell |
| **Univer** | Nested `Record<row, Record<col, ICellData>>` | Positional indices | Object per cell |

### Yjs Maintainer Recommendations

Source: [Yjs DeepWiki](https://deepwiki.com/yjs/yjs), maintainer guidance.

| Pattern | Recommendation | Rationale |
|---------|---------------|-----------|
| `Y.Map<rowId, Y.Map<colId, value>>` | **Recommended** | `observeDeep` gives structured paths. Row deletion cascades. |
| `Y.Array<Y.Map>` | For append-only | Good when order is creation order. Bad for reordering (delete+insert). |
| Flat `Y.Map` with compound keys | **Not recommended** | Re-keying on positional row insert. (Not applicable with UUID keys.) |
| Row/column reordering | **Fractional indexing** | Y.Array move = delete+insert = lost updates + duplicates. Property update = clean merge. |

**Key finding**: Nested Y.Maps with fractional indexing is the consensus approach. AppFlowy's Y.Array reorder is the known antipattern — their `reorderRow` does `rows.delete(sourceIndex)` then `rows.insert(adjustedTargetIndex)`, exactly what the [fractional ordering article](../docs/articles/fractional-ordering-meta-data-structure.md) warns against.

**Implication**: Use `Y.Map<rowId, Y.Map>` for rows, fractional index as a string property on each row/column Y.Map.

---

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Cell value type | Always `string` | Simplest CRDT layer. Interpretation (number, date, boolean) is a column `kind` hint. Parse on read, stringify on write. Google Sheets does the same. |
| Row ordering | Fractional indexing (string property `order`) | Y.Array reorder = delete+insert = lost updates + duplicates. Property update is atomic. Already documented in `docs/articles/fractional-ordering-meta-data-structure.md`. |
| Column ordering | Fractional indexing (string property `order`) | Same rationale as row ordering. |
| Row/column IDs | 10-char nanoid via `generateId()` | Stable across concurrent edits. No positional re-keying. Uses existing `generateId()` from `@epicenter/workspace` (10-char alphanumeric, safe for millions of rows). Branded types `RowId` and `ColumnId`. No prefixes (raw nanoid strings). |
| Column definition versioning | No `_v` field | Y.Maps allow atomic field updates, making object-level versioning misleading. Use defensive reading (provide defaults for missing fields) + strict writing (always set all current schema fields). Additive changes (new optional fields) are safe without versioning. |
| Column defs location | Nested Y.Map on the timeline entry | Co-located with data. No external schema reference needed. |
| `order` as reserved key | Yes, on row Y.Map | Column IDs are nanoid-generated (e.g., `k7x9m2p4q8`), never the literal string `"order"`. No collision possible. |
| Column kind key name | `kind` (not `type`) | Avoids collision with the timeline entry's `type` discriminant. |
| Column kind values | Plain strings without version suffixes | `'text'`, `'number'`, `'date'`, `'select'`, `'boolean'`. New kinds can be added later non-breaking. |
| Nesting strategy | `Y.Map<rowId, Y.Map>` | Yjs-recommended. `observeDeep` gives `[rowId, colId]` paths. Row delete = one `rows.delete(rowId)` call. |
| CSV as filesystem serialization | Yes | Natural plain-text representation. `readFile` returns CSV string. `writeFile` with CSV string populates cells. |
| CSV parsing implementation | Hand-rolled RFC 4180 parser | ~100 lines, full control, no external dependency. Handles quoted fields, escaping, newlines. |
| Malformed CSV handling | Refuse to parse OR fall back to text mode | If CSV parsing fails, either leave columns/rows empty (caller can detect) or push a new text entry instead. Never silently corrupt data. |
| Entry placement | On the timeline Y.Array, like all other modes | Consistent with existing architecture. Mode switching (text → sheet → text) works via timeline append. |

---

## Architecture

### Y.Doc Structure (per file)

```
Y.Doc (guid = fileId, gc: false)
└── Y.Array('timeline')
    └── Y.Map (sheet entry)                    ← last entry = current version
        │
        ├── 'type': 'sheet'                    ← discriminant (string)
        │
        ├── 'columns': Y.Map                   ← column definitions
        │     └── <colId>: Y.Map               ← one per column
        │           ├── 'name':  string        ← display name ("Price")
        │           ├── 'kind':  string        ← interpretation ("text"|"number"|"date"|"select"|"boolean")
        │           ├── 'width': string        ← display width in px ("120")
        │           └── 'order': string        ← fractional index for ordering ("a1")
        │
        └── 'rows': Y.Map                      ← row data
              └── <rowId>: Y.Map               ← one per row
                    ├── 'order':    string      ← RESERVED: fractional index ("a0V")
                    ├── <colId_1>:  string      ← cell value ("42.50")
                    ├── <colId_2>:  string      ← cell value ("In Stock")
                    └── ...                     ← sparse: missing key = empty cell
```

### How It Fits in the Timeline

```
Timeline Y.Array (existing)
│
├── Y.Map { type: 'text',     content: Y.Text }                    ← existing
├── Y.Map { type: 'richtext', content: Y.XmlFragment, frontmatter: Y.Map }  ← existing
├── Y.Map { type: 'binary',   content: Uint8Array }                ← existing
└── Y.Map { type: 'sheet',    columns: Y.Map, rows: Y.Map }       ← NEW
```

Mode switching works identically to existing modes. Converting a text file to a sheet appends a new sheet entry. Converting back appends a new text entry. The timeline grows; previous entries are preserved (revision history with `gc: false`).

### Key Architectural Insights

These design choices enable efficient collaborative editing and demonstrate fundamental CRDT patterns:

#### 1. Two-Map Efficiency: No Separate Cells Map Needed

The architecture uses only two top-level Y.Maps (`columns` and `rows`), yet supports full spreadsheet functionality:

- **Column definitions** live in `columns` Y.Map (metadata: name, kind, width, order)
- **Cell values** are nested properties within each row's Y.Map, keyed by column ID
- No separate "cells" map needed—sparse storage works naturally (missing keys = empty cells)
- Row deletion cascades automatically: `rows.delete(rowId)` removes all cells in that row

This sparse nested structure is more efficient than a flat `cells` Y.Map with compound keys like `rowId:colId` because:
- Row operations (delete, reorder) touch one Y.Map entry, not N cells
- Empty cells cost zero bytes (no keys stored)
- `observeDeep` gives structured paths (see insight #5)

#### 2. Stable IDs Prevent Re-keying Hell

Row and column IDs are generated via `generateId()` (10-char nanoid) and never change:

- When columns reorder, IDs stay stable → cell keys in rows remain valid
- When rows reorder, IDs stay stable → no cascading updates
- Concurrent column addition = different UUIDs = no conflicts
- No positional re-keying like flat maps with numeric indices

**Example**: Reordering column B between A and C only changes column B's `order` property. All row Y.Maps still reference cells via the same column IDs. Zero re-keying.

#### 3. Fractional Ordering Eliminates Y.Array Antipatterns

Using an `order` property (not Y.Array position) for row/column ordering avoids the delete+insert antipattern documented in `docs/articles/fractional-ordering-meta-data-structure.md`:

**Y.Array move pattern (WRONG)**:
```typescript
rows.delete(sourceIndex);        // Deletes the row Y.Map
rows.insert(targetIndex, row);   // Inserts a new Y.Map
// Result: Lost updates (concurrent edits to deleted row vanish)
//         Duplicates (concurrent moves = multiple inserts)
```

**Fractional order pattern (CORRECT)**:
```typescript
row.set('order', computeMidpoint(beforeRow, afterRow));
// Result: Single property update, clean CRDT merge
```

The `order` property is the ONLY positional data. The underlying Y.Map key order is irrelevant. This applies to both row AND column reordering.

#### 4. Reserved Key Safety: `order` Never Collides

The `order` key in row Y.Maps is safe because column IDs are nanoid-generated:

- Column IDs look like: `k7x9m2p4q8`, `abc123xyz7`, `p2q4r6s8t0`
- The literal string `"order"` will never be generated by nanoid with the `[a-z0-9]` alphabet
- No collision possible, no need for namespacing like `_order` or `meta:order`

#### 5. observeDeep Structured Paths Enable Cell-Level Tracking

The nested `Y.Map<rowId, Y.Map<colId, value>>` structure gives structured paths in `observeDeep` events:

```typescript
sheetEntry.observeDeep((events) => {
  for (const event of events) {
    console.log(event.path);
    // ['rows', 'k7x9m2p4q8', 'abc123xyz7']  → Cell (row k7x9..., col abc1...)
    // ['rows', 'k7x9m2p4q8', 'order']       → Row reorder
    // ['columns', 'abc123xyz7', 'name']     → Column rename
    // ['columns', 'abc123xyz7', 'order']    → Column reorder
  }
});
```

This enables:
- Listening to specific cells without iterating all changes
- Filtering for row-level vs column-level events
- Building efficient UI update logic (only re-render affected cells)

Contrast with a flat `cells` Y.Map with compound keys (`rowId:colId`): `observeDeep` paths would be `['cells', 'k7x9m2p4q8:abc123xyz7']`, requiring string parsing to extract row/column IDs.

### Example: 3-Column, 2-Row Sheet

```
Y.Map (entry)
├── type: 'sheet'
├── columns: Y.Map
│     ├── 'k7x9m2p4q8': Y.Map { name: 'Product',  kind: 'text',    width: '200', order: 'a0' }
│     ├── 'abc123xyz7': Y.Map { name: 'Price',    kind: 'number',  width: '100', order: 'a1' }
│     └── 'p2q4r6s8t0': Y.Map { name: 'In Stock', kind: 'boolean', width: '80',  order: 'a2' }
├── rows: Y.Map
│     ├── 'm3n5p7q9r1': Y.Map { order: 'a0', k7x9m2p4q8: 'Widget',  abc123xyz7: '9.99',  p2q4r6s8t0: 'true' }
│     └── 's1t3u5v7w9': Y.Map { order: 'a1', k7x9m2p4q8: 'Gadget',  abc123xyz7: '24.99', p2q4r6s8t0: 'false' }
```

Serialized as CSV via `readFile`:

```csv
Product,Price,In Stock
Widget,9.99,true
Gadget,24.99,false
```

---

## TypeScript Types

### Row and Column IDs

Added to `packages/filesystem/src/types.ts`:

```typescript
import { type Id, generateId } from '@epicenter/workspace';
import type { Brand } from 'wellcrafted/brand';

/** Branded row identifier — a 10-char nanoid that is specifically a row ID */
export type RowId = Id & Brand<'RowId'>;

/** Generate a new unique row identifier */
export function generateRowId(): RowId {
  return generateId() as RowId;
}

/** Branded column identifier — a 10-char nanoid that is specifically a column ID */
export type ColumnId = Id & Brand<'ColumnId'>;

/** Generate a new unique column identifier */
export function generateColumnId(): ColumnId {
  return generateId() as ColumnId;
}
```

**Why 10-char IDs?** `generateId()` from `@epicenter/workspace` produces 10-character alphanumeric strings (alphabet: `a-z0-9`), safe for ~85 million entities with 1-in-a-million collision chance. Both rows and columns are table-scoped, not globally unique, so 10 chars is sufficient.

**Why branded types?** Prevents accidentally using a `RowId` where a `ColumnId` is expected at compile time. Follows the existing `FileId` pattern in the codebase.

**Why no prefixes?** Raw nanoid strings (e.g., `k7x9m2p4q8`) are sufficient. Prefixes like `row_` or `col_` add visual clutter without functional benefit since TypeScript enforces type safety.

### Sheet Entry

Added to `packages/filesystem/src/types.ts`:

```typescript
export type SheetEntry = {
  type: 'sheet';
  columns: Y.Map<Y.Map<string>>;
  rows: Y.Map<Y.Map<string>>;
};

export type TimelineEntry = TextEntry | RichTextEntry | BinaryEntry | SheetEntry;
```

Updated `ContentType`:

```typescript
export type ContentType = TimelineEntry['type']; // 'text' | 'richtext' | 'binary' | 'sheet'
```

### Column Definition (Type-Level Documentation)

The column definition shape stored in each column Y.Map:

```typescript
/**
 * Column definition stored in a column Y.Map.
 * 
 * This type documents the expected shape but cannot be enforced at runtime
 * since Y.Maps are dynamic key-value stores. Use defensive reading with
 * defaults when accessing column properties.
 */
export type ColumnDefinition = {
  /** Display name of the column */
  name: string;
  
  /** Column kind determines cell value interpretation */
  kind: 'text' | 'number' | 'date' | 'select' | 'boolean';
  
  /** Display width in pixels (stored as string) */
  width: string;
  
  /** Fractional index for column ordering (e.g., "a0", "a1", "a0V") */
  order: string;
};
```

**No `_v` version field**: Column definitions do not include a version field. Use defensive reading (provide defaults for missing fields) and strict writing (always set all current schema fields). Additive changes (new optional fields) are safe without versioning. See Design Decisions for rationale.

---

## Timeline Helper Additions

New functions in `packages/filesystem/src/timeline-helpers.ts`:

### pushSheet

```typescript
/** Create and append a new empty sheet entry. Returns the Y.Map. */
pushSheet(): Y.Map<any> {
  const entry = new Y.Map();
  entry.set('type', 'sheet');
  entry.set('columns', new Y.Map());
  entry.set('rows', new Y.Map());
  timeline.push([entry]);
  return entry;
}
```

### pushSheetFromCsv

```typescript
/**
 * Create a sheet entry from a CSV string.
 * First row is treated as column headers. Column IDs are generated.
 * All cell values are stored as strings.
 */
pushSheetFromCsv(csv: string): Y.Map<any>
```

### readAsString (updated switch)

```typescript
case 'sheet':
  return serializeSheetToCsv(
    entry.get('columns') as Y.Map<Y.Map<string>>,
    entry.get('rows') as Y.Map<Y.Map<string>>,
  );
```

### readAsBuffer (updated switch)

```typescript
case 'sheet':
  return new TextEncoder().encode(
    serializeSheetToCsv(
      entry.get('columns') as Y.Map<Y.Map<string>>,
      entry.get('rows') as Y.Map<Y.Map<string>>,
    ),
  );
```

---

## Sheet Helpers

New file: `packages/filesystem/src/sheet-helpers.ts`

### serializeSheetToCsv

```typescript
/**
 * Serialize a sheet's columns and rows Y.Maps to a CSV string.
 *
 * 1. Sort columns by fractional `order`
 * 2. Write header row (column names)
 * 3. Sort rows by fractional `order`
 * 4. For each row, read cell values by column ID (empty string for missing)
 * 5. Escape values containing commas, quotes, or newlines (RFC 4180)
 */
export function serializeSheetToCsv(
  columns: Y.Map<Y.Map<string>>,
  rows: Y.Map<Y.Map<string>>,
): string
```

### parseSheetFromCsv

```typescript
/**
 * Parse a CSV string and populate columns and rows Y.Maps.
 *
 * 1. Parse CSV (handle quoted fields per RFC 4180)
 * 2. First row = column headers → create column Y.Maps with generated IDs
 * 3. Subsequent rows → create row Y.Maps with generated IDs
 * 4. Assign fractional order strings to columns and rows (sequential)
 */
export function parseSheetFromCsv(
  csv: string,
  columns: Y.Map<Y.Map<string>>,
  rows: Y.Map<Y.Map<string>>,
): void
```

### RFC 4180 CSV Compliance

- Fields containing `,`, `"`, or `\n` are enclosed in double quotes
- Double quotes inside fields are escaped as `""`
- Newline is `\n` (Unix)
- Empty trailing fields are preserved

---

## ContentOps Changes

In `packages/filesystem/src/content-ops.ts`:

### write (updated)

```typescript
// After existing text/binary handling:
if (typeof data === 'string' && tl.currentType === 'sheet') {
  // Writing a string to a sheet file: parse as CSV, update in place
  const columns = tl.currentEntry!.get('columns') as Y.Map<Y.Map<string>>;
  const rows = tl.currentEntry!.get('rows') as Y.Map<Y.Map<string>>;
  ydoc.transact(() => {
    // Clear existing data
    columns.forEach((_, key) => columns.delete(key));
    rows.forEach((_, key) => rows.delete(key));
    parseSheetFromCsv(data, columns, rows);
  });
  return new TextEncoder().encode(data).byteLength;
}
```

Writing a string to a sheet mode file re-parses the CSV and updates cells in place (same-mode write, timeline doesn't grow). Writing a `Uint8Array` to a sheet file mode-switches to binary (pushes new entry, timeline grows).

---

## Edge Cases

### Empty Sheet

A sheet with zero columns and zero rows serializes to an empty string `""`. This is consistent with `readFile` returning `""` for empty text entries.

### CSV with No Data Rows

A CSV with only a header row creates column definitions but zero rows. `readFile` returns just the header: `"Product,Price,In Stock\n"`.

### Cells Referencing Deleted Columns

If a column is deleted (`columns.delete(colId)`), row Y.Maps may still contain keys for that column ID. These orphaned cell values are:
- Ignored during CSV serialization (only columns in `columns` Y.Map are iterated)
- Harmless with `gc: false` (no cleanup needed, they're just unused keys)
- Automatically excluded from any column-aware UI

### Concurrent Row Reorder

Two users move different rows to the same position simultaneously. Both compute the same fractional index midpoint, but with jitter (per the fractional indexing pattern), they get slightly different `order` values. Both rows appear near the target position. No duplicates, no lost data.

### Concurrent Column Addition

Two users add a column at the same time. Both create a new entry in the `columns` Y.Map with different UUIDs. Both columns appear. Y.Map handles concurrent `set` on different keys cleanly.

### Mode Switching: Text → Sheet

`writeFile("file.csv", csvString)` when the current mode is `text`:
- Since the current mode is text and data is a string, this edits the existing Y.Text (existing behavior)
- To create a sheet entry, the UI layer must explicitly push a sheet entry onto the timeline
- The filesystem `writeFile` does NOT auto-detect CSV and switch modes

### Mode Switching: Sheet → Text

If a sheet entry is current and the user wants plain text, the UI pushes a new text entry. The sheet entry is preserved in the timeline for history.

---

## Resolved Questions

All open questions have been resolved through implementation discussion.

1. **Should `writeFile` with a CSV-like string auto-detect and create a sheet entry?**
   - **Decision**: Explicit API only (option c). The UI layer calls `pushSheet` or `pushSheetFromCsv` directly. `writeFile` on a sheet-mode file re-parses CSV in place.

2. **Should column `kind` support a fixed set of values or be freeform?**
   - **Decision**: Fixed set, extensible later (option c). Column kinds are plain strings: `'text'`, `'number'`, `'date'`, `'select'`, `'boolean'`. No version suffixes on kind values. New kinds can be added non-breaking since they're stored as strings.

3. **Should we use the `fractional-indexing` library or simple numeric midpoints?**
   - **Decision**: Simple numeric midpoints with randomness (option b) for initial implementation. Uses the pattern from `docs/articles/fractional-ordering-meta-data-structure.md`. Migration path to library exists if precision becomes an issue (unlikely for typical usage).

4. **CSV header row: column names or column IDs?**
   - **Decision**: Column names (option a). CSV is for human consumption via the POSIX filesystem. Round-trip fidelity for programmatic use goes through the Y.Doc directly.

5. **Should the sheet entry support a `meta` Y.Map for sheet-level properties?**
   - **Decision**: Omit entirely for now. Do not add the key, do not reserve it in types. Add later when needed.

---

## Implementation Plan

### Phase 1: Types and Sheet Helpers

- [ ] **1.1** Add `RowId`, `ColumnId` branded types and generator functions to `types.ts`
- [ ] **1.2** Add `SheetEntry` type to `types.ts`, update `TimelineEntry` union and `ContentType`
- [ ] **1.3** Add `ColumnDefinition` type (type-level documentation, not enforced at runtime)
- [ ] **1.4** Create `sheet-helpers.ts` with `serializeSheetToCsv` and `parseSheetFromCsv`
- [ ] **1.5** Add CSV escaping/parsing per RFC 4180 (hand-rolled, handle commas, quotes, newlines in cell values)
- [ ] **1.6** Unit tests for `serializeSheetToCsv` (empty sheet, single row, special characters, column ordering)
- [ ] **1.7** Unit tests for `parseSheetFromCsv` (basic CSV, quoted fields, empty cells, round-trip, malformed CSV handling)

### Phase 2: Timeline Integration

- [ ] **2.1** Add `pushSheet()` and `pushSheetFromCsv(csv)` to `createTimeline()` in `timeline-helpers.ts`
- [ ] **2.2** Update `readAsString()` switch to handle `'sheet'` → CSV serialization
- [ ] **2.3** Update `readAsBuffer()` switch to handle `'sheet'` → CSV encoded as Uint8Array
- [ ] **2.4** Unit tests for timeline push/read round-trip

### Phase 3: ContentOps Integration

- [ ] **3.1** Update `ContentOps.write()` to handle string writes to sheet-mode files (re-parse CSV in place)
- [ ] **3.2** Update `ContentOps.read()` to return CSV string for sheet-mode files
- [ ] **3.3** Integration tests via `YjsFileSystem`: write CSV → read back, verify cell-level storage

### Phase 4: Fractional Indexing

- [ ] **4.1** Implement simple numeric midpoints with randomness (pattern from `docs/articles/fractional-ordering-meta-data-structure.md`)
- [ ] **4.2** Wire fractional index generation into `parseSheetFromCsv` (initial order assignment for columns and rows)
- [ ] **4.3** Expose reorder helpers: `reorderRow(rowId, beforeRowId)`, `reorderColumn(colId, beforeColId)`
- [ ] **4.4** Unit tests for concurrent reorder scenarios (verify no duplicates, no lost updates)

### Phase 5: Sheet Editor UI (future, out of scope)

- [ ] **5.1** Sheet component that binds to the `columns` and `rows` Y.Maps
- [ ] **5.2** Cell editing with `observeDeep` for real-time collaboration
- [ ] **5.3** Column/row add, delete, reorder via UI

---

## Success Criteria

- [ ] `SheetEntry` type exists and is part of `TimelineEntry` union
- [ ] `serializeSheetToCsv` produces RFC 4180-compliant CSV
- [ ] `parseSheetFromCsv` correctly populates Y.Maps from CSV input
- [ ] `createTimeline().pushSheet()` creates a valid sheet entry on the timeline
- [ ] `createTimeline().pushSheetFromCsv(csv)` creates a populated sheet entry
- [ ] `readAsString()` on a sheet entry returns CSV
- [ ] Round-trip: CSV → pushSheetFromCsv → readAsString → original CSV (modulo column ID generation)
- [ ] All existing timeline tests pass unchanged
- [ ] `bun test packages/filesystem/` passes

---

## v14 Forward Compatibility

Same structural mapping as the existing timeline spec:

```
v13 (this spec)                            v14 (future)
──────────────────────────────────         ──────────────────────────────────
Y.Map (sheet entry)                        Y.Type (sheet entry)
├── .get('type')       → 'sheet'           ├── .getAttr('type')       → 'sheet'
├── .get('columns')    → Y.Map             ├── .getAttr('columns')    → Y.Type
│     └── Y.Map (col def)                  │     └── Y.Type (col def)
└── .get('rows')       → Y.Map             └── .getAttr('rows')       → Y.Type
      └── Y.Map (row data)                       └── Y.Type (row data)
```

Migration is confined to `timeline-helpers.ts` and `sheet-helpers.ts`. Consumer code is insulated.

---

## References

- `packages/filesystem/src/types.ts` — TimelineEntry union (add SheetEntry here)
- `packages/filesystem/src/timeline-helpers.ts` — Timeline factory (add pushSheet, update read switches)
- `packages/filesystem/src/content-ops.ts` — Content I/O (update write for sheet mode)
- `specs/20260211T230000-timeline-content-storage-implementation.md` — Parent spec (this extends it)
- `docs/articles/fractional-ordering-meta-data-structure.md` — Fractional indexing pattern (use for row/column order)

---

## Spec Lineage

| Spec | Relationship |
|------|-------------|
| `specs/20260211T230000-timeline-content-storage-implementation.md` | **Parent** — this spec adds a new entry type to that timeline |
| `specs/20260211T220000-yjs-content-doc-multi-mode-research.md` | **Context** — decision record for the timeline approach |
| `docs/articles/fractional-ordering-meta-data-structure.md` | **Pattern** — fractional indexing used for row/column ordering |
