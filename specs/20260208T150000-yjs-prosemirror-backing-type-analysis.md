# Y.Text vs Y.XmlFragment for ProseMirror Markdown Files

**Date**: 2026-02-08
**Status**: Superseded: see `specs/20260208T000000-yjs-filesystem-spec.md`
**Author**: AI-assisted
**Related**: `specs/20260208T000000-yjs-filesystem-spec.md`

> **Superseded**: The dual-key approach was kept. Approach B (`updateYFragment` instead of clear-and-rebuild) is noted as a future optimization in the main filesystem spec: not adopted yet since the architecture ships with clear-and-rebuild first. The analysis and research findings in this document remain valid reference material.

## Overview

Analysis of whether `.md` files in the Yjs filesystem should be backed by Y.XmlFragment (current spec) or Y.Text, and what the tradeoffs are for revision history, real-time collaboration, cursor/presence, and filesystem interop.

## Motivation

### Current State

The filesystem spec uses Y.XmlFragment for `.md` files and Y.Text for everything else. When the filesystem layer writes to a `.md` file, it does a destructive clear-and-rebuild:

```typescript
// packages/epicenter/src/shared/y-doc-sync.ts
export function updateYXmlFragmentFromString(
  xmlFragment: Y.XmlFragment,
  markdown: string,
  serialize: (fragment: Y.XmlFragment) => string,
  apply: (fragment: Y.XmlFragment, markdown: string) => void,
): void {
  const currentMarkdown = serialize(xmlFragment);
  if (currentMarkdown === markdown) return;

  doc.transact(() => {
    xmlFragment.delete(0, xmlFragment.length);  // destroys all CRDT identity
    apply(xmlFragment, markdown);                // re-creates everything from scratch
  });
}
```

Compare with Y.Text, which preserves CRDT identity for unchanged characters:

```typescript
export function updateYTextFromString(yText: Y.Text, newString: string): void {
  const diffs = diffChars(currentString, newString);
  doc.transact(() => {
    for (const change of diffs) {
      if (change.added) yText.insert(index, change.value);
      else if (change.removed) yText.delete(index, change.value.length);
      else index += change.value.length;  // unchanged chars keep CRDT identity
    }
  });
}
```

This creates problems:

1. **Revision history is useless.** Content docs use `gc: false` for Yjs snapshots, but clear-and-rebuild makes every `writeFile` look like "everything deleted, everything re-inserted." Snapshot diffs can't show what actually changed.
2. **Storage bloat.** With `gc: false`, every clear-and-rebuild stores the full document as tombstones. A 10KB doc rewritten 50 times accumulates ~500KB-2MB of struct store vs. ~50-100KB with character-level diffs.
3. **Cursor/undo disruption.** If a user has the file open in ProseMirror while an agent does `writeFile`, the clear-and-rebuild destroys their cursor position, selection, undo history, and any in-progress IME composition.
4. **Dual-key architecture.** Each content doc maintains both `Y.Text('text')` and `Y.XmlFragment('richtext')` with convert-on-switch logic for file extension changes.

### Desired State

`.md` files should have revision history quality comparable to plain text files: meaningful snapshot diffs showing what actually changed, compact storage proportional to actual changes, and clean filesystem interop.

---

## Research Findings

### How y-prosemirror Binds to Y.XmlFragment

y-prosemirror maps ProseMirror's node tree 1:1 to Y.XmlFragment's tree. Each ProseMirror paragraph becomes a `Y.XmlElement('paragraph')`, each text run becomes `Y.XmlText` with formatting as attributes. The `ProsemirrorBinding` class handles bidirectional sync:

- **Local edits**: `_prosemirrorChanged` → `updateYFragment()` diffs the ProseMirror doc against Y.XmlFragment
- **Remote changes**: `_typeChanged` observer reconstructs a ProseMirror fragment and dispatches a transaction

Cursor/presence uses `absolutePositionToRelativePosition` which traverses Y.XmlElement/Y.XmlText nodes: tightly coupled to the XML tree structure.

**Key finding**: y-prosemirror's `_typeChanged` is NOT minimal work. It iterates all top-level children, rebuilds the fragment array, and replaces the entire ProseMirror document with `tr.replace(0, doc.content.size, ...)`. This is [y-prosemirror issue #113](https://github.com/yjs/y-prosemirror/issues/113). Every plugin sees a full-document replacement.

### How Milkdown Uses y-prosemirror

Milkdown's `@milkdown/plugin-collab` wraps y-prosemirror. The remark transformer (markdown ↔ ProseMirror) only runs on load/save, not during real-time collaboration. During collab, changes flow through y-prosemirror's tree-level binding with no markdown serialization involved.

**Implication**: Milkdown does not solve the Y.Text problem: it uses Y.XmlFragment like everyone else.

### y-prosemirror Exports `updateYFragment`

y-prosemirror exports `updateYFragment(ydoc, yXmlFragment, prosemirrorNode, mapping)`: a tree diffing function that:

1. Scans children left-to-right and right-to-left to find matching endpoints
2. Uses `mappedIdentity` for nodes with prior mappings, `equalYTypePNode` for structural equality
3. Uses `computeChildEqualityFactor` to score candidates
4. For text nodes, uses `simpleDiff` for character-level patching
5. Recursively updates matched children; deletes and re-inserts unmatched ones

With an empty mapping (no prior identity tracking, which is the `writeFile` case), it falls back to structural equality. This preserves CRDT identity for unchanged paragraphs.

**Limitations** ([community discussion](https://discuss.yjs.dev/t/y-prosemirror-updateyfragment-algorithm-accuracy/1273)):
- Greedy matching, no backtracking: reordered content may trigger unnecessary delete+insert
- No move operations in Y.XmlFragment
- Type-prioritized matching can produce suboptimal diffs

### Normalization Loop Concern

The claim: markdown → ProseMirror → markdown is not identity (`*italic*` vs `_italic_`), creating ping-pong between peers.

**Finding: This is a non-issue.**

1. `serialize(parse(serialize(parse(x))))` === `serialize(parse(x))`: converges in one step with a deterministic serializer
2. Serialization only runs on local edits, not on remote observation (same origin-check pattern y-prosemirror uses)
3. remark-stringify with pinned options (`emphasis: '*'`, `strong: '*'`, `bullet: '-'`, etc.) is fully deterministic
4. Content never changes: only syntax markers normalize, which is invisible in the rich text view

### Cursor/Presence with Y.Text

y-codemirror.next and y-quill bind to Y.Text trivially because their position spaces are flat character offsets, matching Y.Text's index space.

ProseMirror positions count node boundaries. A fundamentally different space. Mapping requires:
- Building a `(pmPosition, markdownOffset)` table during serialization
- Snapping when markdown offsets land inside syntax markers (`**`, `#`, etc.)
- Rebuilding the table on every document change

**Assessment**: 2-4 weeks to build, with ongoing maintenance cost for every markdown syntax construct. Edge cases with cursors landing inside formatting markers. Precision loss is ~1-3 characters in worst case (cursor near formatting boundary during concurrent edit). Compare to y-prosemirror's cursor plugin which handles this natively with zero custom code.

The Yjs Awareness protocol is completely independent of shared types. It just broadcasts arbitrary JSON. No coupling to Y.XmlFragment.

### Parse/Serialize Performance

| Document size | remark-parse | markdown-it | remark-stringify (est.) |
|---|---|---|---|
| 1 KB | ~2 ms | ~0.06 ms | ~0.5 ms |
| 5 KB | ~8 ms | ~0.3 ms | ~2 ms |
| 10 KB | ~15 ms | ~0.6 ms | ~4 ms |
| 50 KB | ~75 ms | ~3 ms | ~20 ms |

remark (used by Milkdown) is ~30x slower than markdown-it. With markdown-it, parse cost is negligible for documents under 50KB.

**Key finding**: Since y-prosemirror already replaces the entire ProseMirror document on remote changes (issue #113), the Y.Text approach adds only the parse step on top of a similar replacement. The marginal cost is the parser, not the document replacement.

Incremental/partial reparsing is feasible: Y.Text's observe delta tells you exactly which characters changed, so you can identify the affected markdown block and reparse only that block.

### Concurrent Formatting Problem

Non-overlapping concurrent formatting works correctly with Y.Text:

```
Y.Text: "hello world"
User A bolds "hello" → inserts ** around "hello"
User B bolds "world" → inserts ** around "world"
CRDT merge: "**hello** **world**"  ← Correct
```

Overlapping concurrent formatting can produce invalid markdown:

```
Y.Text: "hello world today"
User A bolds "hello world"  → "**hello world** today"
User B bolds "world today"  → "hello **world today**"
CRDT merge: "**hello **world** today**"  ← Invalid markdown
```

CommonMark's delimiter algorithm may parse this as something neither user intended.

**Assessment**: This is real but narrow. It requires two users formatting overlapping ranges of the same sentence at the same moment. Agents never do formatting. In practice, concurrent edits happen in different paragraphs.

### Snapshot Diff Quality Comparison

**Y.Text with character-level diffs:**
```
Snapshot A: "# Hello\n\nSome content"
Agent changes "content" → "text"
Snapshot B: "# Hello\n\nSome text"

Diff: DELETE "content" at position 17, INSERT "text" at position 17
→ Precise, shows exactly what changed
```

**Y.XmlFragment with clear-and-rebuild:**
```
Diff: DELETE every node, INSERT every node
→ "Everything changed": useless
```

**Y.XmlFragment with updateYFragment:**
```
Diff: Unchanged paragraphs keep identity. Modified paragraph shows changes.
→ Paragraph-level granularity: good but not character-level
```

---

## Design Decisions

### Three approaches evaluated

| Approach | Revision History | Cursor/Presence | Concurrent Formatting | Architecture | Engineering Effort |
|---|---|---|---|---|---|
| **A: Y.Text everywhere** | Excellent: character-level diffs | Custom work (2-4 weeks + maintenance) | Overlapping formatting can break | Simple: one type, no dual keys | Medium-large |
| **B: Y.XmlFragment + updateYFragment** | Good: paragraph-level granularity | Works out of the box | Correct | Dual keys remain | Small: swap one function |
| **C: Y.XmlFragment + clear-and-rebuild** (current) | Useless | Works out of the box | Correct | Dual keys remain | Already done |

| Decision | Choice | Rationale |
|---|---|---|
| Eliminate clear-and-rebuild | Yes | Destroys CRDT identity, makes revision history worthless, bloats storage. No reason to keep it. |
| Which approach for `writeFile` | **Approach B (updateYFragment) as immediate fix** | Small change, big improvement. Unblocks revision history without requiring a new ProseMirror binding. |
| Whether to pursue Approach A | **Deferred** | Architecturally cleaner but front-loads cursor/presence work. Evaluate after Approach B ships and revision history quality is assessed. |
| Parser choice if Approach A is pursued | markdown-it over remark | 30x faster. ~0.3ms for 5KB vs ~8ms. Under frame budget for all practical document sizes. |

---

## Architecture

### Approach B: Replace `updateYXmlFragmentFromString` internals

```
Current (clear-and-rebuild):
  writeFile("# Hello\n\nNew text")
    → serialize current XmlFragment → compare strings
    → xmlFragment.delete(0, length)     ← destroys ALL CRDT identity
    → apply(xmlFragment, markdown)      ← creates ALL new items
    → snapshot diff: "everything changed"

Proposed (updateYFragment):
  writeFile("# Hello\n\nNew text")
    → parse markdown → ProseMirror node tree
    → updateYFragment(doc, xmlFragment, pmNode, new Map())
      → structural matching: unchanged paragraphs keep identity
      → text diffing: changed text gets character-level ops
    → snapshot diff: "paragraph 2 text changed from X to Y"
```

### Approach A (deferred): Y.Text with custom ProseMirror binding

```
Y.Text (markdown string, single source of truth)
  ↕ observe / updateYTextFromString
ProseMirror (rendered view)

Local edit path:
  ProseMirror transaction
    → serialize changed block to markdown (origin: local)
    → diffChars against Y.Text substring
    → apply diff to Y.Text

Remote observe path:
  Y.Text observe delta
    → identify affected markdown block
    → reparse block with markdown-it
    → apply targeted ProseMirror ReplaceStep (origin: remote, suppresses serialize-back)

Presence:
  Local cursor → serialize → find markdown offset → Y.createRelativePositionFromTypeIndex
  Remote cursor → Y.createAbsolutePositionFromRelativePosition → markdown offset → position map → PM position
```

---

## Implementation Plan

### Phase 1: Replace clear-and-rebuild with updateYFragment (Approach B)

- [ ] **1.1** Add `y-prosemirror` and `prosemirror-model` as dependencies in `packages/epicenter`
- [ ] **1.2** Create a headless ProseMirror schema matching Milkdown's schema (paragraph, heading, list, code block, marks)
- [ ] **1.3** Create `markdownToProseMirrorNode(markdown: string, schema: Schema): Node` using remark-parse + the schema
- [ ] **1.4** Replace `updateYXmlFragmentFromString` internals to use `updateYFragment` with an empty mapping
- [ ] **1.5** Verify snapshot diffs show paragraph-level granularity (unchanged paragraphs keep CRDT identity)
- [ ] **1.6** Benchmark storage: compare doc size after 50 `writeFile` calls with old vs new approach

### Phase 2: Evaluate revision history quality

- [ ] **2.1** Build a simple snapshot diff viewer to assess paragraph-level vs character-level granularity
- [ ] **2.2** Determine if paragraph-level is sufficient or if character-level (Approach A) is needed
- [ ] **2.3** Decision point: proceed with Approach A or stay with Approach B

### Phase 3 (conditional): Y.Text binding for ProseMirror (Approach A)

- [ ] **3.1** Build ProseMirror position ↔ markdown offset mapping table
- [ ] **3.2** Implement local edit path: ProseMirror → serialize → diff → Y.Text
- [ ] **3.3** Implement remote observe path: Y.Text delta → reparse block → ProseMirror transaction
- [ ] **3.4** Implement cursor/presence with position mapping and snapping
- [ ] **3.5** Remove dual-key architecture, convert-on-switch logic

---

## Edge Cases

### Concurrent formatting with Approach A (Y.Text)

1. Two users bold overlapping text ranges in the same sentence
2. CRDT merges `**` markers at the character level
3. Resulting markdown may be syntactically invalid
4. ProseMirror re-parses best-effort: formatting may not match either user's intent
5. User can see and fix the result manually. No data loss, just formatting confusion.

### Agent writeFile during active ProseMirror editing

1. User is typing in paragraph 3 of a `.md` file
2. Agent does `writeFile` that modifies paragraph 7
3. With Approach B (`updateYFragment`): paragraph 3 keeps CRDT identity, user's cursor and undo are preserved. Paragraph 7 updates.
4. With current clear-and-rebuild: user's cursor jumps, undo history breaks, IME composition interrupted.

### Schema mismatch between headless and editor (Approach B)

1. Headless ProseMirror schema used in `writeFile` must match the Milkdown editor schema exactly
2. If schemas diverge, `updateYFragment` may produce nodes the editor can't render
3. Mitigation: share the schema definition between headless and editor contexts

### updateYFragment with reordered paragraphs

1. Agent moves paragraph 5 to position 2 via `writeFile`
2. `updateYFragment` has no move operation: it sees: delete at position 5, insert at position 2
3. The moved paragraph gets new CRDT identity
4. Snapshot diff shows a deletion and an insertion rather than a move
5. This is acceptable: moves are rare in agent workflows

---

## Open Questions

1. **Is paragraph-level revision history granularity sufficient?**
   - Approach B gives paragraph-level diffs (unchanged paragraphs keep identity, modified paragraphs show as changed)
   - Approach A gives character-level diffs (exactly which characters changed within a paragraph)
   - **Recommendation**: Ship Approach B first. Evaluate with real agent workflows. If "paragraph 2 changed" is insufficient and you need "word 'foo' changed to 'bar' in paragraph 2," then pursue Approach A.

2. **Which markdown parser for Approach A?**
   - remark-parse: Full CommonMark/GFM, concrete syntax trees, used by Milkdown. ~8ms for 5KB.
   - markdown-it: 30x faster (~0.3ms for 5KB), less precise round-tripping.
   - **Recommendation**: markdown-it for the parse path (speed matters on every remote change), remark-stringify for the serialize path (determinism matters for normalization stability). Or use `prosemirror-markdown` which already uses markdown-it.

3. **Should Approach A use scoped or full-document serialization?**
   - Full-document: simpler, fast enough for documents under 50KB with markdown-it
   - Scoped to changed block: more complex, necessary for very large documents
   - **Recommendation**: Start with full-document. Optimize to scoped only if profiling shows a bottleneck.

4. **How to share the ProseMirror schema between headless and editor?**
   - Option (a): Extract schema definition to a shared package
   - Option (b): Use Milkdown's schema directly in the headless context
   - **Recommendation**: Defer to implementer. The schema needs to be identical.

---

## Success Criteria

- [ ] `writeFile` on a `.md` file preserves CRDT identity for unchanged content
- [ ] Yjs snapshot diffs between two versions show which paragraphs/characters actually changed
- [ ] Storage after 50 `writeFile` calls on a 10KB doc is under 300KB (vs. current ~500KB-2MB)
- [ ] User editing in ProseMirror while agent does `writeFile` to a different paragraph retains cursor position and undo history
- [ ] No regression in real-time ProseMirror-to-ProseMirror collaboration

---

## References

- `packages/epicenter/src/shared/y-doc-sync.ts`: Current `updateYTextFromString` and `updateYXmlFragmentFromString`
- `specs/20260208T000000-yjs-filesystem-spec.md`: Parent filesystem spec
- [y-prosemirror `updateYFragment`](https://github.com/yjs/y-prosemirror): Exported tree diffing function
- [y-prosemirror issue #113](https://github.com/yjs/y-prosemirror/issues/113): Full-document replace on every remote change
- [updateYFragment accuracy discussion](https://discuss.yjs.dev/t/y-prosemirror-updateyfragment-algorithm-accuracy/1273): Known limitations
- [Yjs attributing-content.md](https://github.com/yjs/yjs/blob/main/attributing-content.md): Snapshot attribution API
- [Yjs GC and versioning discussion](https://discuss.yjs.dev/t/garbage-collection-and-version-snapshotting/1839): Production experience with `gc: false`
