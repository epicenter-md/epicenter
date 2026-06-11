# v14 Content Storage Specification

**Date**: 2026-02-10
**Status**: Deferred
**Deferred by**: `specs/20260211T100000-simplified-ytext-content-store.md` (further superseded by `specs/20260211T230000-timeline-content-storage-implementation.md`): v14 migration is a separate project. Core idea (markdown-as-text, single Y.Text per file) implemented with v13 Yjs.
**Supersedes**: `specs/20260210T120000-content-format-spec.md` (the v13 lens architecture), `specs/20260210T150000-content-storage-format-debate.md` (implements its recommendation)
**See also**: `specs/20260211T220000-yjs-content-doc-multi-mode-research.md`: Option F addresses similar goals (multi-mode content, persistent binary, format metadata) on v13. The timeline structure is orthogonal to Yjs version: when v14 arrives, timeline entries could use `Y.Type` instead of `Y.Text`/`Y.XmlFragment`.

---

## Summary

Every file in Epicenter is a Yjs v14 Y.Type storing markdown text as the source of truth. One CRDT shape for all file types. Frontmatter stored as prefixed attrs with per-field last-write-wins. Character-level diffs for all writes. v14 attribution for tracking AI vs human edits.

---

## Why Markdown Text as Source of Truth

### The concurrency asymmetry

Text diffs compose. Tree replacements don't.

When a bash agent calls `writeFile('/doc.md', newMarkdown)`:

**With tree-as-truth (v13 current):**
1. Parse `newMarkdown` into ProseMirror AST
2. Replace entire Y.XmlFragment with new nodes
3. Any concurrent WYSIWYG edits are destroyed

**With markdown-as-truth (this spec):**
1. `currentText = ytype.toString()`
2. `patches = diff(currentText, newMarkdown)`
3. Apply as Y.Type insert/delete ops at character level
4. Yjs merges with concurrent edits from any editor

This is the fundamental reason. Bash agent concurrency is the #1 priority. Character-level diffs preserve concurrent edits. Tree replacement destroys them.

### Every production AI editor agrees

Research into Cursor, Tiptap AI, GitHub Copilot, and Notion AI reveals the same universal pattern:

**Serialize → Generate → Parse → Apply**

- **Cursor**: Two-phase architecture. LLM generates a "sketch" (intent). A trained Apply model integrates the sketch into the codebase via text diffs. Uses Monaco Editor (text-based, not tree-based). Can run 8 parallel agents in isolated git worktrees.

- **Tiptap AI**: Uses a tool-based "brain and hands" architecture. The LLM runs server-side and calls document manipulation tools (`tiptapRead`, `tiptapEdit`, etc.). Serializes to a proprietary "Tiptap Shorthand" format that reduces token costs by ~80%. AI edits create Y.js transactions just like human edits: no special handling needed. CRDT merges everything automatically.

- **GitHub Copilot**: Explicit working set of files. Dual-model architecture considers full session context. Inline diffs with accept/reject.

- **Notion AI**: Block-based architecture where every content unit has context, relationships, and metadata. AI operates on structured blocks. Operation-based sync via Kafka.

No production AI editor works at the tree/AST level for content generation. Markdown/text is the lingua franca. Storing content as text and serving text to AI is zero-impedance.

### What about WYSIWYG quality?

Markdown-as-truth means the WYSIWYG editor (ProseMirror/Milkdown) must parse markdown text on every remote change and diff the ProseMirror tree to update the view. This can cause:

- Cursor position shifts if re-parse changes structure around cursor
- Brief flicker on replace-then-insert diffs
- Loss of transient editor state (ProseMirror-layer undo history)

This matters when two humans edit the same paragraph in WYSIWYG simultaneously. It doesn't matter for the primary use case: bash agents and humans collaborating on markdown files with optional rich rendering.

The Milkdown POC already handles this with counter-based loop prevention and character-level diffs.

**Tiptap's approach is instructive here.** Tiptap uses Yjs CRDTs and treats AI edits as regular Yjs transactions. Multiple users can see AI streaming in real-time. Suggestions are only visible to the requesting user until accepted. This "AI as collaborator" pattern: where AI edits flow through the same CRDT as human edits: is exactly what markdown-as-truth enables.

---

## Yjs v14 Primitives

v14 replaces six shared types (`Y.Text`, `Y.Map`, `Y.Array`, `Y.XmlFragment`, `Y.XmlElement`, `Y.XmlText`) with one: `Y.Type`.

Every `Y.Type` instance simultaneously has:
- **Attributes** (`setAttr`/`getAttr`): key-value pairs. LWW per key.
- **Children** (`insert`/`get`): ordered list of text, objects, or nested Y.Type instances.
- **Formatting** (`format`): inline marks on text runs (bold, italic).

```js
const content = doc.get('content')         // returns Y.Type
content.setAttr('format', 'markdown')      // map-like
content.insert(0, '# Hello\n\n**bold**')   // text-like
```

One type does everything. Package: `@y/y` (v14.0.0-22+). Editor bindings: `@y/codemirror`, `@y/prosemirror`.

---

## Per-File Y.Doc Structure

```
Y.Doc (guid = fileId, gc: false)
└── Y.Type('content')
    ├── attr 'format'      → 'text' | 'markdown'
    ├── attr 'fm:title'    → 'My Document'          ← only when format='markdown'
    ├── attr 'fm:tags'     → ['crdt', 'yjs']        ← only when format='markdown'
    ├── attr 'fm:date'     → '2026-02-10'           ← only when format='markdown'
    └── text: '# Hello\n\nThis is **bold** text.\n'
```

One Y.Type. One key. Attrs for metadata and frontmatter. Text for content. Both text and markdown files have the same CRDT shape.

---

## Do We Still Need the Text/Markdown Format Distinction?

**Yes, but it's lighter than before.** The format attr answers one question: "does this file have frontmatter?"

Without the format attr, the system would need to:
- Infer from extension every time → back to extension-based behavior (the thing we eliminated)
- Always try to parse frontmatter → fragile (a YAML file starts with `---`, a shell script might too)
- Never handle frontmatter in the CRDT layer → push complexity to every editor

With the format attr:
- `readFile()` for `text`: return `content.toString()`: done
- `readFile()` for `markdown`: collect `fm:*` attrs, serialize as YAML frontmatter, prepend to `content.toString()`
- `writeFile()` for `text`: diff text, apply: done
- `writeFile()` for `markdown`: extract frontmatter from input string, update `fm:*` attrs, diff body text

The format attr does NOT change the CRDT shape. Both formats are text in a Y.Type. It only affects how `readFile`/`writeFile` handle frontmatter serialization.

**What format buys editors:**
- `text` format → offer CodeMirror, syntax highlighting based on extension
- `markdown` format → additionally offer WYSIWYG toggle (Milkdown/ProseMirror), render frontmatter as form fields

**What format does NOT do:**
- Change the CRDT structure (same for both)
- Require separate lenses or key namespaces (eliminated)
- Trigger content migration on rename (eliminated)

---

## Frontmatter: Per-Key LWW via Prefixed Attrs

### The problem with storing frontmatter as one attr

```js
// BAD: whole-object LWW
content.setAttr('frontmatter', { title: 'My Doc', tags: ['a', 'b'] })
```

`setAttr` is LWW per attr key. The `frontmatter` key is one key. If User A changes `title` and User B changes `tags` concurrently, the last writer's ENTIRE frontmatter object wins. The other user's change is silently lost.

This is wrong. Frontmatter fields are independent key-value pairs. Editing `title` should not conflict with editing `tags`.

### The solution: prefixed attrs

```js
// GOOD: per-field LWW
content.setAttr('fm:title', 'My Doc')
content.setAttr('fm:tags', ['a', 'b'])
content.setAttr('fm:date', '2026-02-10')
```

Each frontmatter field is a separate attr with the `fm:` prefix. Y.Type attrs are LWW per key. Two users editing different frontmatter fields merge cleanly: each key resolves independently.

**Reading frontmatter:**
```js
function getFrontmatter(content: YType): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of content.getAttrs()) {
    if (key.startsWith('fm:')) {
      result[key.slice(3)] = value
    }
  }
  return result
}
```

**Writing frontmatter from parsed YAML:**
```js
function setFrontmatter(content: YType, fm: Record<string, unknown>): void {
  // Set/update fields from parsed frontmatter
  for (const [key, value] of Object.entries(fm)) {
    const current = content.getAttr(`fm:${key}`)
    if (!deepEqual(current, value)) {
      content.setAttr(`fm:${key}`, value)
    }
  }
  // Delete fields not in new frontmatter
  for (const [key] of content.getAttrs()) {
    if (key.startsWith('fm:') && !(key.slice(3) in fm)) {
      content.deleteAttr(key)
    }
  }
}
```

### Attr naming convention

| Prefix | Purpose | Example |
|--------|---------|---------|
| (none) | System metadata | `format` |
| `fm:` | Frontmatter fields | `fm:title`, `fm:tags`, `fm:date` |

Reserved attr keys: `format`. Everything else with `fm:` prefix is user frontmatter.

### Frontmatter value types

Attrs store JSON-compatible values. Supported frontmatter types:
- Strings: `content.setAttr('fm:title', 'Hello')`
- Numbers: `content.setAttr('fm:version', 2)`
- Booleans: `content.setAttr('fm:draft', true)`
- Arrays: `content.setAttr('fm:tags', ['a', 'b'])`
- Null: `content.deleteAttr('fm:draft')` (deletion = field removed)

Nested objects in frontmatter are stored as plain JSON values (LWW on the whole nested object). This is acceptable: deeply nested frontmatter is rare and concurrent edits to nested sub-fields are rarer still.

---

## Attribution System

### What v14 attribution enables

v14 introduces an attribution system that tracks who made what changes and when. This is built into the CRDT, not bolted on.

### How it works

Every piece of content in Yjs is identifiable by a unique `ID` (a pair of `clientId` + `clock`). Attribution maps these IDs to metadata (who inserted/deleted/formatted them).

**Core primitives:**
- `IdSet`: efficiently represents ranges of content IDs
- `IdMap`: maps content IDs to attribution metadata (author, timestamp, etc.)
- Supports diff, merge, intersect, and filter operations

**Attribution manager types:**

| Manager | Purpose | Use case |
|---------|---------|----------|
| `NoAttributionsManager` | No tracking (pass-through) | Production with attribution disabled |
| `TwosetAttributionManager` | Tracks insertions and deletions | Basic "who wrote this" |
| `DiffAttributionManager` | Highlights differences between two doc states | "What changed?" with accept/reject |
| `SnapshotAttributionManager` | Compares two historical snapshots | Version history attribution |

### How attribution works for AI edits

When a bash agent calls `writeFile()`, the system applies character-level diffs to the Y.Type. Each insert/delete operation is tagged with the agent's `clientId`. Attribution is automatic: every Yjs operation already carries its creator's ID.

**Reading attribution:**
```js
const attrManager = new TwosetAttributionManager()

// Get delta with attribution
const delta = content.toDelta(attrManager)
// Returns:
// [
//   { insert: 'Hello ', attribution: { insert: ['user-123'] } },
//   { insert: 'world', attribution: { insert: ['ai-agent-456'] } },
// ]
```

**The "suggestion mode" workflow (DiffAttributionManager):**
```js
// Create diff attribution between two states
const attrManager = createAttributionManagerFromDiff(prevDoc, currentDoc)

// Get delta showing what changed
const delta = content.toDelta(attrManager)
// Returns entries with attribution marking inserts/deletes

// Accept specific changes
attrManager.acceptChanges(startId, endId)

// Reject specific changes (reverts them)
attrManager.rejectChanges(startId, endId)

// Accept/reject all
attrManager.acceptAllChanges()
attrManager.rejectAllChanges()
```

### Attribution for Epicenter: the design

**Phase 1 (now): Implicit attribution via clientId**

Every Y.Doc operation already carries the `clientId` of the peer that created it. This is free, no extra code needed. The system can already answer "which client wrote this character."

To make this useful:
- Assign deterministic `clientId` ranges: human users get one range, AI agents get another
- Or: store a `clientId → { type: 'human' | 'ai', name: string }` mapping in workspace metadata

**Phase 2 (later): Explicit attribution with DiffAttributionManager**

When an AI agent edits a file:
1. Take a snapshot before the edit: `const prevSnapshot = Y.snapshot(ydoc)`
2. Apply the agent's changes via `writeFile()`
3. Create diff attribution: `createAttributionManagerFromDiff(prevSnapshot, Y.snapshot(ydoc))`
4. Present to user as "AI suggestions" with accept/reject per change

This enables the Tiptap-style workflow where AI changes are visible but not committed until the user accepts them.

**Phase 3 (future): Rich attribution metadata**

v14's `createContentAttribute(name, value)` allows custom attribution attributes:
```js
const aiAttr = createContentAttribute('source', 'ai-agent')
const humanAttr = createContentAttribute('source', 'human')
// These get attached to specific content ranges
```

This enables:
- "AI wrote this paragraph" annotations in the WYSIWYG editor
- Heatmaps showing AI vs human contribution ratio
- Audit trails for compliance

### What attribution does NOT solve

- **Conflict resolution**: Attribution tracks who wrote what. It doesn't change how conflicts resolve (still LWW for attrs, CRDT merge for text).
- **Permissions**: Attribution doesn't prevent AI from editing. It only records that it did.
- **Undo**: Yjs undo manager is separate from attribution. Attribution tells you who to blame; undo manager lets you revert.

### Cost

Attribution managers are opt-in. When not used, zero overhead. When used:
- `TwosetAttributionManager`: two `IdMap` instances per document. Minimal.
- `DiffAttributionManager`: stores diff between two states. Proportional to changes, not document size.
- Attribution data is NOT persisted in the Y.Doc by default. It's computed on-demand from the existing CRDT history (which is preserved because `gc: false`).

---

## Tiptap AI: Lessons for Epicenter

### Architecture: "Brain and Hands"

Tiptap AI uses a tool-based architecture where the LLM (brain) calls specific document manipulation tools (hands):

| Tool | Purpose |
|------|---------|
| `tiptapRead` | Read document content |
| `tiptapEdit` | Make targeted edits (not full replacement) |
| `tiptapReadSelection` | Read selected content |
| `getThreads` | Read comment threads |
| `editThreads` | Modify comment threads |

The LLM doesn't just generate text. It calls structured tools that manipulate the document. This is more sophisticated than prompt → replace.

### Token efficiency: Tiptap Shorthand

Tiptap serializes ProseMirror content to a proprietary "Tiptap Shorthand" format that reduces token costs by ~80% vs HTML. This is their competitive advantage.

**Lesson for Epicenter:** Markdown is already token-efficient. A `.md` file stored as text in Y.Type is already in the most LLM-native format possible. No custom serialization needed. This is an advantage of markdown-as-truth: the storage format IS the LLM format.

### Streaming AI edits

Tiptap supports streaming LLM responses with a typewriter effect. The `streamContent` command accepts a `ReadableStream<Uint8Array>` and renders partial content in real-time.

**Lesson for Epicenter:** With markdown-as-truth, streaming AI edits = streaming text insertions into the Y.Type. Each chunk is a `content.insert()` call. Yjs syncs these incrementally to other peers. All peers see the AI typing in real-time: for free, because it's just CRDT operations.

### Collaborative AI

Tiptap treats AI edits as regular Yjs transactions. Multiple users see AI streaming in real-time. Suggestions are only visible to the requesting user until accepted.

**Lesson for Epicenter:** This validates the markdown-as-truth approach. If AI edits are character-level operations on a Y.Type text, they merge with human edits via CRDT. No special handling. The "AI as collaborator" pattern works because text diffs compose.

### Diff and review

Tiptap shows AI changes as inline colored diffs. Users can accept or reject individual changes.

**Lesson for Epicenter:** v14 `DiffAttributionManager` enables this at the CRDT level. Take a snapshot before AI edits, compute diff after, present with accept/reject. This is more powerful than Tiptap's approach because it works at the CRDT level (not just the editor level), meaning it works across editors (WYSIWYG, CodeMirror, bash).

---

## Single Content Handler

Since both text and markdown files share the same CRDT shape, the lens registry from the v13 content-format-spec is replaced with a single content handler.

```typescript
interface ContentHandler {
  /** Read format from Y.Type attrs */
  getFormat(ydoc: Y.Doc): 'text' | 'markdown'

  /** Serialize Y.Type to string (plain text or markdown with frontmatter) */
  toString(ydoc: Y.Doc): string

  /** Parse string and write to Y.Type (diff-based, never full replacement) */
  fromString(ydoc: Y.Doc, content: string): void

  /** Initialize a new file's Y.Type with format + content */
  initFile(ydoc: Y.Doc, format: 'text' | 'markdown', content: string): void

  /** Infer format from filename (only at creation time) */
  inferFormat(fileName: string): 'text' | 'markdown'
}
```

### Implementation

```typescript
function createContentHandler(): ContentHandler {
  return {
    getFormat(ydoc) {
      return ydoc.get('content').getAttr('format') ?? 'text'
    },

    toString(ydoc) {
      const content = ydoc.get('content')
      const format = content.getAttr('format')
      if (format === 'markdown') {
        const fm = getFrontmatter(content)
        return serializeMarkdownWithFrontmatter(fm, content.toString())
      }
      return content.toString()
    },

    fromString(ydoc, text) {
      const content = ydoc.get('content')
      const format = content.getAttr('format')
      if (format === 'markdown') {
        const { frontmatter, body } = parseFrontmatter(text)
        ydoc.transact(() => {
          setFrontmatter(content, frontmatter)
          applyTextDiff(content, body)
        })
      } else {
        applyTextDiff(content, text)
      }
    },

    initFile(ydoc, format, text) {
      const content = ydoc.get('content')
      ydoc.transact(() => {
        content.setAttr('format', format)
        if (format === 'markdown') {
          const { frontmatter, body } = parseFrontmatter(text)
          setFrontmatter(content, frontmatter)
          content.insert(0, body)
        } else {
          content.insert(0, text)
        }
      })
    },

    inferFormat(fileName) {
      const ext = fileName.slice(fileName.lastIndexOf('.'))
      if (ext === '.md' || ext === '.mdx') return 'markdown'
      return 'text'
    },
  }
}
```

### applyTextDiff

The critical function. Computes a character-level diff and applies as Y.Type insert/delete ops:

```typescript
function applyTextDiff(ytype: YType, newText: string): void {
  const currentText = ytype.toString()
  if (currentText === newText) return

  const patches = diffChars(currentText, newText)  // e.g., fast-diff or diff library
  let offset = 0
  for (const patch of patches) {
    if (patch.type === 'equal') {
      offset += patch.length
    } else if (patch.type === 'delete') {
      ytype.delete(offset, patch.length)
    } else if (patch.type === 'insert') {
      ytype.insert(offset, patch.text)
      offset += patch.text.length
    }
  }
}
```

This is what makes bash agent writes safe for concurrent editing. Instead of "delete all, insert all" (tree replacement), it's surgical character-level operations that Yjs can merge with concurrent edits from any other peer.

---

## Filesystem Operations

### readFile(path)

```
1. Resolve path → FileId → get row from files table
2. if (row.type === 'folder') throw EISDIR
3. ydoc = store.ensure(fileId)
4. return contentHandler.toString(ydoc)
```

### writeFile(path, content): new file

```
1. Path doesn't exist → create file
2. format = contentHandler.inferFormat(name)
3. Generate FileId
4. filesTable.set({ id, name, parentId, type: 'file', ... })
5. ydoc = store.ensure(fileId)
6. contentHandler.initFile(ydoc, format, content)
```

### writeFile(path, content): existing file

```
1. Resolve path → FileId → get row
2. ydoc = store.ensure(fileId)
3. contentHandler.fromString(ydoc, content)
4. Update size + mtime in files table
```

### mv(src, dest)

```
1. Resolve source → FileId
2. Parse dest → newParentId + newName
3. Validate + assert unique
4. filesTable.update(id, { name: newName, parentId: newParentId, updatedAt: Date.now() })
```

That's it. No content doc access. No format check. No conversion. Always metadata-only.

### convertFormat(path, targetFormat)

```
1. Resolve path → FileId → get row
2. if (row.type === 'folder') throw EISDIR
3. ydoc = store.ensure(fileId)
4. content = ydoc.get('content')
5. currentFormat = content.getAttr('format')
6. if (currentFormat === targetFormat) return

7. ydoc.transact(() => {
     if (currentFormat === 'text' && targetFormat === 'markdown') {
       // Text → Markdown: try to extract frontmatter from text
       const text = content.toString()
       const { frontmatter, body } = parseFrontmatter(text)
       if (Object.keys(frontmatter).length > 0) {
         setFrontmatter(content, frontmatter)
         applyTextDiff(content, body)  // remove frontmatter from text body
       }
     } else if (currentFormat === 'markdown' && targetFormat === 'text') {
       // Markdown → Text: serialize frontmatter back into text
       const fm = getFrontmatter(content)
       if (Object.keys(fm).length > 0) {
         const fullText = serializeMarkdownWithFrontmatter(fm, content.toString())
         clearFrontmatter(content)     // remove fm: attrs
         applyTextDiff(content, fullText)
       }
     }
     content.setAttr('format', targetFormat)
   })
```

Note: `convertFormat` for text↔markdown is simpler than the v13 spec because both formats use the same CRDT shape. No content migration, just moving frontmatter between attrs and text body.

---

## What This Spec Removes

| Concept | Where it lived | Why it's gone |
|---------|---------------|---------------|
| `healContentType()` | `convert-on-switch.ts` | No wrong-key scenario: format attr is authoritative |
| `hasContent()` on lenses | Content lens interface | Only existed for healing probes |
| `FormatRegistry` / lens registry | `content-lens.ts` | Single content handler, no registry needed |
| `getExtensionCategory()` | `convert-on-switch.ts` | Extension no longer determines format |
| Extension-conditional `mv` | `yjs-file-system.ts` | `mv` is always metadata-only |
| `store.destroy()` in `mv` | `yjs-file-system.ts` | Y.Doc never destroyed on rename |
| `convert-on-switch.ts` | Entire file | All functionality replaced |
| `Y.XmlFragment` content storage | Content docs | Replaced by Y.Type text |
| `Y.Map` frontmatter storage | Content docs | Replaced by Y.Type prefixed attrs |
| Namespaced keys (`text:content`, `md:content`) | Content docs | One key: `'content'` |
| ProseMirror serialization in filesystem | `markdown-helpers.ts` | No XmlFragment to serialize |

## What This Spec Keeps

| Concept | Where | Why |
|---------|-------|-----|
| Two-layer architecture | Overall design | Flat metadata table + per-file content docs. Still right. |
| `ContentDocStore` | `content-doc-store.ts` | Y.Doc lifecycle. Unchanged. |
| `parseFrontmatter()` | `markdown-helpers.ts` | Still needed for extracting YAML from text |
| `serializeMarkdownWithFrontmatter()` | `markdown-helpers.ts` | Still needed for prepending YAML |
| `gc: false` on content docs | Content doc creation | Revision history via snapshots |
| `gc: true` on metadata | Main Y.Doc | Compact file tree |
| FileId as Y.Doc guid | Content doc creation | 1:1 mapping |
| Files table schema | `file-table.ts` | `type: 'file' | 'folder'`. Unchanged. |

---

## Files to Modify

| File | Action |
|------|--------|
| `content-handler.ts` | **Create**: `ContentHandler` interface, `createContentHandler()`, `applyTextDiff()`, frontmatter attr helpers |
| `yjs-file-system.ts` | **Modify**: use ContentHandler. Simplify mv. Add convertFormat. Remove healing/extension code. |
| `content-doc-store.ts` | **Modify**: remove openDocument/documentHandleToString. Keep ensure/destroy/destroyAll. |
| `convert-on-switch.ts` | **Delete** entirely |
| `types.ts` | **Simplify**: remove DocumentHandle variants, ExtensionCategory |
| `markdown-helpers.ts` | **Modify**: keep parseFrontmatter, serializeMarkdownWithFrontmatter, deepEqual. Remove serializeXmlFragmentToMarkdown, updateYXmlFragmentFromString, updateYMapFromRecord, yMapToRecord (frontmatter helpers move to content-handler). |
| `index.ts` | **Update** exports |
| `package.json` | **Update**: `yjs` → `@y/y` (v14 beta), add `fast-diff` or similar |
| Tests | **Rewrite**: remove healing tests, add ContentHandler tests, update filesystem tests |

---

## New Dependency: Text Diff

`applyTextDiff()` needs a character-level diff library. Options:

| Library | Size | Speed | Output |
|---------|------|-------|--------|
| `fast-diff` | 2KB | Fast | Array of [type, text] tuples |
| `diff` (npm) | 15KB | Moderate | Array of change objects |
| `diff-match-patch` | 50KB | Fast | Patch objects with context |

Recommend `fast-diff`: smallest, fastest, sufficient for character-level diffs. No patch context needed since we apply ops directly to Y.Type.

---

## Verification

```bash
bun test packages/epicenter/src/filesystem/
```

Checklist:
- [ ] Y.Doc has single Y.Type('content') with attrs + text
- [ ] `readFile()` returns plain text (format=text) or markdown with frontmatter (format=markdown)
- [ ] `writeFile()` applies character-level diff (never full replacement)
- [ ] Two concurrent `writeFile()` calls merge at character level
- [ ] `mv()` never touches content doc: pure metadata update
- [ ] `convertFormat()` moves frontmatter between attrs and text body
- [ ] Frontmatter attrs use `fm:` prefix with per-key LWW
- [ ] Two users editing different frontmatter fields don't conflict
- [ ] New file creation infers format from extension, stores as attr
- [ ] `convert-on-switch.ts` is deleted
- [ ] No references to healing, XmlFragment, or extension categories remain
- [ ] Attribution via clientId distinguishes AI vs human edits

---

## Related Specs

- `specs/20260208T000000-yjs-filesystem-spec.md`: Original filesystem spec. Two-layer architecture, files table, runtime indexes still valid. Content format sections superseded.
- `specs/20260210T120000-content-format-spec.md`: Superseded by this spec. The insight about format-as-metadata is preserved. The lens registry and namespaced keys are simplified away.
- `specs/20260210T150000-content-storage-format-debate.md`: This spec implements Option A (markdown text as truth) from that document.
- `specs/20260209T000000-simplify-content-doc-lifecycle.md`: Still valid. ContentDocStore unchanged.
