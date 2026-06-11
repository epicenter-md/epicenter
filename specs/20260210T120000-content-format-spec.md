# Content Format Specification

**Date**: 2026-02-10
**Status**: Superseded
**Superseded by**: `specs/20260211T100000-simplified-ytext-content-store.md` (further superseded by `specs/20260211T230000-timeline-content-storage-implementation.md`): Y.Text('content') per document, lens architecture deferred to future.
**See also**: `specs/20260211T220000-yjs-content-doc-multi-mode-research.md`: Option F achieves this spec's format-as-metadata colocation goal differently: the `type` field in each timeline entry IS the format, embedded inside the content Y.Doc. No `FormatRegistry` needed.
---

## Problem

The content lens spec introduced an extensible lens pattern for file content types: good. But it inherited a flawed assumption from the original filesystem spec: **the file extension determines the active content type, and renaming triggers automatic content migration.**

This assumption creates cascading complexity:

1. **Healing**: When two peers are connected, a rename's metadata can sync before the content migration. The receiving peer sees a `.md` file but only `text:content` is populated. A healing system must detect this, probe all lenses for content, and migrate.

2. **Stale key probing**: Healing must call `ydoc.share.has()` before accessing keys to avoid permanently locking Yjs shared types to the wrong type. Every lens needs a `hasContent()` method solely for this probe.

3. **Conversion pipeline**: Every `mv` that changes extension category must serialize from the old lens and deserialize into the new lens. Error handling for parse failures. The `.txt` escape hatch for unrecoverable formats.

4. **Race conditions**: Content migration and metadata update are on different Y.Docs and can't share a Yjs transaction. The ordering matters. Edge cases with concurrent renames.

**None of this complexity exists in any real filesystem.** In POSIX, `mv notes.txt notes.md` changes the filename. The bytes are unchanged. The application interprets the extension. The filesystem is content-agnostic.

---

## Core Insight: Format Is Colocated With Content

A file's content format: how its CRDT structure serializes to a string and deserializes from a string: is an intrinsic property of the content itself. It belongs **inside the content Y.Doc**, not in the files table and not derived from the extension.

This is the Google Drive model: a Google Doc is always a Doc. A Google Sheet is always a Sheet. You can rename a Doc from "Budget" to "Budget.csv". It's still a Doc. The name is cosmetic. The document type is structural.

**Why colocation specifically?** The content Y.Doc already stores the CRDT data (Y.Text, Y.XmlFragment, etc.). Storing the format alongside that data means format changes and content changes happen in the **same Y.Doc transaction**: no cross-doc timing issues, no healing, no race conditions.

```
writeFile('/notes.md', '# Hello')
  → Extension .md at creation → format: 'markdown'
  → Stored in content Y.Doc: meta.format = 'markdown'
  → Lens: markdownLens → writes to Y.XmlFragment('md:content') + Y.Map('md:frontmatter')

mv('/notes.md', '/notes.txt')
  → Changes name only (files table). Content Y.Doc untouched.
  → Format stays 'markdown'. No conversion. No healing.

readFile('/notes.txt')
  → Load content Y.Doc → read meta.format → 'markdown'
  → Lens: markdownLens → serializes from Y.XmlFragment → returns markdown string
  → Same bytes as before the rename. Just like POSIX.
```

---

## Files Table: Unchanged

The files table keeps its existing schema. No new fields, no migration:

```typescript
const filesTable = defineTable(
  type({
    id: 'string',
    name: 'string',
    parentId: 'string | null',
    type: "'file' | 'folder'",   // unchanged: just file vs folder
    size: 'number',
    createdAt: 'number',
    updatedAt: 'number',
    trashedAt: 'number | null',
  }),
);
```

The files table answers "is this a file or a folder?" The content Y.Doc answers "how is this file's content structured?"

---

## Content Doc Structure

Each file's content Y.Doc is self-describing. It carries its own format metadata alongside the CRDT content:

```
Y.Doc (one per file, guid = fileId, gc: false)
├── Y.Map('meta')           → { format: 'text' | 'markdown' }
├── 'text:content'          → Y.Text           (active when format='text')
├── 'md:content'            → Y.XmlFragment    (active when format='markdown')
└── 'md:frontmatter'        → Y.Map            (active when format='markdown')
```

The `meta` map stores the `format` field. This tells the filesystem which lens to use for serialization. The format is set once at file creation and only changes via explicit `convertType()`.

### Why `format` (not `type`)

The files table already uses `type` for `'file' | 'folder'`. Using `format` in the content doc avoids confusion:

- `type` = "is this a file or a folder?" (files table)
- `format` = "how is this content structured?" (content Y.Doc)

### Why colocation is better than files table storage

| Concern | Format in files table | Format in content Y.Doc |
|---------|----------------------|------------------------|
| `convertType` atomicity | Two Y.Docs, two transactions, timing window | **One Y.Doc, one transaction, atomic** |
| Files table migration | Need new schema version + migrate function | **No change** |
| Self-describing documents | No: need files table to interpret content | **Yes**: doc carries its own metadata |
| Must load content doc to know format | No: read from always-loaded main doc | Yes, but you're loading it anyway for any content operation |

The tradeoff: you must load the content Y.Doc to know the format. But every operation that needs the format (`readFile`, `writeFile`, `convertType`) also needs the content. So the doc is loaded regardless.

Operations that don't need format (`stat`, `readdir`, `mkdir`, `mv`) never touch the content doc.

---

## Naming Conventions

### Terms

| Term | Where | Values | Purpose |
|------|-------|--------|---------|
| `type` | Files table `row.type` | `'file' \| 'folder'` | Is this a file or folder? |
| `format` | Content Y.Doc `meta.format` | `'text' \| 'markdown'` | How is the content structured? |
| Lens id | `ContentLens.id` | `'text'`, `'md'` | Y.Doc key namespace prefix (short) |
| Format value | `meta.format` | `'text'`, `'markdown'` | Human-readable format name |

### Lens id vs format value

The markdown lens has id `'md'` (used for Y.Doc key namespacing: `'md:content'`) but the format value is `'markdown'` (human-readable in metadata). The registry maps `'markdown'` → `markdownLens`. This keeps key names short while format values readable.

The text lens is the exception: id `'text'` and format value `'text'` are the same.

**Rule:** Lens id = Y.Doc key prefix. Format value = metadata value. They may differ.

---

## The ContentLens Interface

```typescript
interface ContentLens<THandle = unknown> {
    /** Lens identifier. Used as namespace prefix for Y.Doc keys. */
    readonly id: string;

    /** The format value this lens handles (stored in meta.format). */
    readonly format: string;

    /** Serialize this lens's Yjs types to a plain string */
    toString(ydoc: Y.Doc): string;

    /**
     * Parse a plain string and write to this lens's Yjs types.
     * @throws {Error} if content cannot be parsed. Y.Doc is left unchanged on failure.
     */
    fromString(ydoc: Y.Doc, content: string): void;

    /** Get typed references to Yjs shared types (for editor binding) */
    open(fileId: FileId, ydoc: Y.Doc): THandle;
}
```

**What changed from the content lens spec:**

- **`hasContent()` is removed.** It only existed for healing: probing whether a lens had content in its keys so the healing system could find content in the "wrong" lens. With format as authoritative metadata, there's no wrong lens. You always know which lens to use.
- **`format` property added.** Maps lens to its format value (e.g., `'md'` lens handles `'markdown'` format).

Two consumers:
- **Filesystem** calls `toString` and `fromString`. Never touches handles.
- **Editors** call `open()` to get typed handles for real-time collaborative binding (ProseMirror, CodeMirror, table editor, etc.)

---

## The FormatRegistry

```typescript
type FormatRegistry = {
    /** Get the lens for a format string. Throws if unknown. */
    lensFor(format: string): ContentLens;

    /** Infer the format for a new file based on its name/extension. */
    inferFormat(fileName: string): string;
};
```

Factory:

```typescript
const registry = createFormatRegistry({
    lenses: [textLens, markdownLens],
    extensionMap: { '.md': 'markdown' },
    fallback: 'text',
});
```

**What changed from the content lens spec:**

- **`lensForFile(fileName)` → `lensFor(format)`**: Direct map lookup by format string, not extension parsing. The filesystem reads the format from the content doc's metadata.
- **`heal()` is removed entirely.** No healing. Format metadata is authoritative.
- **`inferFormat(fileName)` added**: Used only at file creation time to determine the initial format from the extension. After creation, the format is read from the content doc.

Extension matching in `inferFormat` uses the last dot segment: `'notes.md'` → `'.md'` → `'markdown'`. Files without extensions (`.gitignore`, `Makefile`) fall back to `'text'`.

---

## Y.Doc Key Naming Convention

All content keys use a consistent `{lensId}:{keyName}` namespace. The `meta` map is the only non-namespaced key:

```
Y.Doc (one per file, guid = fileId)
├── Y.Map('meta')          → { format: 'text' | 'markdown' }   ← format metadata
├── 'text:content'         → Y.Text              ← text lens
├── 'md:content'           → Y.XmlFragment       ← markdown lens (body)
├── 'md:frontmatter'       → Y.Map               ← markdown lens (YAML metadata)
├── 'csv:headers'          → Y.Array<string>         ← csv lens (future)
├── 'csv:data'             → Y.Array<Y.Map<string>>  ← csv lens (future)
└── 'json:data'            → Y.Map                   ← json lens (future)
```

**Rules:**
- Every content key is prefixed with its lens ID
- Keys are created lazily (only when a lens accesses them)
- A `.ts` file that was never converted only has `meta` + `'text:content'`: no other keys exist
- Stale keys from previous explicit conversions are never read (format metadata determines active lens)

**Why `text:content` and not just `text`?** Consistency. Every lens follows the same `{lensId}:{keyName}` pattern. No special cases.

**Why `text` and not `plain` or `default`?** The `text` prefix refers to the Yjs shared type (Y.Text), not the file extension. A `.ts`, `.json`, or `.csv` file all use the text lens because they're all stored as plain text via Y.Text. The `md` lens is the exception: it uses Y.XmlFragment for collaborative WYSIWYG.

---

## Built-in Lenses

### Text Lens (id: `'text'`, format: `'text'`)

The universal fallback. Every file type can be edited as raw text.

| Key | Yjs Type | Purpose |
|-----|----------|---------|
| `text:content` | `Y.Text` | Raw text content |

```typescript
const textLens: ContentLens<TextDocumentHandle> = {
    id: 'text',
    format: 'text',
    toString(ydoc)           { return ydoc.getText('text:content').toString() },
    fromString(ydoc, content) {
        const ytext = ydoc.getText('text:content');
        ydoc.transact(() => {
            ytext.delete(0, ytext.length);
            ytext.insert(0, content);
        });
    },
    open(fileId, ydoc) { return { type: 'text', fileId, ydoc, content: ydoc.getText('text:content') } },
};
```

Editor binding: CodeMirror / Monaco via y-codemirror.

### Markdown Lens (id: `'md'`, format: `'markdown'`)

For WYSIWYG editing with ProseMirror/TipTap.

| Key | Yjs Type | Purpose |
|-----|----------|---------|
| `md:content` | `Y.XmlFragment` | Document body (ProseMirror tree) |
| `md:frontmatter` | `Y.Map<unknown>` | YAML front matter (per-key LWW) |

```typescript
const markdownLens: ContentLens<MarkdownDocumentHandle> = {
    id: 'md',
    format: 'markdown',
    toString(ydoc) {
        const frontmatter = yMapToRecord(ydoc.getMap('md:frontmatter'));
        const body = serializeXmlFragmentToMarkdown(ydoc.getXmlFragment('md:content'));
        return serializeMarkdownWithFrontmatter(frontmatter, body);
    },
    fromString(ydoc, content) {
        const { frontmatter, body } = parseFrontmatter(content);
        updateYMapFromRecord(ydoc.getMap('md:frontmatter'), frontmatter);
        updateYXmlFragmentFromString(ydoc.getXmlFragment('md:content'), body);
    },
    open(fileId, ydoc) {
        return {
            type: 'md',
            fileId, ydoc,
            content: ydoc.getXmlFragment('md:content'),
            frontmatter: ydoc.getMap('md:frontmatter'),
        };
    },
};
```

Editor binding: ProseMirror via y-prosemirror. Front matter rendered as form fields bound to Y.Map.

### Future Lenses

See content lens spec for CSV and JSON lens designs. These extend naturally: add a new lens, add a new format value, register in the extension map for `inferFormat`.

---

## How the Filesystem Uses Lenses

### readFile(path)

```
readFile('/notes.txt')
 1. Resolve path → FileId → get row from files table
 2. if (row.type === 'folder') throw EISDIR
 3. ydoc = store.ensure(fileId)
 4. format = ydoc.getMap('meta').get('format')    ← read from content doc
 5. lens = registry.lensFor(format)
 6. return lens.toString(ydoc)
```

**What's gone:** No `heal()` call. No `healContentType()`. The format is authoritative. If the format says 'markdown', we read from markdown keys. Period.

### writeFile(path, content): existing file

```
writeFile('/notes.txt', 'new content')
 1. Resolve path → FileId → get row from files table
 2. ydoc = store.ensure(fileId)
 3. format = ydoc.getMap('meta').get('format')
 4. lens = registry.lensFor(format)
 5. lens.fromString(ydoc, content)
 6. Update file size + mtime in files table
```

### writeFile(path, content): new file

```
writeFile('/notes.md', '# Hello')
 1. Path doesn't exist → create file
 2. format = registry.inferFormat('notes.md')    ← 'markdown' (from extension, ONLY at creation)
 3. Generate FileId
 4. filesTable.set({ id, name: 'notes.md', type: 'file', ... })
 5. ydoc = store.ensure(fileId)
 6. lens = registry.lensFor(format)
 7. ydoc.transact(() => {
      ydoc.getMap('meta').set('format', format)
      lens.fromString(ydoc, content)
    })
```

**Key point:** `inferFormat` is called exactly once: at file creation. After that, the format is read from the content doc's metadata. The extension is never consulted again.

### mkdir(path): folder creation

```
mkdir('/docs')
 1. filesTable.set({ id, name: 'docs', type: 'folder', ... })
```

No lens, no content doc. Unchanged from current implementation.

### mv(src, dest): Always Metadata-Only

```
mv('/notes.md', '/notes.txt')
 1. Resolve source path → FileId → get row
 2. Parse destination → newParentId + newName
 3. validateName(newName)
 4. assertUniqueName(...)
 5. filesTable.update(id, { name: newName, parentId: newParentId, updatedAt: Date.now() })
```

**That's it.** No extension category check. No content migration. No `store.destroy()`. No healing. No content doc access at all. Just a metadata update. Always O(1). Always safe.

The `mv` implementation is identical for files and folders, no branching on content format.

### convertFormat(path, targetFormat): Explicit Conversion

A new public method for when the user deliberately wants to change a file's content format:

```
convertFormat('/notes.txt', 'markdown')
 1. Resolve path → FileId → get row
 2. if (row.type === 'folder') throw EISDIR
 3. ydoc = store.ensure(fileId)
 4. currentFormat = ydoc.getMap('meta').get('format')
 5. if (currentFormat === targetFormat) return  ← no-op
 6. fromLens = registry.lensFor(currentFormat)
 7. toLens = registry.lensFor(targetFormat)
 8. ydoc.transact(() => {
      text = fromLens.toString(ydoc)           ← serialize from current format
      toLens.fromString(ydoc, text)            ← write to new format's keys
      ydoc.getMap('meta').set('format', targetFormat)
    })
```

**Properties:**
- **Single Y.Doc transaction**: format change and content migration are atomic. All peers see both changes together. No timing window.
- Uses the same `toString → fromString` pipeline as the old rename conversion
- In-place on the same Y.Doc: no destroy/recreate
- Old lens's keys become stale (harmless, never read)
- If `fromString` throws (content can't be parsed as target format), the entire transaction is rolled back. Format stays unchanged. Y.Doc is not modified on failure.
- Not exposed via IFileSystem (no POSIX equivalent). This is a workspace-level operation, exposed through the UI or a dedicated API.
- Cannot convert folders: guard with EISDIR check.

---

## Stale Keys After Explicit Conversion

After `convertFormat(path, 'markdown')`:

```
Y.Doc (meta.format: 'markdown')
├── Y.Map('meta')          → { format: 'markdown' }
├── 'text:content'         → Y.Text         ← STALE (never read while format='markdown')
├── 'md:content'           → Y.XmlFragment  ← ACTIVE
└── 'md:frontmatter'       → Y.Map          ← ACTIVE
```

After converting back `convertFormat(path, 'text')`:

```
Y.Doc (meta.format: 'text')
├── Y.Map('meta')          → { format: 'text' }
├── 'text:content'         → Y.Text         ← ACTIVE (overwritten with fresh content)
├── 'md:content'           → Y.XmlFragment  ← STALE
└── 'md:frontmatter'       → Y.Map          ← STALE
```

**Why stale keys are harmless:**
1. They're never read: format metadata is authoritative
2. No probing: we don't need `ydoc.share.has()` checks or `hasContent()`
3. They get overwritten on the next conversion to that format
4. Storage cost is minimal: a few KB of orphaned CRDT data per conversion

**Why not clear stale keys:**
- Clearing means writing deletion tombstones into the CRDT (more storage, not less)
- Adds code for zero functional benefit
- The keys may contain content a user wants to recover (undo the conversion)

---

## Why NOT Derive Format From Extension

This section explains the decision for future readers who might ask "why not just use the extension?"

### Real filesystems don't do this

In ext4, APFS, NTFS: `mv report.txt report.md` changes the filename. Same bytes. Same inode. The filesystem is content-agnostic. Applications choose how to render based on extension. But the data is unchanged.

Our filesystem should behave the same way. `readFile` returns the same string before and after a rename. The serialization format is an intrinsic property of the content, not the name.

### Extension-derived format creates a category of problems that doesn't need to exist

| Problem | With extension-derived format | With format-as-metadata |
|---------|-------------------------------|------------------------|
| Cross-peer timing on rename | Metadata syncs before content migration → content in wrong keys → need healing | Metadata syncs → new name, same format → no migration, no healing |
| Concurrent rename conflicts | Two peers rename to different extensions → two migrations → conflicting content | Two peers rename → only name changes, format unchanged → normal LWW |
| Parse failure on rename | `.csv` → `.json`: CSV content isn't valid JSON → partial migration → degraded state | No conversion on rename → no parse failure possible |
| Stale key probing | Must check `ydoc.share.has()` before accessing keys to avoid type-locking | No probing: format metadata tells you exactly which keys to read |
| `mv` complexity | Conditional: same-category rename vs cross-category with full migration pipeline | Always a single metadata update |

### The only thing you lose is "rename to convert"

`mv notes.txt notes.md` no longer makes the file a rich text document. But:
- How often does a user actually do this? Almost never.
- It's surprising behavior: no other filesystem converts content on rename.
- Google Drive proves you can build a successful product without it.
- When you DO want to convert, `convertFormat()` is explicit and intentional.

---

## Why NOT Store Format in the Files Table

An alternative design stores the format in the files table as a unified `type` field (`'folder' | 'text' | 'markdown'`). This was considered and rejected in favor of colocation.

### The cross-doc timing problem

With format in the files table, `convertFormat` must update two Y.Docs:
1. Content Y.Doc: write new content through the target lens
2. Main Y.Doc (files table): update the format field

These are separate Y.Docs that can't share a Yjs transaction. If the main doc syncs before the content doc, Peer B sees the new format but the content hasn't arrived yet: resulting in an empty read.

With format in the content Y.Doc, `convertFormat` is a **single transaction**. Format change and content migration sync together atomically. No timing window. No empty reads.

### No schema migration needed

Storing format in the files table requires changing the `type` field from `'file' | 'folder'` to `'folder' | 'text' | 'markdown'`. This needs a schema version bump and migration function.

With format in the content Y.Doc, the files table is completely unchanged.

### No operation needs format without content

Every filesystem operation that needs to know the format also needs the content Y.Doc:
- `readFile` → needs content doc to read content
- `writeFile` → needs content doc to write content
- `convertFormat` → needs content doc to migrate content

Operations that don't need content (`stat`, `readdir`, `mv`, `mkdir`) also don't need format.

A UI file tree shows icons based on the **file extension** (cosmetic), not the internal format.

---

## Why NOT Keep Y.Text Always In Sync

The fundamental CRDT constraint still applies:

| Model | How it works | Problem |
|-------|-------------|---------|
| **Mutually exclusive** (chosen) | One active lens per file. Others go stale. | None: simple and correct |
| **Y.Text always updated** | Every lens writes to text:content on each edit | User A edits Y.Text, User B edits XmlFragment simultaneously → two CRDTs diverge, no reconciliation possible |
| **Y.Text is source of truth** | Structured lenses are ephemeral, serialize back to Y.Text | y-prosemirror binds to XmlFragment for real-time collab. Serializing back every keystroke while another peer edits Y.Text → two fighting CRDTs |

Two Yjs shared types cannot be bidirectionally synced without a single-writer coordination layer. The mutually exclusive model avoids this entirely. The active lens is determined by the `format` field in the content doc (not the extension). Editing a markdown file as raw text requires an explicit `convertFormat()` call.

---

## Graceful Degradation

### convertFormat() parse failure

If `toLens.fromString()` throws during `convertFormat()`:

1. The entire Yjs transaction is rolled back: no partial writes
2. The format field is NOT updated (it's in the same transaction)
3. The file continues to work as before
4. The caller receives the error: UI can display "Cannot convert: invalid content for target format"

### The text escape hatch

`textLens.fromString()` never throws. It accepts any string. Converting any file to `'text'` format always succeeds. This is the universal fallback for recovery.

### writeFile() format mismatch

If an agent calls `writeFile('/notes.txt', '# markdown content')` and the file's format is `'text'`, the content is stored as plain text in Y.Text. The `#` is just characters. No markdown parsing. If the user later converts via `convertFormat()`, the `#` becomes a heading. This is correct. The file was text, now it's markdown.

---

## Multi-Peer Sync (No Healing Needed)

### Rename scenario

```
Peer A (renamer)                    Peer B (observer)
────────────────                    ─────────────────
mv('/notes.md', '/notes.txt')
  → filesTable.update(name: 'notes.txt')
  → Content Y.Doc untouched
  → Format stays 'markdown'

  main doc syncs ───────────────►   files.observe() fires
                                    name changed: 'notes.md' → 'notes.txt'

                                    readFile('/notes.txt')
                                      → load content doc
                                      → meta.format: 'markdown'
                                      → markdownLens.toString(ydoc) ✓
```

No timing issue. No healing. The format didn't change, so the content is still valid.

### Explicit conversion scenario

```
Peer A (converter)                  Peer B (observer)
──────────────────                  ─────────────────
convertFormat('/notes.txt', 'text')
  ydoc.transact(() => {
    markdownLens.toString(ydoc)     → serialize
    textLens.fromString(ydoc, s)    → write to text:content
    meta.set('format', 'text')      → update format
  })
  ↑ ALL IN ONE TRANSACTION

  content doc syncs ────────────►   Peer B receives ALL changes atomically:
                                    - text:content populated
                                    - meta.format = 'text'

                                    readFile('/notes.txt')
                                      → meta.format: 'text'
                                      → textLens.toString(ydoc) ✓
```

**No timing window.** Because the format change and content migration are in the same Y.Doc transaction, they sync together. Peer B never sees one without the other.

Compare with the alternative (format in files table):
- Format update and content update are on different Y.Docs
- They sync independently
- Peer B can see new format before new content → empty read
- That design requires either healing or accepting a "brief flash of empty content"

Colocation eliminates this entire class of problem.

---

## What This Spec Removes

| Concept | Where it lived | Why it's gone |
|---------|---------------|---------------|
| `healContentType()` | `convert-on-switch.ts` | No wrong-key scenario: format metadata is authoritative |
| `hasContent()` on lenses | Content lens interface | Only existed for healing probes |
| `heal()` on LensRegistry | Registry interface | No healing needed |
| `getExtensionCategory()` | `convert-on-switch.ts` | Extension no longer determines active format |
| Extension-conditional `mv` | `yjs-file-system.ts:297-314` | `mv` is always metadata-only |
| `store.destroy()` in `mv` | `yjs-file-system.ts:304` | Y.Doc is never destroyed on rename |
| `ydoc.share.has()` safety checks | Healing code | No probing for content in wrong keys |

## What This Spec Keeps

| Concept | Where it lives | Why it stays |
|---------|---------------|-------------|
| ContentLens interface | `content-lens.ts` | Still the right abstraction for serialization |
| `{lensId}:{keyName}` naming | Y.Doc keys | Clean namespacing, lazy creation |
| Stale keys model | Y.Doc after conversion | Harmless orphaned data, overwritten on next conversion |
| `toString → fromString` pipeline | `convertFormat()` | Still the right way to convert: 2N functions for N types |
| Mutually exclusive active lens | Architecture | CRDTs can't be bidirectionally synced |
| `ContentDocStore` | `content-doc-store.ts` | Still manages Y.Doc lifecycle |
| `FormatRegistry` | `content-lens.ts` | Still routes format → lens, just without healing |
| Files table schema | `file-table.ts` | `type: 'file' \| 'folder'`: completely unchanged |

---

## Implementation Guide

This section has everything an implementing agent needs: concrete code changes, file-by-file instructions, before/after comparisons.

### Files to modify

| File | Action | What to do |
|------|--------|------------|
| `packages/epicenter/src/filesystem/file-table.ts` | **No change** | Files table stays `type: 'file' \| 'folder'`. No format field. |
| `packages/epicenter/src/filesystem/content-lens.ts` | Create | `ContentLens<THandle>` interface, `FormatRegistry` type, `createFormatRegistry()`, `textLens`, `markdownLens`, handle types, `defaultFormatRegistry` |
| `packages/epicenter/src/filesystem/yjs-file-system.ts` | Modify | Add `registry: FormatRegistry` param. Read format from `ydoc.getMap('meta').get('format')`. Simplify `mv()`. Add `convertFormat()`. Remove all healing/extension-category code. |
| `packages/epicenter/src/filesystem/content-doc-store.ts` | Modify | Remove `openDocument()` and `documentHandleToString()`. Keep `createContentDocStore()` unchanged. |
| `packages/epicenter/src/filesystem/convert-on-switch.ts` | Delete | Entire file. All functionality replaced by lenses + format metadata. |
| `packages/epicenter/src/filesystem/types.ts` | Modify | Remove `DocumentHandle`, `TextDocumentHandle`, `RichTextDocumentHandle`, `ExtensionCategory`. Re-export lens types from `content-lens.ts`. `FileRow` type unchanged. |
| `packages/epicenter/src/filesystem/index.ts` | Modify | Update exports. |
| `packages/epicenter/src/filesystem/convert-on-switch.test.ts` | Rewrite → `content-lens.test.ts` | Test lens toString/fromString/open directly. |
| `packages/epicenter/src/filesystem/yjs-file-system.test.ts` | Modify | Update rename tests (no conversion). Add `convertFormat()` tests. Remove healing tests. |

### Key code changes

#### How `readFile` changes

Before:
```typescript
const ydoc = this.store.ensure(id);
healContentType(ydoc, row.name);
const handle = openDocument(id, row.name, ydoc);
return documentHandleToString(handle);
```

After:
```typescript
const ydoc = this.store.ensure(id);
const format = ydoc.getMap('meta').get('format') as string;
const lens = this.registry.lensFor(format);
return lens.toString(ydoc);
```

#### How `writeFile` changes (new file creation)

Before:
```typescript
this.filesTable.set({
    id, name, parentId, type: 'file',
    size: ..., createdAt: Date.now(), updatedAt: Date.now(), trashedAt: null,
});
// ... then openDocument based on extension
```

After:
```typescript
const format = this.registry.inferFormat(name);
this.filesTable.set({
    id, name, parentId, type: 'file',
    size: ..., createdAt: Date.now(), updatedAt: Date.now(), trashedAt: null,
});
const ydoc = this.store.ensure(id);
const lens = this.registry.lensFor(format);
ydoc.transact(() => {
    ydoc.getMap('meta').set('format', format);
    lens.fromString(ydoc, content);
});
```

#### How `writeFile` changes (existing file)

Before:
```typescript
const ydoc = this.store.ensure(id);
healContentType(ydoc, row.name);
const handle = openDocument(id, row.name, ydoc);
if (handle.type === 'text') {
    handle.ydoc.transact(() => {
        handle.content.delete(0, handle.content.length);
        handle.content.insert(0, content);
    });
} else {
    const { frontmatter, body } = parseFrontmatter(content);
    updateYMapFromRecord(handle.frontmatter, frontmatter);
    updateYXmlFragmentFromString(handle.content, body);
}
```

After:
```typescript
const ydoc = this.store.ensure(id);
const format = ydoc.getMap('meta').get('format') as string;
const lens = this.registry.lensFor(format);
lens.fromString(ydoc, content);
```

The format-specific write logic moves into each lens's `fromString()`.

#### How `mv` changes

Before (~25 lines with extension checking):
```typescript
if (row.type === 'file') {
    const fromCategory = getExtensionCategory(row.name);
    const toCategory = getExtensionCategory(newName);
    if (fromCategory !== toCategory) {
        const content = await this.readFile(resolvedSrc);
        this.store.destroy(id);
        this.filesTable.update(id, {
            name: newName, parentId: newParentId, updatedAt: Date.now(),
        });
        await this.writeFile(resolvedDest, content);
        return;
    }
}
this.filesTable.update(id, {
    name: newName, parentId: newParentId, updatedAt: Date.now(),
});
```

After (always the same):
```typescript
this.filesTable.update(id, {
    name: newName, parentId: newParentId, updatedAt: Date.now(),
});
```

#### How `stat` stays the same

```typescript
return {
    isFile: row.type === 'file',
    isDirectory: row.type === 'folder',
    isSymbolicLink: false,
    size: row.size,
    mtime: new Date(row.updatedAt),
    mode: row.type === 'folder' ? 0o755 : 0o644,
};
```

No change needed: `type` is still `'file' | 'folder'`.

#### How `mkdir` stays the same

```typescript
this.filesTable.set({
    id, name, parentId, type: 'folder',
    size: 0, createdAt: Date.now(), updatedAt: Date.now(), trashedAt: null,
});
```

No change needed.

#### How `convertFormat` is added

```typescript
convertFormat(path: string, targetFormat: string): void {
    const resolved = posixResolve(this.cwd, path);
    const id = this.resolveId(resolved);
    const row = this.getRow(id);
    if (row.type === 'folder') throw fsError('EISDIR', resolved);

    const ydoc = this.store.ensure(id);
    const currentFormat = ydoc.getMap('meta').get('format') as string;
    if (currentFormat === targetFormat) return;

    const fromLens = this.registry.lensFor(currentFormat);
    const toLens = this.registry.lensFor(targetFormat);

    ydoc.transact(() => {
        const text = fromLens.toString(ydoc);
        toLens.fromString(ydoc, text);
        ydoc.getMap('meta').set('format', targetFormat);
    });

    this.filesTable.update(id, { updatedAt: Date.now() });
}
```

#### Y.Doc key name changes

Old keys: `'text'`, `'richtext'`, `'frontmatter'`
New keys: `'text:content'`, `'md:content'`, `'md:frontmatter'`
New metadata key: `Y.Map('meta')` with `format` field

Pattern: `{lensId}:{keyName}` for content, `Y.Map('meta')` for metadata.

### Important constraints

- **Use bun**, not npm/node: `bun test`, `bun run`, etc.
- **Y.Doc keys are permanently type-locked**: Once you call `ydoc.getText('foo')`, that key is forever Y.Text. This is why we use separate namespaced keys per lens.
- **Lenses must be DOM-free**: `serializeXmlFragmentToMarkdown` uses `prosemirror-markdown` (headless). No jsdom.
- **markdown-helpers.ts stays unchanged**: `parseFrontmatter`, `serializeMarkdownWithFrontmatter`, `updateYMapFromRecord`, `yMapToRecord`, `serializeXmlFragmentToMarkdown`, `updateYXmlFragmentFromString` are all still needed: they're used by the markdown lens.

### Verification

```bash
bun test packages/epicenter/src/filesystem/
```

Checklist:
- [ ] `bun test` passes
- [ ] Files table schema is unchanged (`type: 'file' | 'folder'`)
- [ ] Content Y.Doc has `Y.Map('meta')` with `format` field
- [ ] `mv` never touches content doc or format: pure name/parentId update
- [ ] New file creation infers format from extension via `inferFormat`, stores in content doc
- [ ] `readFile` reads format from content doc, not file extension
- [ ] `convertFormat` works for text ↔ markdown in a single transaction
- [ ] `convertFormat` is a no-op when target matches current
- [ ] `convertFormat` with invalid content throws and leaves format unchanged
- [ ] `convertFormat` rejects folders (EISDIR)
- [ ] `convert-on-switch.ts` is deleted
- [ ] No references to `healContentType`, `getExtensionCategory`, or `openDocument` remain
- [ ] Y.Doc content key names use `{lensId}:{keyName}` pattern
- [ ] `stat()` returns correct `isFile`/`isDirectory` (unchanged)

---

## Related Specs

- `specs/20260208T000000-yjs-filesystem-spec.md`: Original filesystem spec. The two-layer architecture, files table, runtime indexes, IFileSystem implementation, and design decisions sections are still valid. The triple-key and convert-on-switch sections (lines 766-862) are superseded by this spec.
- `specs/20260210T000000-content-lens-spec.md`: Superseded entirely by this spec. The lens interface and key naming survive in simplified form. The healing, extension-based lookup, and rename conversion sections are eliminated.
- `specs/20260210T000000-mv-in-place-migration.md`: Superseded. The in-place migration insight is preserved in `convertFormat()`, but rename no longer triggers migration.
- `specs/20260209T000000-simplify-content-doc-lifecycle.md`: Still valid. ContentDocStore design unchanged.
- `specs/20260209T120000-branded-file-ids.md`: Still valid. FileId branding unchanged.
