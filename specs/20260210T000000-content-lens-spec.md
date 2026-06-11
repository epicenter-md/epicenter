# Content Lens Specification

**Date**: 2026-02-10
**Status**: Superseded
**Superseded by**: `specs/20260211T100000-simplified-ytext-content-store.md` (further superseded by `specs/20260211T230000-timeline-content-storage-implementation.md`): lens architecture deferred. Single `Y.Text('content')` replaced all format-specific CRDT structures; timeline approach now uses `Y.Array('timeline')` with nested shared types.
**Supersedes**: Triple-key architecture in `specs/20260208T000000-yjs-filesystem-spec.md` (lines 31-36, 766-862), `convert-on-switch.ts`
**See also**: `specs/20260211T220000-yjs-content-doc-multi-mode-research.md`: Option F (Y.Array timeline with nested shared types) eliminates the need for lenses entirely. Each timeline entry is self-contained with its own typed content: no registry, no healing, no stale keys.

---

## Problem

The filesystem hardcodes two content categories (`'text' | 'richtext'`). Every new structured file type (CSV table editor, JSON tree editor) would require modifying the core filesystem code. We need an extensible pattern.

## Core Concept: Content Lenses

A **content lens** is a bidirectional converter between structured Yjs types and a plain text string.

```
               toString()
  Y.Doc keys  ──────────►  plain string    (for readFile, disk, grep)
  (structured)  ◄──────────
               fromString()                 (for writeFile, imports)
```

Every file type has exactly one active lens, determined by file extension. The lens decides which Y.Doc keys to use and how to serialize/deserialize.

The **filesystem never knows about specific lenses**. It asks the registry "which lens for this filename?" and calls `toString` / `fromString`. Adding a new file type means writing a new lens + registering it. Zero changes to core filesystem code.

---

## Y.Doc Key Naming Convention

All keys use a consistent `{lensId}:{keyName}` namespace:

```
Y.Doc (one per file, guid = fileId)
├── 'text:content'     → Y.Text              ← text lens
├── 'md:content'       → Y.XmlFragment       ← markdown lens (body)
├── 'md:frontmatter'   → Y.Map               ← markdown lens (YAML metadata)
├── 'csv:headers'      → Y.Array<string>         ← csv lens (column names, future)
├── 'csv:data'         → Y.Array<Y.Map<string>>  ← csv lens (rows of cells, future)
└── 'json:data'        → Y.Map                   ← json lens (future)
```

**Rules**:
- Every key is prefixed with its lens ID
- Keys are created lazily (only when a lens accesses them)
- A `.ts` file that was never renamed only has `'text:content'`: no other keys exist
- Stale keys from previous conversions are never read (extension determines active lens)

**Why `text:content` and not just `text`?** Consistency. Every lens follows the same `{lensId}:{keyName}` pattern. No special cases.

**Why `text` and not `plain` or `default`?** The `text` prefix refers to the Yjs shared type (Y.Text), not the file extension. A `.ts`, `.json`, or `.csv` file all use the text lens because they're all stored as plain text via Y.Text. The `md` lens is the exception: it uses Y.XmlFragment for collaborative WYSIWYG.

---

## The ContentLens Interface

```typescript
interface ContentLens<THandle = unknown> {
    /** Lens identifier. Also the namespace prefix for Y.Doc keys. */
    readonly id: string;

    /** Serialize this lens's Yjs types to a plain string */
    toString(ydoc: Y.Doc): string;

    /**
     * Parse a plain string and write to this lens's Yjs types.
     * @throws {Error} if content cannot be parsed. Y.Doc is left unchanged on failure.
     */
    fromString(ydoc: Y.Doc, content: string): void;

    /** Does this lens have content in its Y.Doc keys? */
    hasContent(ydoc: Y.Doc): boolean;

    /** Get typed references to Yjs shared types (for editor binding) */
    open(fileId: FileId, ydoc: Y.Doc): THandle;
}
```

Two consumers:
- **Filesystem** calls `toString`, `fromString`, `hasContent`. Never touches handles.
- **Editors** call `open()` to get typed handles for real-time collaborative binding (ProseMirror, CodeMirror, table editor, etc.)

---

## The LensRegistry

```typescript
type LensRegistry = {
    /** Get the lens for a filename (based on extension) */
    lensForFile(fileName: string): ContentLens;

    /** Self-healing: if content is in the wrong lens's keys, migrate */
    heal(ydoc: Y.Doc, fileName: string): void;
};
```

Factory:

```typescript
const registry = createLensRegistry({
    lenses: [textLens, markdownLens],
    extensionMap: { '.md': 'md' },
    // everything not in the map → textLens (fallback)
});
```

Extension matching uses the last dot segment: `'notes.md'` → `'.md'` → `'md'` lens. Files without extensions (`.gitignore`, `Makefile`) fall back to the text lens.

---

## Built-in Lenses

### Text Lens (id: `'text'`)

The universal fallback. Every file type can be edited as raw text.

| Key | Yjs Type | Purpose |
|-----|----------|---------|
| `text:content` | `Y.Text` | Raw text content |

```typescript
const textLens: ContentLens<TextDocumentHandle> = {
    id: 'text',
    toString(ydoc)           { return ydoc.getText('text:content').toString() },
    fromString(ydoc, content) {
        const ytext = ydoc.getText('text:content');
        ydoc.transact(() => {
            ytext.delete(0, ytext.length);
            ytext.insert(0, content);
        });
    },
    hasContent(ydoc)  { return ydoc.share.has('text:content') && ydoc.getText('text:content').length > 0 },
    open(fileId, ydoc) { return { type: 'text', fileId, ydoc, content: ydoc.getText('text:content') } },
};
```

Editor binding: CodeMirror / Monaco via y-codemirror.

### Markdown Lens (id: `'md'`)

For WYSIWYG editing with ProseMirror/TipTap.

| Key | Yjs Type | Purpose |
|-----|----------|---------|
| `md:content` | `Y.XmlFragment` | Document body (ProseMirror tree) |
| `md:frontmatter` | `Y.Map<unknown>` | YAML front matter (per-key LWW) |

```typescript
const markdownLens: ContentLens<MarkdownDocumentHandle> = {
    id: 'md',
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
    hasContent(ydoc) {
        return ydoc.share.has('md:content') && ydoc.getXmlFragment('md:content').length > 0;
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

### Future: CSV Lens (id: `'csv'`)

| Key | Yjs Type | Purpose |
|-----|----------|---------|
| `csv:headers` | `Y.Array<string>` | Column names, ordered |
| `csv:data` | `Y.Array<Y.Map<string>>` | Rows: each row maps column name → cell value |

**Why `Y.Map` per row, not `Y.Array` per row?** With `Y.Array<Y.Array<string>>`, cells are addressed by index. Yjs array insertions shift subsequent indices, so two users editing different cells in the same row could conflict. With `Y.Map` per row, each cell is an independent key: different cells merge cleanly, same cell gets LWW.

> **Note**: A collaborative CSV editor could also be built on Y.Text (the text lens) with a custom table UI that parses/serializes CSV. The structured lens is only needed if per-cell CRDT granularity becomes a real requirement. Start with Y.Text; add this lens if same-cell conflicts are a problem.

### Future: JSON Lens (id: `'json'`)

| Key | Yjs Type | Purpose |
|-----|----------|---------|
| `json:data` | `Y.Map` (nested Maps/Arrays) | Structured JSON |

Benefit: per-key conflict resolution. Two users editing different keys merge cleanly (each key is an independent Y.Map entry, LWW on same-key conflicts).

---

## How the Filesystem Uses Lenses

The filesystem (YjsFileSystem) accepts a `LensRegistry` in its constructor and delegates all content type logic to it.

### readFile(path)

```
readFile('/notes.md')
 1. Resolve path → FileId → get row from files table
 2. ydoc = store.ensure(fileId)
 3. registry.heal(ydoc, 'notes.md')           ← fix mismatched keys if needed
 4. lens = registry.lensForFile('notes.md')    ← markdownLens
 5. return lens.toString(ydoc)                 ← XmlFragment + Map → "---\ntitle:...\n---\n..."
```

### writeFile(path, content)

```
writeFile('/notes.md', '---\ntitle: Hi\n---\nHello\n')
 1. Resolve or create file metadata
 2. ydoc = store.ensure(fileId)
 3. registry.heal(ydoc, 'notes.md')
 4. lens = registry.lensForFile('notes.md')    ← markdownLens
 5. lens.fromString(ydoc, content)              ← parse → write to XmlFragment + Map
 6. Update file size + mtime in metadata
```

The filesystem never switches on handle type, never imports markdown helpers, never knows about XmlFragment or Y.Map. It just calls the lens.

---

## File Rename: Detailed Mechanics

Renames are the critical operation because they can change which lens is active.

### Case 1: Same lens (no conversion needed)

```
mv('/index.ts', '/index.js')
 1. fromLens = registry.lensForFile('index.ts')   → textLens
 2. toLens   = registry.lensForFile('index.js')    → textLens
 3. Same lens? YES → skip conversion
 4. Update metadata: name='index.js', parentId, updatedAt
```

Y.Doc is untouched. `text:content` stays as-is.

### Case 2: Text → Markdown

```
mv('/notes.txt', '/notes.md')
 1. fromLens = textLens,  toLens = markdownLens
 2. Same? NO → convert:
    a. text = textLens.toString(ydoc)
       → reads Y.Text('text:content')
       → "---\ntitle: Hello\n---\n# Content\n"

    b. markdownLens.fromString(ydoc, text)
       → parseFrontmatter("---\ntitle: Hello\n---\n# Content\n")
         → { frontmatter: { title: "Hello" }, body: "# Content\n" }
       → writes { title: "Hello" } into Y.Map('md:frontmatter')
       → parses "# Content\n" into ProseMirror doc
       → writes ProseMirror tree into Y.XmlFragment('md:content')

 3. Update metadata: name='notes.md'
```

After this, the Y.Doc has:
```
├── 'text:content'    → "---\ntitle: Hello\n---\n# Content\n"   [STALE, never read while .md]
├── 'md:content'      → <heading>Content</heading>               [ACTIVE]
└── 'md:frontmatter'  → { title: "Hello" }                       [ACTIVE]
```

### Case 3: Markdown → Text

```
mv('/notes.md', '/notes.txt')
 1. fromLens = markdownLens,  toLens = textLens
 2. Same? NO → convert:
    a. text = markdownLens.toString(ydoc)
       → reads Y.Map('md:frontmatter') → { title: "Hello" }
       → reads Y.XmlFragment('md:content') → serializes to markdown
       → "---\ntitle: Hello\n---\n# Content\n"

    b. textLens.fromString(ydoc, text)
       → clears Y.Text('text:content')
       → inserts "---\ntitle: Hello\n---\n# Content\n"

 3. Update metadata: name='notes.txt'
```

### Case 4: Cross-type rename with parse failure

```
mv('/data.csv', '/data.json')
 1. fromLens = csvLens,  toLens = jsonLens
 2. Same? NO → convert:
    a. text = csvLens.toString(ydoc)
       → "name,age\nAlice,30\nBob,25"

    b. jsonLens.fromString(ydoc, text)
       → JSON.parse(...) → THROWS (not valid JSON)

    c. Catch: csv: keys untouched, json: keys empty

 3. Update metadata: name='data.json'
```

The file is now `.json` but `json:data` is empty. `readFile()` returns `""`. The user renames to `.txt` to recover: `textLens.fromString()` always succeeds.

### Case 5: Rename back (round-trip)

```
Phase 1: Create as notes.md → writes to md:content + md:frontmatter
Phase 2: Rename to notes.txt → serializes md → writes to text:content, md keys become stale
Phase 3: Edit as .txt → text:content updated, md keys still stale (WRONG content)
Phase 4: Rename back to notes.md → serializes text:content → writes to md:content + md:frontmatter (FRESH)
```

Stale keys from phase 1 are overwritten in phase 4. Correctness depends only on reading from the active lens.

### The Conversion Pipeline

All conversions go through a single pipeline:

```
old lens → toString() → PLAIN STRING → fromString() → new lens
```

With N lenses, you need N `toString` + N `fromString` = 2N functions.
You do NOT need N*(N-1) pairwise converters.
Text is the universal intermediate format.

---

## Healing: Cross-Peer Timing Recovery

When two peers are connected, a rename's metadata change can sync before the content migration. Peer B sees a `.md` file but only the `text:content` key is populated.

### How healing works

Called before every `readFile` and `writeFile`:

```
registry.heal(ydoc, 'notes.md')
 1. expectedLens = registry.lensForFile('notes.md')   → markdownLens
 2. markdownLens.hasContent(ydoc)?
    → ydoc.share.has('md:content')? → NO (key doesn't exist yet)
    → return false
 3. Probe other lenses:
    → textLens.hasContent(ydoc)?
      → ydoc.share.has('text:content')? → YES
      → ydoc.getText('text:content').length > 0? → YES
    → FOUND content in wrong lens
 4. Migrate:
    → text = textLens.toString(ydoc)
    → markdownLens.fromString(ydoc, text)
 5. Done. md:content + md:frontmatter are now populated.
 6. What if fromString() throws?
    → heal() catches, tries next lens with content
    → If all fail, heal() gives up: expected lens stays empty
```

### Why `ydoc.share.has()` matters

`hasContent` checks `ydoc.share.has(key)` BEFORE calling `ydoc.getText(key)` or `ydoc.getXmlFragment(key)`. This is critical because:

- Yjs permanently locks a root-level key to whichever shared type accesses it first
- If healing probes `ydoc.getArray('csv:data')` on a doc that never had CSV content, that key is locked to Y.Array forever
- `ydoc.share.has('csv:data')` checks without creating: avoids phantom keys

### When healing fails

If `fromString()` throws for every source lens, healing cannot migrate. The expected lens's keys remain empty, and `readFile()` returns `""`. Recovery: rename to `.txt` (text lens always accepts any string).

---

## Graceful Degradation

When `fromString()` cannot parse content, the system degrades without losing data.

### Principle: Never Destroy Content You Cannot Replace

The conversion pipeline is two steps: `oldLens.toString()` then `newLens.fromString()`. If step 2 throws, the old lens's keys are untouched (fromString threw before writing). No content is lost.

### The .txt Escape Hatch

`textLens.fromString()` never throws. It accepts any string. Renaming any file to `.txt` recovers content via healing, regardless of what lens originally stored it.

### writeFile() Does NOT Degrade

`writeFile('/data.json', content)` runs `fromString()` unconditionally. Invalid content throws to the caller. Graceful degradation only applies to renames where content was valid for the old format but not the new one.

---

## Why NOT Keep Y.Text Always In Sync

We considered: "what if every lens also writes to `text:content`, so you can always edit via CodeMirror?"

| Model | How it works | Problem |
|-------|-------------|---------|
| **Mutually exclusive** (chosen) | One active lens per file. Others go stale. | None: simple and correct |
| **Y.Text always updated** | Every lens writes to text:content on each edit | User A edits Y.Text, User B edits XmlFragment simultaneously → two CRDTs diverge, no reconciliation possible |
| **Y.Text is source of truth** | Structured lenses are ephemeral, serialize back to Y.Text | y-prosemirror binds to XmlFragment for real-time collab. Serializing back every keystroke while another peer edits Y.Text → two fighting CRDTs |

**The fundamental constraint**: two Yjs shared types cannot be bidirectionally synced without a single-writer coordination layer. That defeats CRDTs (designed for multi-writer, no coordination).

The mutually exclusive model avoids this entirely. The active lens is determined by the file extension. Editing a `.md` file as raw text is a rename away: `mv notes.md notes.txt` triggers automatic conversion. The graceful degradation chain (above) ensures content is never lost.

---

## Implementation Plan

### Step 1: Create `specs/20260210T000000-content-lens-spec.md`

This document (move from plan file to specs/).

### Step 2: Create `packages/epicenter/src/filesystem/content-lens.ts`

- `ContentLens<THandle>` interface
- `LensRegistry` type + `createLensRegistry()` factory
- `textLens` (key: `text:content`)
- `markdownLens` (keys: `md:content`, `md:frontmatter`)
- `TextDocumentHandle`, `MarkdownDocumentHandle` types
- `defaultLensRegistry`

### Step 3: Update `packages/epicenter/src/filesystem/yjs-file-system.ts`

- Add `lenses: LensRegistry = defaultLensRegistry` constructor param
- readFile: `this.lenses.lensForFile(name).toString(ydoc)`
- writeFile: `this.lenses.lensForFile(name).fromString(ydoc, content)`
- mv: in-place `fromLens.toString(ydoc)` → `toLens.fromString(ydoc, text)` (no destroy-and-recreate)

### Step 4: Update `packages/epicenter/src/filesystem/content-doc-store.ts`

- Remove `openDocument()` and `documentHandleToString()`
- `createContentDocStore()` unchanged

### Step 5: Delete `packages/epicenter/src/filesystem/convert-on-switch.ts`

### Step 6: Update `packages/epicenter/src/filesystem/types.ts`

- Remove `DocumentHandle`, `TextDocumentHandle`, `RichTextDocumentHandle`
- Re-export lens types from `content-lens.ts`

### Step 7: Update `packages/epicenter/src/filesystem/index.ts`

### Step 8: Rewrite tests

- `convert-on-switch.test.ts` → `content-lens.test.ts`
- `yjs-file-system.test.ts`: unchanged (same public API)

### Verify

```bash
bun test packages/epicenter/src/filesystem/
```
