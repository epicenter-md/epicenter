# Simplified Y.Text Content Store

**Date**: 2026-02-11
**Status**: Superseded
**Superseded by**: `specs/20260211T230000-timeline-content-storage-implementation.md`: replaces single `Y.Text('content')` with `Y.Array('timeline')` containing nested shared types. Ephemeral binary store replaced by persistent timeline entries.
**Supersedes**: `specs/20260210T120000-content-format-spec.md` (lens architecture), `specs/20260210T220000-v14-content-storage-spec.md` (v14 content handler)
**Updates**: `specs/20260210T150000-content-storage-format-debate.md` (implements the direction, but with v13 Yjs, not v14)
**See also**: `specs/20260211T220000-yjs-content-doc-multi-mode-research.md`: Decision record with full rationale for Option F.

---

## Problem

Three prior specs pull in different directions:

| Spec | What it proposes | Why it's too much right now |
|------|-----------------|---------------------------|
| content-format-spec | `ContentLens` interface, `FormatRegistry`, namespaced keys (`text:content`, `md:content`), Y.XmlFragment for markdown, healing | Over-engineered for current needs. No WYSIWYG editor exists yet. Healing exists to fix a problem we shouldn't have. |
| content-storage-format-debate | Markdown-text as source of truth, v14 Y.Type | Good direction, but purely architectural analysis. No implementation commitment. |
| v14-content-storage-spec | `ContentHandler`, `applyTextDiff()`, `fm:` prefixed attrs, v14 `@y/y` | Depends on Yjs v14 which is pre-release beta (`v14.0.0-22`). We're on v13. Migrating Yjs versions is a project, not a side-effect. |

Meanwhile, the current implementation uses the old pattern (extension-based format detection, healing, full delete+reinsert on write). The primary goal right now is: **pass the just-bash test suite with a clean, simple Y.Text-based filesystem.**

## Decision: Y.Text('content') Per Document, Nothing Else

Every file's content Y.Doc stores a single `Y.Text` under the key `'content'`.

```
Y.Doc (guid = fileId, gc: false)
└── Y.Text('content')   → the file's text content
```

That's it. No format metadata. No lens registry. No namespaced keys. No healing. No XmlFragment. No frontmatter extraction.

### Why 'content' as the key name

- Descriptive and self-documenting
- Leaves room for future shared types (e.g., `Y.Map('meta')` for metadata later)
- Avoids collision with potential future keys
- Short and clean: `ydoc.getText('content')`

### Why not 'text'

The current codebase uses `'text'` as the Y.Text key. But `'text'` is ambiguous. It could refer to the Yjs type or the content. `'content'` clearly means "the content of this file."

### What about .md files?

`.md` files are stored as plain text. `readFile('/notes.md')` returns the raw markdown string including any `---` frontmatter block. `writeFile('/notes.md', markdown)` writes the raw markdown string. No parsing, no XmlFragment, no frontmatter extraction.

This is the Obsidian model. The markdown string is the source of truth. Rich rendering is a view concern, not a storage concern.

When we build a WYSIWYG editor later, it will:
1. Read the Y.Text content
2. Parse markdown into a ProseMirror tree locally
3. Render the tree
4. Serialize changes back to markdown
5. Apply diffs to the Y.Text

This is proven by the Milkdown POC already in the codebase.

### What about frontmatter?

Frontmatter stays in the text. `readFile` returns it. `writeFile` accepts it. The filesystem is content-agnostic, just like POSIX.

If an application needs to parse frontmatter, it calls `parseFrontmatter()` from `markdown-helpers.ts`. That's an application concern, not a filesystem concern.

---

## Content Doc Store

The `ContentDocStore` is unchanged:

```typescript
type ContentDocStore = {
  ensure(fileId: FileId): Y.Doc;
  destroy(fileId: FileId): void;
  destroyAll(): void;
};
```

`createContentDocStore()` stays the same. One Y.Doc per file, keyed by FileId, `gc: false`.

### Initializing content

When writing to a file's Y.Text for the first time (new file creation), the content is inserted directly:

```typescript
const ydoc = store.ensure(fileId);
const ytext = ydoc.getText('content');
ydoc.transact(() => {
  ytext.delete(0, ytext.length);
  ytext.insert(0, content);
});
```

This is the same pattern for both new files and overwrites. Simple, correct, and the same code path for all file types.

### Future: diff-based writes

The current `writeFile` does full delete+insert. A future optimization would compute a character-level diff and apply surgical insert/delete operations. This preserves concurrent edits from other peers.

This is explicitly NOT part of this spec. Full delete+insert is correct for single-user and for bash agent use. Diff-based writes are an optimization for when we have real-time collaborative editing.

---

## Filesystem Operations

### readFile(path)

```typescript
const ydoc = this.store.ensure(id);
const ytext = ydoc.getText('content');
return ytext.toString();
```

Three lines. No healing. No format detection. No lens lookup.

### writeFile(path, content): new file

```typescript
const id = generateFileId();
this.filesTable.set({
  id, name, parentId, type: 'file',
  size: new TextEncoder().encode(content).byteLength,
  createdAt: Date.now(), updatedAt: Date.now(), trashedAt: null,
});
const ydoc = this.store.ensure(id);
const ytext = ydoc.getText('content');
ydoc.transact(() => {
  ytext.delete(0, ytext.length);
  ytext.insert(0, content);
});
```

### writeFile(path, content): existing file

```typescript
const ydoc = this.store.ensure(id);
const ytext = ydoc.getText('content');
ydoc.transact(() => {
  ytext.delete(0, ytext.length);
  ytext.insert(0, content);
});
this.filesTable.update(id, {
  size: new TextEncoder().encode(content).byteLength,
  updatedAt: Date.now(),
});
```

Same code for .txt, .md, .ts, .json, .csv, everything. The filesystem is content-agnostic.

### mv(src, dest)

```typescript
this.filesTable.update(id, {
  name: newName,
  parentId: newParentId,
  updatedAt: Date.now(),
});
```

Always metadata-only. No extension checking. No content migration. No store.destroy(). One line.

### readFileBuffer(path)

```typescript
const text = await this.readFile(path);
return new TextEncoder().encode(text);
```

Returns the UTF-8 encoding of the text content. This works for text files. For binary files (SQLite), see the Binary Files section below.

---

## Binary Files (SQLite, Uint8Array)

### The problem

just-bash has a built-in `sqlite3` command (via sql.js/WASM). It reads and writes SQLite database files as binary data on the virtual filesystem. The `sqlite3` command uses `readFileBuffer` and `writeFile` with `Uint8Array` data.

A SQLite file is binary. It cannot be meaningfully stored in `Y.Text`. Encoding it as a string (e.g., base64) is wasteful and corrupts the data.

### How just-bash's InMemoryFs handles this

just-bash's native `InMemoryFs` stores **all** file content as `Uint8Array` internally. The `FileEntry.content` type is `string | Uint8Array`, but internally everything is converted to `Uint8Array` via `toBuffer()`. When `readFile()` is called, it reads the buffer then converts back to string via `fromBuffer()`.

This means just-bash treats binary and text as the same storage. The difference is only in how you read it (`readFile` → string, `readFileBuffer` → Uint8Array).

### Our approach: ephemeral binary store

We match this pattern with a two-track storage system:

```
Text files (string writes):
  writeFile(path, "hello")  →  Y.Text('content')  →  collaborative, persistent

Binary files (Uint8Array writes):
  writeFile(path, uint8arr) →  Map<FileId, Uint8Array>  →  ephemeral, in-memory only
```

The `YjsFileSystem` gets a `binaryStore: Map<FileId, Uint8Array>` field:

```typescript
export class YjsFileSystem implements IFileSystem {
  private binaryStore = new Map<FileId, Uint8Array>();
  // ...
}
```

### writeFile with Uint8Array

When `writeFile` receives a `Uint8Array`, store it in the binary map. Don't touch Y.Text at all:

```typescript
async writeFile(path: string, data: FileContent): Promise<void> {
  const resolved = posixResolve(this.cwd, path);
  let id = this.index.pathToId.get(resolved);

  if (!id) {
    // Create metadata row (same as text files)
    const { parentId, name } = this.parsePath(resolved);
    id = generateFileId();
    const size = typeof data === 'string'
      ? new TextEncoder().encode(data).byteLength
      : data.byteLength;
    this.filesTable.set({ id, name, parentId, type: 'file', size, ... });
  }

  if (typeof data === 'string') {
    // Text path: Y.Text('content')
    const ydoc = this.store.ensure(id);
    const ytext = ydoc.getText('content');
    ydoc.transact(() => {
      ytext.delete(0, ytext.length);
      ytext.insert(0, data);
    });
    this.binaryStore.delete(id); // clear any previous binary data
  } else {
    // Binary path: ephemeral in-memory store
    this.binaryStore.set(id, data);
  }

  this.filesTable.update(id, {
    size: typeof data === 'string'
      ? new TextEncoder().encode(data).byteLength
      : data.byteLength,
    updatedAt: Date.now(),
  });
}
```

### readFile (returns string)

Check binary store first. If the file has binary data, decode it (lossy for true binary, but that's what just-bash does too):

```typescript
async readFile(path: string): Promise<string> {
  const id = this.resolveId(resolved);
  const row = this.getRow(id, resolved);

  // Check binary store first
  const binary = this.binaryStore.get(id);
  if (binary) return new TextDecoder().decode(binary);

  // Text path: Y.Text
  const ydoc = this.store.ensure(id);
  return ydoc.getText('content').toString();
}
```

### readFileBuffer (returns Uint8Array)

Check binary store first, fall back to encoding Y.Text content:

```typescript
async readFileBuffer(path: string): Promise<Uint8Array> {
  const id = this.resolveId(resolved);

  // Check binary store first (zero-copy for binary files)
  const binary = this.binaryStore.get(id);
  if (binary) return binary;

  // Text path: encode Y.Text content
  const text = await this.readFile(path);
  return new TextEncoder().encode(text);
}
```

### rm, mv, cp with binary files

- **rm**: Delete from `binaryStore` in addition to soft-deleting metadata and destroying content doc.
- **mv**: Pure metadata update (same as text). Binary data stays keyed by FileId, unaffected.
- **cp**: If source has binary data, copy the Uint8Array to the new FileId's binary store entry.

### Known limitation: binary files are ephemeral

Binary data stored in `binaryStore` is:
- **Not CRDT-backed**: no collaborative merge, no conflict resolution
- **Not persisted**: lost on page reload / app restart
- **Not synced**: only exists on the local client

This is an acknowledged weakness, and it's acceptable because:

1. **Primary use case is text**: code, markdown, config files are all text. These get full Yjs collaboration.
2. **SQLite is a session artifact**: bash agents create SQLite databases as working storage during a session. They're intermediate computation results, not documents that need persistence or collaboration.
3. **Matches InMemoryFs semantics**: just-bash's own InMemoryFs is also ephemeral. Binary files in an in-browser shell session aren't expected to survive page reloads.
4. **Clean upgrade path**: if we ever need persistent binary support, we can add a persistence layer behind the `Map` without changing the IFileSystem interface or the text file path. Options include IndexedDB, Y.Doc binary encoding for transport, or a blob storage service.

---

## What This Spec Removes

| Concept | Where it lived | Why it's gone |
|---------|---------------|---------------|
| `ContentLens` interface | content-format-spec | Over-engineered. One Y.Text key handles all text files. |
| `FormatRegistry` | content-format-spec | No format detection needed. Everything is text. |
| `ContentHandler` | v14-content-storage-spec | Depends on v14. Replaced by direct Y.Text access. |
| `healContentType()` | `convert-on-switch.ts` | No format mismatch possible. One key, one type. |
| `hasContent()` | content-format-spec | Only existed for healing. |
| `openDocument()` | `content-doc-store.ts` | Returns DocumentHandle discriminated union. Unnecessary: just use `ydoc.getText('content')`. |
| `documentHandleToString()` | `content-doc-store.ts` | Replaced by `ydoc.getText('content').toString()`. |
| `getExtensionCategory()` | `convert-on-switch.ts` | Extension doesn't determine storage format. |
| `convertContentType()` | `convert-on-switch.ts` | No conversion needed. Everything is Y.Text. |
| `Y.XmlFragment('richtext')` | content docs | No rich text CRDT storage. Markdown is text. |
| `Y.Map('frontmatter')` | content docs | Frontmatter stays in the text string. |
| `DocumentHandle` union type | `types.ts` | No discriminated union needed. |
| `TextDocumentHandle` | `types.ts` | Unnecessary abstraction. |
| `RichTextDocumentHandle` | `types.ts` | No rich text handle. |
| `ExtensionCategory` type | `convert-on-switch.ts` | Entire concept removed. |
| Namespaced keys (`text:content`, `md:content`) | content-format-spec | One key: `'content'`. |
| `Y.Map('meta')` with format field | content-format-spec | No format metadata in content docs. |
| `applyTextDiff()` | v14-content-storage-spec | Future optimization, not needed now. |
| `fm:` prefixed attrs | v14-content-storage-spec | v14 concept. Not applicable to v13. |
| `convertFormat()` | content-format-spec, v14 spec | No format conversion. Everything is text. |

## What This Spec Keeps

| Concept | Where | Why |
|---------|-------|-----|
| Two-layer architecture | Overall design | Flat metadata table (files) + per-file content docs. Still right. |
| `ContentDocStore` | `content-doc-store.ts` | Y.Doc lifecycle management. `ensure`/`destroy`/`destroyAll`. |
| `FileSystemIndex` | `file-system-index.ts` | Runtime path ↔ id indexes. Unchanged. |
| Files table schema | `file-table.ts` | `type: 'file' \| 'folder'`. Unchanged. |
| `FileId` branding | `types.ts` | Branded Guid. Unchanged. |
| `parseFrontmatter()` | `markdown-helpers.ts` | Still useful for applications. Not used by filesystem. |
| `serializeMarkdownWithFrontmatter()` | `markdown-helpers.ts` | Still useful for applications. Not used by filesystem. |
| `gc: false` on content docs | `createContentDocStore` | Preserves history for future snapshot/undo features. |
| Validation (`validateName`, `assertUniqueName`, `disambiguateNames`) | `validation.ts` | Unchanged. |
| Soft delete via `trashedAt` | Files table | Unchanged. |

---

## Files Modified

| File | Action | What was done |
|------|--------|---------------|
| `content-doc-store.ts` | **Simplified** | Removed `openDocument()` and `documentHandleToString()`. Kept `createContentDocStore()` unchanged. ~30 lines → ~33 lines. |
| `yjs-file-system.ts` | **Simplified** | Removed all imports from `convert-on-switch.ts`, `markdown-helpers.ts`, and `content-doc-store.ts` (except types). Uses `ydoc.getText('content')` directly. `mv()` is always metadata-only. `writeFile` branches on string vs Uint8Array. Added `binaryStore` field. `readFileBuffer` does its own path resolution (avoids double encode/decode for binary). `softDeleteDescendants` also cleans up `binaryStore`. |
| `convert-on-switch.ts` | **Deleted** | Entire file removed. |
| `convert-on-switch.test.ts` | **Deleted** | Entire file removed (10 tests). |
| `types.ts` | **Simplified** | Removed `DocumentHandle`, `TextDocumentHandle`, `RichTextDocumentHandle`. Kept `FileId`, `FileRow`, `FileSystemIndex`, `ContentDocStore`. |
| `markdown-helpers.ts` | **Unchanged** | Still exports utilities for applications. Not used by filesystem. |
| `markdown-helpers.test.ts` | **Unchanged** | |
| `index.ts` | **Updated** | Removed exports of deleted types/functions (`DocumentHandle`, `openDocument`, `documentHandleToString`, `healContentType`, `getExtensionCategory`, `convertContentType`, `ExtensionCategory`). |
| `yjs-file-system.test.ts` | **Updated** | Added binary file support tests (writeFile Uint8Array, readFile on binary, text overwrites binary, cp binary, rm binary). Added mv preservation tests (.txt→.md, .md→.txt). |
| `content-doc-store.test.ts` | **Unchanged** | Only tests `createContentDocStore()`, which was not modified. |

**Net effect**: ~250 lines deleted, ~60 lines added. 99 tests pass (down from 109: removed 10 convert-on-switch tests, added 7 new tests).

---

## Y.Text Key: 'content' vs 'text' (Migration)

The current code uses `'text'` as the Y.Text key. This spec changes it to `'content'`.

**Why change now:** We're already refactoring the entire content handling. The key name `'text'` is confusing (is it the Yjs type? the content type? the file content?). `'content'` is unambiguous.

**Migration:** There is no data to migrate. The filesystem is in development. No production Y.Docs exist with the old key names. If there were, the migration would be:

```typescript
// One-time migration (not needed now, included for future reference)
const oldText = ydoc.getText('text');
const newText = ydoc.getText('content');
if (oldText.length > 0 && newText.length === 0) {
  ydoc.transact(() => {
    newText.insert(0, oldText.toString());
    oldText.delete(0, oldText.length);
  });
}
```

---

## Future Evolution

This spec is designed to be extended, not replaced. Here's how future features build on it:

### WYSIWYG editing (future)

The Y.Text stores markdown. A WYSIWYG editor reads it, parses to ProseMirror, renders, and writes diffs back. The Milkdown POC proves this pattern. No filesystem changes needed.

### Diff-based writes (future)

Replace `delete(0, length) + insert(0, content)` with character-level diff. This preserves concurrent edits. The filesystem API doesn't change: `writeFile` still accepts a string. The internal implementation changes.

### Content metadata (future)

If we need per-file metadata in the content doc (format, schema version, etc.), add `Y.Map('meta')`:

```
Y.Doc
├── Y.Text('content')    → file content (unchanged)
└── Y.Map('meta')        → { format: 'markdown', version: 1 }  (new)
```

The `'content'` key is stable. New keys are additive.

### Persistent binary file support (future)

The ephemeral `Map<FileId, Uint8Array>` works for session artifacts. If we need binary files to survive app restarts or sync across peers, add a persistence layer (IndexedDB, blob storage, or Y.Doc binary encoding for transport) behind the Map. The IFileSystem interface doesn't change.

### v14 migration (future)

When Yjs v14 is stable, migrate `Y.Text('content')` to `Y.Type('content')`. The key name stays the same. The content stays the same. The internal Yjs representation changes.

### Lens architecture (future)

If we need multiple content formats (text, markdown, csv, json) with different CRDT structures, reintroduce a simplified lens/handler abstraction. The current spec's `'content'` key becomes the default text lens. Other formats get additional keys.

The point: **all of these build on `Y.Text('content')` without replacing it.**

---

## Verification

```bash
bun test packages/epicenter/src/filesystem/
```

Checklist:
- [x] Y.Doc has single `Y.Text('content')`: no other shared types
- [x] `readFile()` returns `ydoc.getText('content').toString()` for all text files
- [x] `writeFile()` writes to `ydoc.getText('content')` for string data
- [x] `writeFile()` with `Uint8Array` stores in `binaryStore` (not Y.Text)
- [x] `readFileBuffer()` checks `binaryStore` first, falls back to Y.Text encode
- [x] `readFile()` checks `binaryStore` first, falls back to Y.Text toString
- [x] `rm()` cleans up `binaryStore` entry for the deleted file (including recursive via `softDeleteDescendants`)
- [x] `cp()` copies binary data if source file has `binaryStore` entry
- [x] `mv()` never touches content doc or binary store: pure metadata update
- [x] `mv('/notes.md', '/notes.txt')` preserves content exactly (tested)
- [x] `convert-on-switch.ts` is deleted
- [x] No references to `healContentType`, `getExtensionCategory`, `openDocument`, `documentHandleToString`
- [x] `DocumentHandle`, `TextDocumentHandle`, `RichTextDocumentHandle` types are removed
- [x] `index.ts` exports are updated
- [x] just-bash integration tests pass (echo, cat, mkdir, ls, find, grep, rm, mv, cp, wc)
- [x] Files table schema is unchanged
- [x] `ContentDocStore` interface is unchanged

---

## Spec Status of Prior Specs

| Spec | New Status |
|------|-----------|
| `20260210T120000-content-format-spec.md` | **Superseded** by this spec. Lens architecture deferred to future. |
| `20260210T150000-content-storage-format-debate.md` | **Acknowledged**: this spec implements its recommendation (markdown-as-text), but with v13 Yjs, not v14. |
| `20260210T220000-v14-content-storage-spec.md` | **Deferred**: v14 migration is a separate project. This spec implements the v13 equivalent of its core idea. |
| `20260209T000000-simplify-content-doc-lifecycle.md` | **Still valid**: ContentDocStore is unchanged. |
| `20260209T120000-branded-file-ids.md` | **Still valid**: FileId branding unchanged. |
