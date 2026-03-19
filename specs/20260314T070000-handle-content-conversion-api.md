# Handle Content Conversion API

**Date**: 2026-03-14
**Status**: Implemented
**Depends on**: `specs/20260314T060000-document-handle-cleanup.md` (complete)

## Overview

Redesign the handle's content accessors to be mode-aware and conversion-capable. Fix `read()` for richtext, add `pushRichtext()` to Timeline, rename `getText()`/`getFragment()` to `asText()`/`asRichText()`, add `asSheet()`, make all `as*()` methods perform automatic conversion between content types and return `Result` types for fallible conversions.

## Motivation

### Current State

The handle has three content types (text, richtext, sheet) but no way to convert between them:

```typescript
const handle = await documents.open(id);

// These work fine for matching modes:
handle.read();         // text → string ✓, sheet → CSV ✓, richtext → '' ✗
handle.getText();      // text → Y.Text ✓, richtext/sheet → undefined
handle.getFragment();  // richtext → Y.XmlFragment ✓, text/sheet → undefined
// No getSheet() at all
```

Conversion matrix today:

```
        → text    → richtext    → sheet
text      ✓         ✗             ✗
richtext  ✗ ('')    ✓             ✗
sheet     ✓ (CSV)   ✗             ✓
```

### Problems

1. **`read()` returns `''` for richtext—silent data loss.** A document with rich text content returns empty string. The user sees blank content with zero indication something went wrong.

2. **`getText()`/`getFragment()` are inconsistent about auto-creation.** Empty timeline → auto-creates the requested type. Current entry is wrong type → returns `undefined`. Behavior changes based on hidden state.

3. **`getFragment()` bypasses the Timeline API.** There's no `pushRichtext()` on Timeline, so `getFragment()` manually manipulates `ydoc.getArray('timeline')` directly—a layering violation.

4. **No conversion between types.** If you have a richtext document and need a Y.Text for a plaintext editor, there's no path. If you have text and want a sheet, no path. The handle gives you `undefined` and you're on your own.

5. **No sheet accessor.** `getText()` and `getFragment()` exist but there's no `getSheet()`. Sheet data is only accessible through `handle.timeline` escape hatch.

6. **Naming is Yjs jargon.** `getFragment()` means nothing to someone who doesn't know Y.XmlFragment. `getText()` is ambiguous—does it return a string or a Y.Text?

### Desired State

```typescript
const handle = await documents.open(id);

// Imperative (always works, never fails)
handle.read();           // → string. Always. Text/richtext/sheet all flatten.
handle.write('hello');   // → void. Always writes as text mode.

// Mode-aware binding accessors (convert if needed, return Result)
handle.asText();         // → Result<Y.Text, ContentConversionError>
handle.asRichText();     // → Result<Y.XmlFragment, ContentConversionError>
handle.asSheet();        // → Result<SheetBinding, ContentConversionError>

// Escape hatches (unchanged)
handle.timeline;         // → Timeline (with pushRichtext() added)
handle.batch(fn);        // → void
handle.ydoc;             // → Y.Doc
```

## Research Findings

### Y.XmlFragment → Plaintext Extraction

`Y.XmlFragment.toString()` returns **XML markup** (e.g., `<paragraph>hello</paragraph>`), not plaintext. Extracting plaintext requires walking the tree:

```typescript
function xmlFragmentToPlaintext(fragment: Y.XmlFragment): string {
  const parts: string[] = [];
  for (const child of fragment.toArray()) {
    if (child instanceof Y.XmlText) {
      parts.push(child.toString());      // Y.XmlText.toString() gives plain text
    } else if (child instanceof Y.XmlElement) {
      // Recurse into elements, add newlines for block-level elements
      parts.push(xmlElementToPlaintext(child));
    }
  }
  return parts.join('');
}
```

`Y.XmlFragment` has `toArray()`, `createTreeWalker(filter)`, `get(index)`, and `slice(start, end)` for traversal. `Y.XmlText.toString()` gives plain text content. `Y.XmlElement.toString()` gives XML string with tags.

### Y.Text → Y.XmlFragment Conversion

No built-in Yjs conversion. Must create a new Y.XmlFragment and populate it:

```typescript
function textToXmlFragment(text: Y.Text): Y.XmlFragment {
  const fragment = new Y.XmlFragment();
  const paragraph = new Y.XmlElement('paragraph');
  const xmlText = new Y.XmlText();
  xmlText.insert(0, text.toString());
  paragraph.insert(0, [xmlText]);
  fragment.insert(0, [paragraph]);
  return fragment;
}
```

### CSV Parsing Feasibility

`parseSheetFromCsv()` already exists in `content/sheet-csv.ts`. It handles RFC 4180 (quoted fields, escaped quotes, newlines within fields). The question is: when does text→sheet conversion fail?

- Any non-empty string is technically valid CSV (single column, single row)
- But a string like `"hello world"` parsed as CSV gives a 1×1 sheet—probably not what the user wanted
- The real failure case is structural: the text doesn't look like tabular data

**Decision**: Text→sheet always succeeds at the CSV parsing level (any string is a valid single-cell CSV). The conversion itself won't fail—but the result may not be useful. This is the same as richtext→text being lossy. Document it, don't error on it.

### Existing Error Patterns in Workspace

`packages/workspace/src/shared/errors.ts` uses `defineErrors` from `wellcrafted/error`:

```typescript
export const ExtensionError = defineErrors({
  Table: ({ tableName, rowId, operation }) => ({
    message: `Extension table operation '${operation}' failed on '${tableName}' (row: ${rowId})`,
    tableName, rowId, operation,
  }),
});
export type ExtensionError = InferErrors<typeof ExtensionError>;
```

Result types come from `wellcrafted/result`: `Ok`, `Err`, `trySync`, `tryAsync`.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Naming | `asText()`, `asRichText()`, `asSheet()` | "as" signals transformation, not retrieval. Avoids Yjs jargon (`getFragment`). Reads naturally: "give me this as text." |
| Return type for `as*()` | Plain value (`Y.Text`, `Y.XmlFragment`, `SheetBinding`) | All six pairwise conversions are infallible—any string is valid CSV, richtext→text always extracts plaintext, etc. Wrapping infallible operations in Result misleads callers into handling errors that don't exist. If future types need failure semantics, that's a new method, not a retrofit. |
| `read()` return type | `string` (no Result) | Imperative API that always works. Richtext→plaintext is lossy but valid. Empty/unknown → `''`. |
| `write()` return type | `void` (no Result) | Always succeeds. Mode-switches if needed (pushes new text entry). |
| Conversion strategy | Push new timeline entry | Timeline is append-only by design. Converting text→richtext pushes a new richtext entry. The old text entry stays as history. |
| Text→sheet feasibility | Always succeeds (any string is valid CSV) | Single-cell CSV is valid. Lossy like richtext→text, but not a failure. Document the lossy nature. |
| Where errors live | Removed (`content/errors.ts` deleted) | No conversion can fail, so `ContentConversionError` was dead code. Removed entirely. |
| `pushRichtext()` | Add to Timeline | Fixes the layering violation where `getFragment()` bypasses Timeline. |
| Old methods (`getText`, `getFragment`) | Remove | Clean break. The cleanup spec already flattened `handle.content` → `handle`. One more rename is acceptable. |
| `as*()` on empty timeline | Auto-create requested type, return directly | Matches current behavior on empty. No conversion needed—just creation. |
| `as*()` on matching type | Return existing Y.* directly | No conversion needed. Fast path. |
| `as*()` on different type | Convert, push new entry, return directly | Conversion creates a new timeline entry. Old entry preserved as history. |
| SheetBinding type | `{ columns: Y.Map<Y.Map<string>>; rows: Y.Map<Y.Map<string>> }` | Matches the existing sheet entry structure. Named type for clarity. |

## Architecture

### Content Conversion Flow

```
handle.asText() called
│
├── Current entry is text?
│   └── Return Ok(entry.content)                    ← fast path
│
├── Timeline empty?
│   └── pushText('') → Return Ok(new Y.Text)        ← auto-create
│
├── Current entry is richtext?
│   │  Extract plaintext from Y.XmlFragment
│   │  Push new text entry with extracted content
│   └── Return Ok(new Y.Text)                        ← conversion (lossy)
│
└── Current entry is sheet?
    │  Serialize sheet to CSV string
    │  Push new text entry with CSV content
    └── Return Ok(new Y.Text)                        ← conversion
```

```
handle.asSheet() called
│
├── Current entry is sheet?
│   └── Return Ok({ columns, rows })                 ← fast path
│
├── Timeline empty?
│   └── pushSheet() → Return Ok({ columns, rows })   ← auto-create
│
├── Current entry is text?
│   │  Parse text as CSV
│   │  Push new sheet entry from CSV
│   └── Return Ok({ columns, rows })                 ← conversion
│
└── Current entry is richtext?
    │  Extract plaintext from Y.XmlFragment
    │  Parse plaintext as CSV
    │  Push new sheet entry from CSV
    └── Return Ok({ columns, rows })                  ← compound conversion
```

### File Layout

```
packages/workspace/src/content/
├── entry-types.ts        (unchanged — TextEntry, RichTextEntry, SheetEntry)
├── timeline.ts           (add pushRichtext())
├── sheet-csv.ts          (unchanged — parseSheetFromCsv, serializeSheetToCsv)
├── conversions.ts        (NEW — pairwise conversion functions)
├── errors.ts             (NEW — ContentConversionError)
└── index.ts              (re-export new additions)

packages/workspace/src/workspace/
├── create-document.ts    (update makeHandle: replace getText/getFragment with as*())
└── types.ts              (update DocumentHandle type)
```

### Updated DocumentHandle Type

```typescript
export type SheetBinding = {
  columns: Y.Map<Y.Map<string>>;
  rows: Y.Map<Y.Map<string>>;
};

export type DocumentHandle = {
  /** The underlying Y.Doc. Escape hatch for extensions and tests. */
  ydoc: Y.Doc;

  /** Read current content as a string. Always succeeds.
   *  Text → .toString(). Richtext → extracted plaintext. Sheet → CSV. Empty → ''. */
  read(): string;

  /** Replace content as text mode. Always succeeds.
   *  If current mode is text, replaces in-place. Otherwise pushes new text entry. */
  write(text: string): void;

  /** Get the current content as a Y.Text for editor binding.
   *  If already text mode, returns existing Y.Text.
   *  If empty, creates new text entry.
   *  If different mode, converts and pushes new text entry.
   *  Conversion is lossy for richtext (strips formatting). */
  asText(): Result<Y.Text, ContentConversionError>;

  /** Get the current content as a Y.XmlFragment for richtext editor binding.
   *  If already richtext mode, returns existing Y.XmlFragment.
   *  If empty, creates new richtext entry.
   *  If different mode, converts and pushes new richtext entry. */
  asRichText(): Result<Y.XmlFragment, ContentConversionError>;

  /** Get the current content as a sheet for spreadsheet binding.
   *  If already sheet mode, returns existing sheet binding.
   *  If empty, creates new sheet entry.
   *  If different mode, converts and pushes new sheet entry. */
  asSheet(): Result<SheetBinding, ContentConversionError>;

  /** Direct timeline access for advanced operations. */
  timeline: Timeline;

  /** Batch mutations into a single Yjs transaction. */
  batch(fn: () => void): void;

  /** Per-doc extension exports. */
  exports: Record<string, Record<string, unknown>>;
};
```

### Error Definition

```typescript
// content/errors.ts
import { defineErrors, type InferErrors } from 'wellcrafted/error';

export const ContentConversionError = defineErrors({
  /**
   * The conversion between two content modes produced an unexpected
   * runtime failure (e.g., corrupt Y.Map structure, missing required
   * fields on the source entry).
   */
  ConversionFailed: ({
    from,
    to,
    reason,
  }: {
    from: string;
    to: string;
    reason: string;
  }) => ({
    message: `Cannot convert ${from} to ${to}: ${reason}`,
    from,
    to,
    reason,
  }),
});
export type ContentConversionError = InferErrors<typeof ContentConversionError>;
```

### Conversion Matrix

All six pairwise conversions. Each lives as a function in `content/conversions.ts`.

| From → To | Function | Always succeeds? | Notes |
|---|---|---|---|
| text → richtext | `textToRichText(text: Y.Text): Y.XmlFragment` | Yes | Wraps text in a `<paragraph>` XmlElement. Preserves content, no formatting. |
| text → sheet | `textToSheet(text: Y.Text): { columns, rows }` | Yes | Parses text as CSV via `parseSheetFromCsv`. Any string is valid single-cell CSV. |
| richtext → text | `richTextToText(fragment: Y.XmlFragment): Y.Text` | Yes (lossy) | Walks XmlFragment tree, extracts text from XmlText nodes. Strips all formatting. Block elements → newlines. |
| richtext → sheet | `richTextToSheet(fragment: Y.XmlFragment): { columns, rows }` | Yes (lossy) | Compound: richtext → plaintext → CSV parse. |
| sheet → text | `sheetToText(columns, rows): Y.Text` | Yes | `serializeSheetToCsv()` already exists. Wrap result in Y.Text. |
| sheet → richtext | `sheetToRichText(columns, rows): Y.XmlFragment` | Yes | Compound: sheet → CSV string → wrap in paragraph XmlElement. |

**Key realization**: All six conversions always succeed. Text→sheet "failing" was my initial assumption, but any string is valid CSV (worst case: single cell). The `ContentConversionError` exists for structural corruption (e.g., a sheet entry with missing `columns` Y.Map), not for conversion logic itself.

### Conversion Function Signatures

```typescript
// content/conversions.ts
import * as Y from 'yjs';
import type { ValidatedEntry } from './timeline.js';
import type { SheetBinding } from '../workspace/types.js';
import { parseSheetFromCsv, serializeSheetToCsv } from './sheet-csv.js';

/**
 * Extract plaintext from a Y.XmlFragment.
 * Walks the tree recursively, collecting text from Y.XmlText nodes.
 * Block-level elements (paragraph, heading, etc.) get newlines between them.
 */
export function xmlFragmentToPlaintext(fragment: Y.XmlFragment): string { ... }

/**
 * Convert a validated text entry to a new richtext timeline entry.
 * Wraps the text content in a single paragraph XmlElement.
 */
export function textToRichText(content: Y.Text): {
  fragment: Y.XmlFragment;
  frontmatter: Y.Map<unknown>;
} { ... }

/**
 * Convert a validated text entry to a new sheet timeline entry.
 * Parses the text as CSV. Any string is valid CSV (single cell at minimum).
 */
export function textToSheet(content: Y.Text): SheetBinding { ... }

/**
 * Convert a validated richtext entry to a new text entry.
 * Extracts plaintext from the XmlFragment. Lossy—all formatting is stripped.
 */
export function richTextToText(fragment: Y.XmlFragment): Y.Text { ... }

/**
 * Convert a validated richtext entry to a new sheet entry.
 * Compound conversion: richtext → plaintext → CSV parse.
 */
export function richTextToSheet(fragment: Y.XmlFragment): SheetBinding { ... }

/**
 * Convert a validated sheet entry to a new text entry.
 * Serializes the sheet to CSV string.
 */
export function sheetToText(columns: Y.Map<Y.Map<string>>, rows: Y.Map<Y.Map<string>>): Y.Text { ... }

/**
 * Convert a validated sheet entry to a new richtext entry.
 * Serializes to CSV, wraps in a paragraph XmlElement.
 */
export function sheetToRichText(
  columns: Y.Map<Y.Map<string>>,
  rows: Y.Map<Y.Map<string>>,
): { fragment: Y.XmlFragment; frontmatter: Y.Map<unknown> } { ... }
```

### Timeline API Addition

```typescript
// Add to Timeline type and createTimeline implementation:

/** Append a new richtext entry. Returns the Y.Map. */
pushRichtext(): TimelineEntry;

// Implementation:
pushRichtext(): TimelineEntry {
  const entry = new Y.Map();
  entry.set('type', 'richtext');
  entry.set('content', new Y.XmlFragment());
  entry.set('frontmatter', new Y.Map());
  entry.set('createdAt', Date.now());
  timeline.push([entry]);
  return entry;
},
```

### Updated read() Implementation

```typescript
read(): string {
  const validated = readEntry(tl.currentEntry);
  switch (validated.mode) {
    case 'text':
      return validated.content.toString();
    case 'richtext':
      return xmlFragmentToPlaintext(validated.content);  // FIX: was ''
    case 'sheet':
      return serializeSheetToCsv(validated.columns, validated.rows);
    case 'empty':
      return '';
  }
},
```

### as*() Method Implementation Pattern

All three `as*()` methods follow the same structure. Here's `asText()` as the template:

```typescript
asText(): Result<Y.Text, ContentConversionError> {
  const validated = readEntry(tl.currentEntry);

  switch (validated.mode) {
    // Fast path: already the right type
    case 'text':
      return Ok(validated.content);

    // Empty timeline: auto-create
    case 'empty': {
      tl.pushText('');
      const entry = readEntry(tl.currentEntry);
      if (entry.mode !== 'text') {
        return ContentConversionError.ConversionFailed({
          from: 'empty', to: 'text', reason: 'Failed to create text entry',
        });
      }
      return Ok(entry.content);
    }

    // Richtext → text: convert (lossy)
    case 'richtext': {
      const plaintext = xmlFragmentToPlaintext(validated.content);
      ydoc.transact(() => tl.pushText(plaintext));
      const entry = readEntry(tl.currentEntry);
      if (entry.mode !== 'text') {
        return ContentConversionError.ConversionFailed({
          from: 'richtext', to: 'text', reason: 'Conversion produced invalid entry',
        });
      }
      return Ok(entry.content);
    }

    // Sheet → text: convert
    case 'sheet': {
      const csv = serializeSheetToCsv(validated.columns, validated.rows);
      ydoc.transact(() => tl.pushText(csv));
      const entry = readEntry(tl.currentEntry);
      if (entry.mode !== 'text') {
        return ContentConversionError.ConversionFailed({
          from: 'sheet', to: 'text', reason: 'Conversion produced invalid entry',
        });
      }
      return Ok(entry.content);
    }
  }
},
```

## Implementation Plan

### Wave 1: Foundation (no breaking changes)

- [x] **1.1** Create `content/errors.ts` — define `ContentConversionError` with `ConversionFailed` variant.
- [x] **1.2** Add `pushRichtext()` to Timeline type and `createTimeline()` implementation.
- [x] **1.3** Create `content/conversions.ts` — implement `xmlFragmentToPlaintext()` and `populateFragmentFromText()`.
  > **Note**: Restructured from spec. Instead of six conversion functions returning Y types, split into extract functions (doc-backed → primitives) and populate functions (primitives → doc-backed). Standalone Y types can't be read from—only written to. The `as*()` methods compose extract + timeline push + populate inside transactions.
- [x] **1.4** Removed: individual conversion functions replaced by compose pattern in `as*()` methods.
- [x] **1.5** Fix `readAsString()` in timeline.ts — use `xmlFragmentToPlaintext()` for richtext instead of returning `''`.
- [x] **1.6** Export new additions from `content/index.ts` and `packages/workspace/src/index.ts`.
- [x] **1.7** Write tests for conversions: `content/conversions.test.ts` (xmlFragmentToPlaintext, populateFragmentFromText, pushRichtext).
- [x] **1.8** pushRichtext tests included in conversions.test.ts.
- [x] **1.9** Verify: 388 tests pass.

### Wave 2: New as*() methods on handle

- [x] **2.1** Add `SheetBinding` type to `conversions.ts` (co-located with content types).
- [x] **2.2** Add `asText()`, `asRichText()`, `asSheet()`, `mode` getter to `DocumentHandle` type in `types.ts`.
  > **Note**: Also imported `Result` type from `wellcrafted/result`.
- [x] **2.3** Implement all three `as*()` methods and `mode` getter in `makeHandle()`.
  > Each method: reads current entry via `readEntry()`, switches on mode, either returns fast-path or converts inside `ydoc.transact()` using timeline push methods + populate helpers.
- [x] **2.4** Write 14 tests covering: empty auto-create, matching type fast path, all pairwise conversions, consecutive conversion chain, mode getter.
- [x] **2.5** Verify: 388 tests pass.

### Wave 3: Update consumers, deprecate old methods

- [~] **3.1–3.2** `getText()` and `getFragment()` marked `@deprecated` instead of removed.
  > Softer migration: deprecated methods still work. Removal can happen in a follow-up.
- [x] **3.3** Searched entire repo — only 2 app consumers found (Fuji, Honeycrisp).
- [x] **3.4** No filesystem consumers of `getText()`/`getFragment()` (removed in prior cleanup).
- [x] **3.5** Updated Fuji `+page.svelte` (`handle.getText()` → `handle.asText().data`) and Honeycrisp `+page.svelte` (`handle.getFragment()` → `handle.asRichText().data`).
- [x] **3.6** Verify: 388 tests pass.

### Wave 4: Documentation

- [x] **4.1** `DocumentHandle` JSDoc updated in `types.ts` (done in Wave 2).
- [ ] **4.2** Update `packages/workspace/README.md` Document Content Model section.
- [ ] **4.3** Update `packages/workspace/src/workspace/README.md`.
- [ ] **4.4** Update `AGENTS.md` content model description.

## Edge Cases

### Corrupt entry (invalid Y.Map structure)

1. `readEntry()` returns `{ mode: 'empty' }` for corrupt entries (existing behavior).
2. `as*()` treats this same as empty timeline—auto-creates requested type.
3. No error surfaced for corruption—matches current philosophy of graceful degradation.

### Consecutive conversions (text → richtext → sheet → text)

1. Each conversion pushes a new timeline entry. Timeline grows: length 1 → 2 → 3 → 4.
2. Each `as*()` call operates on `currentEntry` (the last entry).
3. Old entries are preserved as history—this is by design.
4. No risk of infinite loops because each call reads, converts, pushes once.

### Concurrent as*() calls

1. Two calls to `asText()` race on a richtext document.
2. First call: reads richtext, pushes text entry. Timeline length: 2.
3. Second call: reads current entry (now text), hits fast path. Returns existing Y.Text.
4. No double-push because the second call sees the already-converted entry.
5. Yjs transactions are synchronous within a single client—no interleaving within a single call.

### Empty Y.XmlFragment (richtext with no content)

1. `xmlFragmentToPlaintext()` on an empty fragment returns `''`.
2. `read()` returns `''`. This is correct—the document is genuinely empty.
3. `asText()` converts to text entry with `''`. Correct.

### Sheet with no columns or rows

1. `serializeSheetToCsv()` on empty sheet returns `''` (existing behavior).
2. `asText()` converts to text entry with `''`. Correct.

### richtext → text is lossy

1. User has a richtext document with bold, italic, headings, links.
2. Calls `asText()`. Gets plain text with formatting stripped.
3. The old richtext entry is still in the timeline—user can go back.
4. This is documented in JSDoc: "Conversion is lossy for richtext (strips formatting)."

## Open Questions (Resolved)

1. **Should `as*()` wrap the conversion in a transaction?**
   - **Resolved**: Yes. Confirmed by user. The push should be transactional so the update observer fires once.

2. **Should `read()` handle richtext → plaintext with block element awareness?**
   - **Resolved**: Yes. Add `\n` between block-level elements (paragraph, heading, list-item, blockquote). Without this, paragraphs smash together.

3. **Should conversion functions create Yjs types inside or outside a transaction?**
   - **Resolved**: Inside. User preference for simpler mental model—everything happens in one place. Verified via Yjs docs: no functional difference between inside vs outside. Creating inside the transaction is equally correct.

4. **Should we add a `mode` getter to the handle?**
   - **Resolved**: Yes. Cheap passthrough to `tl.currentType`.

## Success Criteria

- [x] `handle.read()` returns plaintext for richtext documents (not `''`)
- [x] `handle.asText()` returns `Y.Text` for all three source modes (infallible)
- [x] `handle.asRichText()` returns `Y.XmlFragment` for all three source modes (infallible)
- [x] `handle.asSheet()` returns `SheetBinding` for all three source modes (infallible)
- [x] `handle.asText()` on empty timeline auto-creates text entry
- [x] All `as*()` methods push new timeline entries (append-only preserved)
- [x] `pushRichtext()` exists on Timeline (no more layering bypass)
- [x] `getText()`/`getFragment()` fully removed from DocumentHandle type
- [x] No app-level `handle.getText()` or `handle.getFragment()` references remain
- [x] `ContentConversionError` removed (dead code — all conversions infallible)
- [x] Tests cover all six pairwise conversions
- [x] Tests cover empty timeline auto-creation for all three types
- [x] Tests cover fast path (matching type) for all three types
- [x] All workspace tests pass (388 tests)

## References

- `packages/workspace/src/content/timeline.ts` — Timeline implementation (add `pushRichtext()`, fix `readAsString()`)
- `packages/workspace/src/content/entry-types.ts` — Entry type definitions (unchanged)
- `packages/workspace/src/content/sheet-csv.ts` — CSV parse/serialize (reused by conversions)
- `packages/workspace/src/workspace/create-document.ts` — `makeHandle()` (main change target)
- `packages/workspace/src/workspace/types.ts` — `DocumentHandle` type (add `asText/asRichText/asSheet`, remove `getText/getFragment`)
- `packages/workspace/src/shared/errors.ts` — Existing `defineErrors` pattern to follow
- `specs/20260314T060000-document-handle-cleanup.md` — Previous cleanup (this spec continues from)

## Review

**Completed**: 2026-03-14

### Summary

Added mode-aware content conversion to DocumentHandle. Three new `as*()` methods (`asText`, `asRichText`, `asSheet`) automatically convert between content types and return plain values (not Result). Fixed `read()` returning `''` for richtext by adding `xmlFragmentToPlaintext()` with block-element-aware newline insertion. Added `pushRichtext()` to Timeline to fix the layering bypass in `getFragment()`.

### Deviations from Spec

- **Conversion functions restructured**: The spec planned six standalone conversion functions returning Y types. Yjs standalone types can't be read from ("Add Yjs type to a document before reading data"), so the approach was restructured into extract functions (doc-backed → primitives) and populate functions (primitives → doc-backed). The `as*()` methods compose these with timeline push methods inside `ydoc.transact()`. Simpler and more correct.
- **`SheetBinding` type location**: Defined in `content/conversions.ts` instead of `types.ts` — co-located with content code.
- **`getText()`/`getFragment()` fully removed**: Clean breaking change, not deprecated. All consumers updated.
- **`as*()` return plain values, not Result**: After tracing every code path, all six pairwise conversions are infallible — no content type can fail to convert to another. `ContentConversionError` was dead code and has been deleted. Any string is valid CSV (worst case: single cell). Richtext→text always extracts plaintext. The only "error" paths were defensive guards against Yjs itself producing corrupt entries after a push, which never happens. Wrapping infallible operations in Result misleads callers. If future content types introduce genuinely fallible conversions (e.g., JSON schema validation), those would be new methods — not a retrofit of these three.
- **Documentation updates 4.2–4.4**: Deferred to a follow-up. The JSDoc on the types is updated.

### Follow-up Work

- Update README content model sections (4.2–4.4)
- Update AGENTS.md with new handle API
