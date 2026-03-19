# Document Handle API Cleanup

**Date**: 2026-03-14
**Status**: Implemented
**Depends on**: `specs/20260313T230000-promote-timeline-to-workspace.md` (complete)

## Overview

Surgical cleanup of the document handle API: flatten the `handle.content` namespace, remove binary mode, remove legacy migration, add validated entry reading, separate filesystem write methods by mode, and add `createdAt` metadata to timeline entries for future revision history.

## Changes

### 1. Flatten `handle.content` → `handle.read/write/getText/getFragment/timeline`

**Why**: The `.content` namespace has no sibling namespaces and never will. The handle IS the content interface. `handle.content.read()` is unnecessary indirection.

**Before**:
```typescript
type DocumentHandle = {
  ydoc: Y.Doc;
  content: DocumentContent;
  exports: Record<string, Record<string, unknown>>;
};

type DocumentContent = {
  read(): string;
  write(text: string): void;
  getText(): Y.Text | undefined;
  getFragment(): Y.XmlFragment | undefined;
  timeline: Timeline;
};

// Usage
handle.content.read();
handle.content.write('hello');
handle.content.getText();
handle.content.timeline.pushText('hi');
```

**After**:
```typescript
type DocumentHandle = {
  ydoc: Y.Doc;
  read(): string;
  write(text: string): void;
  getText(): Y.Text | undefined;
  getFragment(): Y.XmlFragment | undefined;
  timeline: Timeline;
  exports: Record<string, Record<string, unknown>>;
};

// Usage
handle.read();
handle.write('hello');
handle.getText();
handle.timeline.pushText('hi');
```

**Files**:
- `packages/workspace/src/workspace/types.ts` — Inline `DocumentContent` fields into `DocumentHandle`. Delete `DocumentContent` type.
- `packages/workspace/src/workspace/create-document.ts` — `makeHandle()` returns flat object (no nested `content`).
- `packages/workspace/src/workspace/create-document.test.ts` — Update `handle.content.read()` → `handle.read()`, `handle.content.write()` → `handle.write()`.
- `packages/workspace/src/index.ts` — Remove `DocumentContent` export.
- `packages/filesystem/src/content/content.ts` — Update all `handle.content.read()` → `handle.read()`, `handle.content.write()` → `handle.write()`, `handle.content.timeline` → `handle.timeline`.

**Search for all consumers**: `grep -r "handle\.content\." --include="*.ts" --include="*.svelte"` across the entire repo. Every hit must be updated.

### 2. Remove binary mode

**Why**: Binary blobs aren't collaborative data. Storing them in Y.Docs inflates sync, can't merge, and should live in external blob storage with a reference in the doc. Text, richtext, and sheet are the collaborative types.

**Files**:

- `packages/workspace/src/content/entry-types.ts`:
  - Delete `BinaryEntry` type.
  - Remove `BinaryEntry` from `TimelineEntry` union.
  - `ContentType` automatically narrows to `'text' | 'richtext' | 'sheet'`.

- `packages/workspace/src/content/timeline.ts`:
  - Delete `pushBinary()` method from `Timeline` type and implementation.
  - Remove `case 'binary'` from `readAsString()` switch.
  - Remove `case 'binary'` from `readAsBuffer()` switch. **Note**: `readAsBuffer()` itself may no longer be useful without binary—evaluate whether to keep or remove.

- `packages/workspace/src/content/index.ts` — Remove `BinaryEntry` export.
- `packages/workspace/src/index.ts` — Remove `BinaryEntry` export.

- `packages/filesystem/src/content/content.ts`:
  - Remove `readBuffer()` method from `ContentHelpers` type and implementation.
  - Remove `Uint8Array` branch from `write()` (it only handles binary).
  - Remove binary branch from `append()` (the `else if (tl.currentType === 'binary')` case).

- `packages/filesystem/src/content/entry-types.ts` — Remove `BinaryEntry` re-export.

**Search**: `grep -r "pushBinary\|readBuffer\|BinaryEntry\|'binary'" --include="*.ts"` across the entire repo. Every hit must be addressed.

### 3. Remove legacy migration

**Why**: Clean break. No production data depends on the old `Y.Text('content')` store. The dual-store issue was fixed in the previous PR and the migration was a transitional safety net.

**Files**:

- `packages/workspace/src/workspace/create-document.ts`:
  - Delete the `migrateIfNeeded()` function entirely.
  - Remove all `migrateIfNeeded()` calls from `read()`, `write()`, `getText()`, `getFragment()` in `makeHandle()`.

That's it. One function deletion, four call site removals.

### 4. Add validated entry reader (eliminate `as` casts)

**Why**: Every timeline entry access uses unsafe `entry.get('content') as Y.Text`. One corrupt entry = runtime crash with zero context. The tables API already validates on read—timeline should too.

**Add to `packages/workspace/src/content/timeline.ts`**:

```typescript
import * as Y from 'yjs';

/**
 * Validated timeline entry — discriminated union with runtime-checked types.
 * Returned by `readEntry()` instead of raw `Y.Map.get()` + unsafe casts.
 */
export type ValidatedEntry =
  | { mode: 'text'; content: Y.Text; createdAt: number }
  | { mode: 'richtext'; content: Y.XmlFragment; frontmatter: Y.Map<unknown>; createdAt: number }
  | { mode: 'sheet'; columns: Y.Map<Y.Map<string>>; rows: Y.Map<Y.Map<string>>; createdAt: number }
  | { mode: 'empty' };

/**
 * Validate a raw timeline entry and return a typed discriminated union.
 * Returns `{ mode: 'empty' }` for undefined, corrupt, or unrecognized entries.
 */
export function readEntry(entry: Y.Map<unknown> | undefined): ValidatedEntry {
  if (!entry) return { mode: 'empty' };
  const type = entry.get('type');
  const createdAt = (entry.get('createdAt') as number) ?? 0;

  if (type === 'text') {
    const content = entry.get('content');
    if (content instanceof Y.Text) return { mode: 'text', content, createdAt };
  }
  if (type === 'richtext') {
    const content = entry.get('content');
    const frontmatter = entry.get('frontmatter');
    if (content instanceof Y.XmlFragment && frontmatter instanceof Y.Map) {
      return { mode: 'richtext', content, frontmatter, createdAt };
    }
  }
  if (type === 'sheet') {
    const columns = entry.get('columns');
    const rows = entry.get('rows');
    if (columns instanceof Y.Map && rows instanceof Y.Map) {
      return { mode: 'sheet', columns: columns as Y.Map<Y.Map<string>>, rows: rows as Y.Map<Y.Map<string>>, createdAt };
    }
  }

  return { mode: 'empty' };
}
```

Then update `readAsString()`, `readAsBuffer()`, and `makeHandle()` methods to use `readEntry()` instead of raw `entry.get() as T` casts.

**Also update `packages/filesystem/src/content/content.ts`** — the `write()` and `append()` methods have raw casts like `tl.currentEntry?.get('content') as import('yjs').Text`. These should use `readEntry()` or at minimum `instanceof` checks.

**Export**: `ValidatedEntry` and `readEntry` from `packages/workspace/src/content/index.ts` and `packages/workspace/src/index.ts`.

### 5. Separate filesystem write methods by mode

**Why**: `write(fileId, data: string | Uint8Array)` has three completely different strategies (text, sheet CSV repopulation, binary) crammed into one function. Each mode should be explicit.

**Before** (`packages/filesystem/src/content/content.ts`):
```typescript
type ContentHelpers = {
  read(fileId: FileId): Promise<string>;
  readBuffer(fileId: FileId): Promise<Uint8Array>;  // removed in step 2
  write(fileId: FileId, data: string | Uint8Array): Promise<number>;
  append(fileId: FileId, data: string): Promise<number | null>;
};
```

**After**:
```typescript
type ContentHelpers = {
  read(fileId: FileId): Promise<string>;
  writeText(fileId: FileId, text: string): Promise<number>;
  writeSheet(fileId: FileId, csv: string): Promise<number>;
  append(fileId: FileId, data: string): Promise<number | null>;
};
```

- `writeText()` — Delegates to `handle.write(text)`. Works regardless of current mode (creates new text entry if needed).
- `writeSheet()` — Clears and repopulates the current sheet entry's Y.Maps from CSV. If no sheet entry exists, pushes one first.
- `append()` — Stays as-is but remove the binary branch.
- `read()` — Stays as-is.

**Consumers**: Search for `fs.content.write(` and `content.write(` calls across apps. Each call site must choose `writeText()` or `writeSheet()` explicitly. This is a breaking change to the filesystem API surface.

### 6. Add `createdAt` to timeline entries

**Why**: Timeline entries currently have no metadata. For future revision history (Google Docs-style), each entry needs at minimum a creation timestamp. Adding this now is trivial and avoids a migration later.

**Files**:

- `packages/workspace/src/content/entry-types.ts` — Add `createdAt: number` to each entry type:
  ```typescript
  export type TextEntry = { type: 'text'; content: Y.Text; createdAt: number };
  export type RichTextEntry = { type: 'richtext'; content: Y.XmlFragment; frontmatter: Y.Map<unknown>; createdAt: number };
  export type SheetEntry = { type: 'sheet'; columns: Y.Map<Y.Map<string>>; rows: Y.Map<Y.Map<string>>; createdAt: number };
  ```

- `packages/workspace/src/content/timeline.ts` — Every `push*()` method sets `entry.set('createdAt', Date.now())`:
  ```typescript
  pushText(content: string): TimelineEntry {
    const entry = new Y.Map();
    entry.set('type', 'text');
    entry.set('createdAt', Date.now());
    // ...
  }
  ```

- The `readEntry()` validator (from step 4) already reads `createdAt` with a `?? 0` fallback, so existing entries without `createdAt` work fine.

## Implementation Order

Changes are ordered by dependency. Each wave can be committed independently.

### Wave 1: Remove binary mode + remove legacy migration (independent, parallel)
- [x] **1a** Remove `BinaryEntry` from entry types, timeline, index exports
- [x] **1b** Remove `pushBinary()` and `readBuffer()` from timeline
- [x] **1c** Remove binary handling from filesystem `content.ts` (`readBuffer`, binary branch in `write`, binary branch in `append`)
- [x] **1d** Remove `migrateIfNeeded()` from `create-document.ts` and all call sites
- [x] **1e** Remove binary re-exports from filesystem `entry-types.ts`
- [x] **1f** Verify: `bun test` in `packages/workspace` and `packages/filesystem`
  > **Note**: Also updated `file-system.ts` to remove binary detection in `cp()`, convert Uint8Array to text in `writeFile()`, and reimplement `readFileBuffer()` as text-encode. Updated all binary-specific tests in `file-system.test.ts`.

### Wave 2: Add `createdAt` + validated entry reader
- [x] **2a** Add `createdAt: number` to entry types in `entry-types.ts`
- [x] **2b** Add `createdAt` to all `push*()` methods in `timeline.ts`
- [x] **2c** Add `ValidatedEntry` type and `readEntry()` function to `timeline.ts`
- [x] **2d** Update `readAsString()` and `readAsBuffer()` to use `readEntry()` internally
- [x] **2e** Export `ValidatedEntry` and `readEntry` from content index and workspace index
- [x] **2f** Verify: `bun test` in `packages/workspace`

### Wave 3: Flatten `handle.content` namespace
- [x] **3a** Inline `DocumentContent` fields into `DocumentHandle` type in `types.ts`. Delete `DocumentContent`.
- [x] **3b** Update `makeHandle()` in `create-document.ts` to return flat object
- [x] **3c** Update `create-document.test.ts` — `handle.content.read()` → `handle.read()` etc.
- [x] **3d** Update `packages/filesystem/src/file-system.ts` — all `handle.content.*` → `handle.*`
  > **Note**: `content.ts` was inlined into `file-system.ts` in a prior refactor.
- [x] **3e** Search entire repo for `handle.content.` — zero hits in .ts/.svelte files
- [x] **3f** Remove `DocumentContent` export from `packages/workspace/src/index.ts`
- [x] **3g** Update AGENTS.md, README.md, workspace README referencing `handle.content`
- [x] **3h** Verify: `bun test` across workspace and filesystem — 548 tests pass

### Wave 4: Separate filesystem write methods
- [~] **4a-4d** Skipped — `content.write()` already accepts `string` only after binary removal.
  The existing `write()` method handles text/sheet branching internally. Renaming to
  `writeText()`/`writeSheet()` is a separate, optional cleanup.

### Wave 5: Documentation sweep
- [x] **5a** Update `AGENTS.md` content model description
- [x] **5b** Update `packages/workspace/AGENTS.md`
- [x] **5c** Update `packages/workspace/README.md` Document Content Model section
- [x] **5d** Update `packages/workspace/src/workspace/README.md`
  > Updated during handle content conversion API work (2026-03-14).
- [x] **5e** Update skills referencing `handle.content` (`workspace-api` skill, `yjs` skill)
  > Updated during handle content conversion API work (2026-03-14).

## Out of Scope (separate specs)

- **Reactive handle primitive for UI** — Observable handle that self-manages lifecycle for Svelte components. Separate spec.
- **Default to single document per table** — Dropping named documents (`client.documents.files.content` → `client.documents.files`). Separate spec, bigger API change.
- **Full revision history UI** — Viewing/diffing/naming historical timeline entries. Separate spec. This spec only adds `createdAt` metadata as structural groundwork.
- **`readAsBuffer()` removal** — Evaluate whether this method is still useful after removing binary mode. If all callers are gone, remove it. Handle during implementation.

## Success Criteria

- [x] `handle.read()` works (no `.content` namespace)
- [x] No `BinaryEntry`, `pushBinary`, or `readBuffer` in codebase
- [x] No `migrateIfNeeded` in codebase
- [x] No unsafe `as Y.Text` casts in timeline readers — all go through `readEntry()`
- [x] All timeline entries created with `createdAt` timestamp
- [~] Filesystem has `writeText()` and `writeSheet()` — skipped, `write()` already string-only
- [x] All tests pass across workspace and filesystem (548 tests)
- [x] No `handle.content.` references remain in .ts/.svelte files

## Review

**Completed**: 2026-03-14

### Summary

Cleaned up the document handle API by removing dead binary mode, eliminating unsafe casts
via `ValidatedEntry`/`readEntry()`, and flattening `handle.content.read()` to `handle.read()`.
Also added `createdAt` timestamps to all timeline entries as groundwork for future revision history.

### Deviations from Spec

- **Wave 4 (writeText/writeSheet)**: Skipped. After removing binary mode, `write()` already
  only accepts `string`. The text/sheet branching is internal. Renaming would be pure cosmetics
  with no safety benefit — can be done in a separate pass if desired.
- **ContentHelpers inlined**: The user inlined `ContentHelpers` directly into `file-system.ts`
  (deleting `content.ts`) in a separate commit, which superseded the spec's Wave 4 plan.
- **Additional work**: The user also updated Fuji/Honeycrisp apps and tests in separate commits
  that weren't in the original spec.
