# Y.Text-Backed ProseMirror: Unified Content Model

**Date**: 2026-02-08
**Status**: Superseded by `specs/20260208T000000-yjs-filesystem-spec.md`
**Author**: AI-assisted

> **Superseded**: The dual-key approach (Y.XmlFragment for `.md`, Y.Text for code) was kept. Y.Text-only unification is deferred indefinitely: the custom ProseMirror binding it requires (replacing y-prosemirror's cursor/presence, undo/redo, and bidirectional sync) was estimated at 2-4 weeks plus ongoing maintenance. The primary concern (destructive agent writes via clear-and-rebuild) is noted as a future optimization via y-prosemirror's `updateYFragment` (Approach B). See the main filesystem spec for the current design.

## Overview

Replace Y.XmlFragment with Y.Text as the universal backing type for all file content, including `.md` files. Milkdown/ProseMirror renders from Y.Text via remark parsing and serializes back via remark-stringify, rather than binding to Y.XmlFragment through y-prosemirror.

## Motivation

### Current State

The filesystem spec uses file-type-driven Yjs backing:

```typescript
// .md files → Y.XmlFragment (ProseMirror tree via y-prosemirror)
// everything else → Y.Text (raw characters)
```

`y-doc-sync.ts` has two write paths:

```typescript
// Y.Text: character-level diffing, preserves CRDT identity
export function updateYTextFromString(yText: Y.Text, newString: string): void {
  const diffs = diffChars(currentString, newString);
  doc.transact(() => {
    for (const change of diffs) {
      if (change.added) yText.insert(index, change.value);
      else if (change.removed) yText.delete(index, change.value.length);
      else index += change.value.length;
    }
  });
}

// Y.XmlFragment: destructive clear-and-rebuild
export function updateYXmlFragmentFromString(/* ... */): void {
  doc.transact(() => {
    xmlFragment.delete(0, xmlFragment.length); // nuke everything
    apply(xmlFragment, markdown);              // rebuild from scratch
  });
}
```

This creates problems:

1. **Agent writes destroy CRDT identity on `.md` files.** When an agent does `writeFile` on a `.md` file, `updateYXmlFragmentFromString` deletes every node and re-inserts from scratch. Every character loses its CRDT identity. If a human is concurrently editing in ProseMirror, their in-flight edits get obliterated. This makes agents and human editors unable to coexist on markdown files.

2. **Two code paths for content access.** `readFile` branches on file type (serialize XmlFragment vs `Y.Text.toString()`). `writeFile` branches on file type (parse markdown into XmlFragment vs character diff into Y.Text). Every content operation carries this split.

3. **Dual-key complexity.** Each content Y.Doc has both `'text'` and `'richtext'` root keys. Convert-on-switch logic handles file extension changes. This exists to support a case (renaming `.txt` ↔ `.md`) that rarely happens.

4. **Tree diffing is impractical.** `RESEARCH_TREE_DIFFING_ANALYSIS.md` concluded that structural tree diffing for Y.XmlFragment is not viable: ProseMirror nodes have no global IDs, tree diffing is O(n^2 log n) minimum, markdown conversion is lossy, and schema constraints require post-diff repair. The clear-and-rebuild approach is the only pragmatic option for XmlFragment, which means agent writes on `.md` will always be destructive.

### Desired State

```typescript
// Every file → Y.Text (raw characters)
// .md files: Milkdown renders from Y.Text via remark, serializes back on edit
// .ts/.js/etc: CodeMirror binds to Y.Text directly (unchanged)
```

One write path. One data model. `updateYTextFromString` is the universal content write function. Agent `writeFile` on `.md` gets the same clean character-level diffs as `.txt`.

---

## Research Findings

### How Milkdown Works Today

Milkdown is a ProseMirror editor with a remark-powered bidirectional markdown pipeline. The `@milkdown/transformer` package handles conversion:

```
Markdown string
    → remark-parse (unified)     → MDAST
    → ParserState (schema runners) → ProseMirror document

ProseMirror document
    → SerializerState (schema runners) → MDAST
    → remark-stringify (unified)        → Markdown string
```

Each node/mark schema defines both `parseMarkdown` (MDAST → ProseMirror nodes) and `toMarkdown` (ProseMirror nodes → MDAST). This pipeline already exists and runs on load/save. The proposal extends it to run on every edit.

**Source**: DeepWiki analysis of `Milkdown/milkdown`, `@milkdown/transformer` package.

### How y-prosemirror Binds Today

`y-prosemirror`'s `ProsemirrorBinding` maps ProseMirror's node tree 1:1 to Y.XmlFragment:

| ProseMirror | Y.XmlFragment |
|---|---|
| `doc` node | `Y.XmlFragment` (root) |
| Block node (paragraph, heading) | `Y.XmlElement('paragraph')` |
| Text run | `Y.XmlText` with mark attributes |
| Cursor position | `absolutePositionToRelativePosition` walking XML tree |

The binding is bidirectional:
- **Local edits**: `updateYFragment` diffs ProseMirror doc against Y.XmlFragment, applies Yjs operations
- **Remote changes**: `_typeChanged` observer reconstructs ProseMirror fragment, dispatches transaction

Cursor/presence code does `instanceof Y.XmlText` / `instanceof Y.XmlElement` checks. This is hardcoded to Y.XmlFragment. There is no configuration to swap it for Y.Text.

**Source**: DeepWiki analysis of `yjs/y-prosemirror`, `ProsemirrorBinding` class.

### Y.Text vs Y.XmlFragment Data Models

| Dimension | Y.Text | Y.XmlFragment |
|---|---|---|
| Structure | Linear sequence of characters + formatting attributes | Tree of `Y.XmlElement` and `Y.XmlText` nodes |
| Identity | Per-character CRDT identity | Per-node CRDT identity |
| Diffing | `diffChars` → minimal insert/delete ops | No practical algorithm (see research doc) |
| ProseMirror binding | None exists (this spec proposes one) | `y-prosemirror` (battle-tested) |
| CodeMirror binding | `y-codemirror.next` (production) | N/A |
| `toString()` | Exact content, lossless | XML serialization (not useful for markdown) |
| Agent compatibility | Direct read/write as plain text | Requires serialize/parse roundtrip |

**Key finding**: Y.Text's character-level CRDT identity is exactly what agent workflows need. The challenge is making ProseMirror work with it.

**Source**: DeepWiki analysis of `yjs/yjs`, Yjs INTERNALS.md.

### Approaches Evaluated

| Approach | Description | Verdict |
|---|---|---|
| **A: Y.Text for everything** | ProseMirror serializes to/from markdown string in Y.Text | **Recommended**: unified model, clean agent writes |
| **B: Fix XmlFragment diffing** | Implement structural tree diff for `updateYXmlFragmentFromString` | Rejected: research concluded tree diffing is impractical |
| **C: Y.Text, no real-time collab** | Y.Text as source of truth, ProseMirror is local-only rendering | Too much UX loss: cursor jumps on every remote edit |

---

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Backing type for `.md` | Y.Text | Enables `updateYTextFromString` for agent writes. Eliminates dual-key system. |
| ProseMirror binding | Custom (replace y-prosemirror) | y-prosemirror is hardcoded to Y.XmlFragment. No configuration path. |
| Serialization frequency | On every ProseMirror transaction | Required for CRDT sync. remark-stringify is <1ms for typical docs. |
| Parse frequency | On every remote Y.Text change | Required for rendering updates. remark-parse is <1ms for typical docs. |
| Cursor/presence | Markdown offset → ProseMirror position mapping table | y-prosemirror's cursor plugin won't work. Custom mapping needed. |
| Undo/redo | `Y.UndoManager` on Y.Text | y-prosemirror's `yUndoPlugin` requires XmlFragment. UndoManager on Y.Text gives character-level undo. |
| Content doc keys | Single `'text'` key (Y.Text) | No dual keys. No convert-on-switch. |
| Normalization | Accept one-time normalization on first agent write | Deterministic serializer (remark-stringify) stabilizes after one roundtrip. |

---

## Architecture

### Current Architecture (what changes)

```
Per-File Y.Doc
  ├── Y.XmlFragment('richtext')  →  y-prosemirror  →  Milkdown/ProseMirror   [.md]
  └── Y.Text('text')             →  y-codemirror    →  CodeMirror             [all other]
```

### Proposed Architecture

```
Per-File Y.Doc
  └── Y.Text('text')  ─┬─  y-codemirror           →  CodeMirror   [code files]
                        └─  custom markdown binding →  Milkdown     [.md files]
```

### Custom Markdown Binding: Data Flow

```
OUTBOUND (user types in ProseMirror)
══════════════════════════════════════
ProseMirror transaction
    │
    ▼
SerializerState (remark-stringify)
    │
    ▼
New markdown string
    │
    ▼
diffChars(Y.Text.toString(), newMarkdown)
    │
    ▼
Minimal Y.Text insert/delete operations


INBOUND (remote Y.Text change from agent or another user)
══════════════════════════════════════════════════════════
Y.Text observer fires
    │
    ▼
Y.Text.toString() → new markdown string
    │
    ▼
ParserState (remark-parse)
    │
    ▼
New ProseMirror document
    │
    ▼
Compute minimal ProseMirror transaction (old doc → new doc)
    │
    ▼
Dispatch transaction to editor view
```

### Filesystem Spec Changes

```typescript
// BEFORE: Two document handle types
type DocumentHandle = TextDocumentHandle | RichTextDocumentHandle;

// AFTER: One type
type DocumentHandle = {
  fileId: string;
  ydoc: Y.Doc;
  content: Y.Text;
};

function openDocument(fileId: Guid): DocumentHandle {
  const ydoc = new Y.Doc({ guid: fileId, gc: false });
  return { fileId, ydoc, content: ydoc.getText('text') };
}
```

```typescript
// BEFORE: writeFile branches on file type
if (handle.kind === 'text') {
  updateYTextFromString(handle.content, content);
} else {
  applyMarkdownToXmlFragment(handle.content, content);
}

// AFTER: one path for everything
updateYTextFromString(handle.content, content);
```

---

## Implementation Plan

### Phase 1: Core Binding

- [ ] **1.1** Create `MilkdownYTextBinding` class that connects a Milkdown editor to a Y.Text
  - Observes ProseMirror transactions → serialize → diff → Y.Text operations (outbound)
  - Observes Y.Text changes → parse → compute ProseMirror transaction → dispatch (inbound)
  - Loop prevention: flag-based guards (same pattern as `y-doc-sync.ts` bidirectional spec)
- [ ] **1.2** Implement position mapping table (markdown offset ↔ ProseMirror position)
  - Updated on each serialize pass
  - Used for cursor/presence and for computing minimal ProseMirror transactions on inbound
- [ ] **1.3** Implement cursor/presence via Yjs Awareness + position mapping
  - Store markdown byte offsets in Awareness state
  - Render as ProseMirror decorations using position mapping table

### Phase 2: Integrate with Filesystem

- [ ] **2.1** Update `DocumentHandle` to always use Y.Text: remove `TextDocumentHandle` / `RichTextDocumentHandle` discriminated union
- [ ] **2.2** Remove dual-key system (`'text'` / `'richtext'`): single `'text'` key
- [ ] **2.3** Remove `updateYXmlFragmentFromString` from `y-doc-sync.ts`
- [ ] **2.4** Remove convert-on-switch logic from rename operations
- [ ] **2.5** Update `readFile` / `writeFile` to use single code path

### Phase 3: Undo/Redo and Polish

- [ ] **3.1** Integrate `Y.UndoManager` on Y.Text for undo/redo in Milkdown
- [ ] **3.2** Verify undo granularity is acceptable (character-level vs transaction-level)
- [ ] **3.3** Performance profiling: serialize/parse latency on documents of various sizes
- [ ] **3.4** Migration path for existing content docs that have Y.XmlFragment data

---

## Edge Cases

### Concurrent Syntax Marker Corruption

1. User A wraps "hello" in bold: Y.Text becomes `**hello**`
2. User B simultaneously inserts "world " before "hello"
3. CRDT merge could produce `**world hello**` or `world **hello**` depending on offsets

This is the same class of problem as concurrent edits in any Y.Text collaborative code editor (e.g., two users editing the same TypeScript file). Markdown syntax can break from concurrent edits near formatting markers. Recovery: the user sees broken markdown rendering momentarily, fixes it manually. No data loss, just a temporary display issue.

### First-Write Normalization

1. User creates a `.md` file with `*italic*` emphasis style
2. Agent reads and writes back via `writeFile` (e.g., after a `sed` edit)
3. `remark-stringify` normalizes to `_italic_` (or whatever the canonical form is)
4. This produces a one-time diff that changes emphasis markers but not content

Acceptable. The normalization is deterministic and stabilizes after one roundtrip. Content is preserved. Only surface-level markdown syntax preferences change.

### Large Document Performance

1. User opens a 100KB+ markdown file
2. On every ProseMirror transaction: serialize entire doc → diffChars → Y.Text ops
3. On every remote change: parse entire markdown → compute ProseMirror transaction

Mitigation: benchmark remark-parse and remark-stringify on 100KB documents. If >5ms, consider debouncing outbound serialization (batch keystrokes into ~50ms windows). For typical documents (<20KB), this is not an issue.

### Inbound Transaction Computation

1. Remote Y.Text change arrives (e.g., agent inserts a paragraph)
2. Parse new markdown → new ProseMirror doc
3. Need minimal ProseMirror transaction to go from old doc → new doc without destroying cursor position

This is the hardest part of the implementation. Options:
- `prosemirror-diff` library for document diffing
- `replaceWith` at the changed region (requires identifying the changed region via markdown string diff positions mapped to ProseMirror positions)
- Full document replacement as fallback (cursor jumps, but correct)

---

## Open Questions

1. **ProseMirror transaction diffing strategy for inbound changes?**
   - Options: (a) `prosemirror-diff` library, (b) position-mapped region replacement, (c) full doc replacement with cursor restoration
   - **Recommendation**: Start with (c) as baseline, iterate to (b) using the position mapping table. Full doc replacement with cursor save/restore is simple and correct: optimize only if the cursor jump is noticeable in practice.

2. **Undo granularity?**
   - `Y.UndoManager` on Y.Text groups by Yjs transaction. Each keystroke → serialize → diffChars → Y.Text ops is one transaction. This means undo undoes one keystroke at a time.
   - **Recommendation**: Use `UndoManager`'s `captureTimeout` (default 500ms) to batch rapid keystrokes into single undo steps. Verify this feels natural.

3. **Should Milkdown offer a source-view toggle?**
   - With Y.Text as backing, a "view source" mode is trivial: bind CodeMirror to the same Y.Text. The user sees raw markdown with full collaborative editing, then switches back to rich view.
   - **Recommendation**: Build this. It's a natural affordance of the unified Y.Text model and addresses the open question in the filesystem spec.

4. **Migration for existing Y.XmlFragment content docs?**
   - Existing `.md` content docs may have data in the `'richtext'` Y.XmlFragment key.
   - Options: (a) lazy migration on open (serialize XmlFragment → populate Y.Text), (b) batch migration script
   - **Recommendation**: (a) Lazy migration. On open, if Y.Text is empty but XmlFragment has content, serialize and populate. One-time per file.

5. **Debounce outbound serialization?**
   - Serializing on every ProseMirror transaction is correct but potentially wasteful for rapid typing.
   - **Recommendation**: Defer this decision. Benchmark first. If serialize + diffChars is consistently <2ms, no debounce needed.

---

## Success Criteria

- [ ] Agent `writeFile` on `.md` preserves CRDT identity for unchanged characters (verified by concurrent edit merge test, same pattern as `y-doc-sync.test.ts` "preserves CRDT identity" test)
- [ ] Milkdown renders and edits `.md` files backed by Y.Text
- [ ] Two users concurrently editing the same `.md` file see each other's cursors and changes merge correctly
- [ ] `readFile` / `writeFile` use a single code path for all file types
- [ ] `DocumentHandle` is a single type (no discriminated union)
- [ ] `updateYXmlFragmentFromString` is removed from the codebase

---

## References

- `packages/epicenter/src/shared/y-doc-sync.ts`: Current `updateYTextFromString` and `updateYXmlFragmentFromString` implementations
- `packages/epicenter/src/shared/y-doc-sync.test.ts`: Test patterns for CRDT identity preservation
- `specs/20260208T000000-yjs-filesystem-spec.md`: Filesystem architecture (Layer 2 is superseded by this spec)
- `RESEARCH_TREE_DIFFING_ANALYSIS.md`: Research concluding tree diffing is impractical
- `packages/epicenter/specs/20251014T105903 bidirectional-markdown-sync.md`: Earlier bidirectional sync work (loop prevention patterns reusable)
- `@milkdown/transformer`: Milkdown's remark-based serialize/parse pipeline (reused, not replaced)
- `y-prosemirror`: Current ProseMirror ↔ Y.XmlFragment binding (replaced by custom binding)
