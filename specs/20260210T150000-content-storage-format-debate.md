# Content Storage Format: Markdown vs Tree vs Hybrid

**Date**: 2026-02-10
**Status**: Acknowledged
**Acknowledged by**: `specs/20260211T100000-simplified-ytext-content-store.md` (further superseded by `specs/20260211T230000-timeline-content-storage-implementation.md`): implements this spec's recommendation (markdown-as-text source of truth) with v13 Yjs. v14 migration deferred.
**Supersedes**: Nothing. This is an architectural decision document that informs the content-format-spec, not replaces it.
**See also**: `specs/20260211T220000-yjs-content-doc-multi-mode-research.md`: Option F makes the text-vs-tree debate less decisive: the timeline supports both `Y.Text` (text mode) and `Y.XmlFragment` (richtext mode) per-file, switchable at runtime. You can have the Obsidian model AND the Google Docs model.

---

## Overview

Every file in Epicenter is a Yjs CRDT document. The question: what shape should that CRDT take? The answer determines which editors get native collaborative binding and which get serialization at the boundary. This document compares three storage formats for Yjs v14 and recommends one.

## Motivation

### Current State

Today (v13), markdown files use a tree CRDT and text files use a text CRDT:

```
Y.Doc (per file)
├── Y.Text('text')           ← code/plain text files
├── Y.XmlFragment('richtext') ← markdown files (ProseMirror tree)
└── Y.Map('frontmatter')      ← markdown YAML metadata
```

The file extension determines which keys are active. Renaming triggers content migration. A healing system detects mismatches when metadata syncs before content.

### Problems

1. Two different CRDT structures for "text with formatting" means two code paths for every operation.
2. The bash agent (just-bash) calls `writeFile()` which replaces the entire CRDT content. When the CRDT is a tree, this parses markdown into a ProseMirror AST, then replaces all tree nodes. Any concurrent WYSIWYG edits are destroyed.
3. Extension-based format detection creates race conditions, healing complexity, and surprising rename behavior. (The content-format-spec already solves this with colocated metadata.)

### Desired State

A single storage format where:
- `readFile()` returns markdown (or plain text). Always.
- `writeFile(markdown)` can be applied as a diff, merging with concurrent edits from any editor.
- WYSIWYG editors, code editors, and bash agents all collaborate on the same CRDT without fighting.
- v14's unified `Y.Type` replaces the zoo of v13 shared types.

---

## Yjs v14 Primitives

v14 replaces six shared types (`Y.Text`, `Y.Map`, `Y.Array`, `Y.XmlFragment`, `Y.XmlElement`, `Y.XmlText`) with one: `Y.Type`.

Every `Y.Type` instance simultaneously has:
- **Attributes** (`setAttr`/`getAttr`): key-value pairs, like Y.Map
- **Children** (`insert`/`get`): ordered list of text, objects, or nested Y.Type instances, like Y.Array
- **Formatting** (`format`): inline marks on text runs (bold, italic), like Y.Text

```js
const content = doc.get('content')         // returns Y.Type
content.setAttr('format', 'markdown')      // map-like
content.insert(0, '# Hello\n\n**bold**')   // text-like
content.format(14, 4, { bold: true })      // formatting marks
```

One type does everything. The `name` property distinguishes "fragment-like" (`null`) from "element-like" (`'p'`, `'heading'`, etc.).

Package rename: `yjs` becomes `@y/y`. Editor bindings: `@y/prosemirror` (active), `@y/codemirror` (active). Both target v14.

---

## The Three Options

### Option A: Markdown Text as Source of Truth

The CRDT stores the document as a markdown string. Editors that want rich rendering parse it locally.

```
Y.Type('content')
├── attrs: { format: 'markdown', frontmatter: { title: 'My Doc' } }
└── text: '# Hello\n\nThis is **bold** text.\n'
```

Consumers:
- CodeMirror binds directly to the Y.Type text via `@y/codemirror`. Character-level collaborative editing.
- WYSIWYG (ProseMirror/Milkdown) parses the text into a local ProseMirror tree, renders it, serializes changes back as markdown diffs applied to the Y.Type text.
- Bash agent reads `ytype.toString()`, writes via diff against current text (insert/delete ops).

This is the Obsidian model. The markdown string is truth. Rich rendering is a view.

### Option B: Tree as Source of Truth

The CRDT stores a ProseMirror-compatible node tree. Editors that want text serialize it.

```
Y.Type('content')
├── attrs: { format: 'markdown', frontmatter: { title: 'My Doc' } }
├── Y.Type('heading') { level: 1 } → text: 'Hello'
└── Y.Type('paragraph') → text: 'This is ' + 'bold'{bold:true} + ' text.'
```

Consumers:
- ProseMirror/TipTap binds directly to the Y.Type tree via `@y/prosemirror`. Structural collaborative editing.
- CodeMirror gets a read-only or toggle view: serialize tree to markdown, display in CodeMirror.
- Bash agent serializes tree to markdown for `readFile()`, parses markdown and replaces entire tree for `writeFile()`.

This is the Google Docs model. The tree is truth. Text export is derived.

### Option C: Text with CRDT-Level Formatting Marks

The CRDT stores text with inline formatting as CRDT operations, but block structure stays as markdown syntax.

```
Y.Type('content')
├── attrs: { format: 'markdown' }
└── text: '# Hello\n\n' + 'This is ' + 'bold'{bold:true} + ' text.\n'
```

A hybrid: inline formatting (bold, italic, links) lives at the CRDT level. Block structure (headings via `#`, lists via `-`, blockquotes via `>`) lives in the text as markdown syntax.

Consumers:
- No existing editor binds to this shape natively. ProseMirror needs a tree. CodeMirror needs plain text. You'd build a custom rendering layer or a complex adapter.

---

## Comparison

### Fidelity

How faithfully the storage represents each consumer's needs.

| Dimension | A: Markdown text | B: Tree | C: Hybrid |
|---|---|---|---|
| Storage fidelity vs markdown | Equal. It IS markdown. | Higher. Tree can represent things markdown can't (custom nodes, annotations). | Between the two. Inline marks are richer, blocks are markdown. |
| Bash output fidelity | Perfect. `toString()` returns what's stored. | Lossy. Tree serializes to one of many valid markdown representations. `*bold*` vs `**bold**` normalized away. | Near-perfect for blocks, lossy for inline (marks must serialize to markdown syntax). |
| WYSIWYG fidelity | Derived. Parse markdown on render, re-parse on every remote change. | Perfect. Editor binds directly to the CRDT tree. | Neither. No editor binds to this shape natively. |
| Frontmatter fidelity | Stored as attrs on the Y.Type. Per-key LWW. Equal for both. | Same. | Same. |

### Concurrent Editing

What happens when two consumers edit the same document simultaneously.

| Scenario | A: Markdown text | B: Tree | C: Hybrid |
|---|---|---|---|
| Two WYSIWYG users | Changes go through text layer. Merges at character level. Works, but can cause re-parse jitter on remote changes. | Native structural merge. ProseMirror ops compose cleanly. Best possible WYSIWYG collab. | Inline marks merge at CRDT level, block changes merge as text. Untested territory. |
| Two CodeMirror users | Native character-level merge via `@y/codemirror`. Best possible text collab. | Both serialize tree to markdown... then what? Two peers can't collaboratively edit a derived view. One peer's CodeMirror, the other's tree. | Character-level merge for text, but formatting marks create complexity. |
| Bash + WYSIWYG | Bash applies text diffs. WYSIWYG applies text diffs. Both merge at character level in the CRDT. Works. | Bash replaces entire tree (parse markdown, replace all nodes). Destroys concurrent WYSIWYG edits. | Bash applies text diffs, but formatting marks may conflict with text changes. Unclear behavior. |
| Bash + CodeMirror | Both edit the same Y.Type text. Native character-level merge. Perfect. | Bash replaces tree. CodeMirror is a derived view. Not meaningfully concurrent. | Same concerns as bash + WYSIWYG. |
| Two bash agents | Both apply text diffs. Character-level merge. Works. | Both replace entire tree. Last writer wins. | Text diffs merge, formatting marks may conflict. |

### Complexity

What you have to build and maintain.

| Dimension | A: Markdown text | B: Tree | C: Hybrid |
|---|---|---|---|
| Editor binding | CodeMirror: native via `@y/codemirror`. WYSIWYG: custom binding (markdown ↔ ProseMirror adapter, diff-based sync). Milkdown POC already proves this. | ProseMirror: native via `@y/prosemirror`. CodeMirror: read-only derived view or toggled mode. | Custom everything. No existing binding supports this shape. |
| `readFile()` implementation | `ytype.toString()`. One line. | Serialize tree to markdown via `prosemirror-markdown`. Headless, DOM-free, but non-trivial. | Serialize text + strip CRDT formatting marks. Custom serializer needed. |
| `writeFile()` implementation | Diff current text vs new text, apply as Y.Type insert/delete ops. The diff library already exists in the codebase. | Parse markdown to ProseMirror AST, replace entire tree. Or attempt tree diffing (unsolved at CRDT level). | Diff text + re-apply formatting marks from parsed markdown. Very complex. |
| Lens architecture | Simpler. Text and markdown lenses have the same CRDT shape (Y.Type with text). Difference is only in `format` attr and how editors render. | Current spec's approach. Two distinct CRDT structures (text-only vs tree). Separate namespaced keys. | New CRDT shape that nothing supports. Maximum implementation risk. |
| Ecosystem maturity | `@y/codemirror` exists for v14. Milkdown/ProseMirror-over-text is proven in the POC. | `@y/prosemirror` exists for v14. Well-trodden path for WYSIWYG collab. | No ecosystem support. You're on your own. |

### What Each Option Optimizes For

| Option | Optimized for | Sacrifices |
|---|---|---|
| A: Markdown text | Bash editability. Text editor collab. Simple architecture. Multi-editor concurrency. | WYSIWYG collab quality (jitter on re-parse). Custom node types (limited to what markdown can express). |
| B: Tree | WYSIWYG collab quality. Rich custom nodes. Structural editing. | Bash concurrency (full tree replacement). Round-trip fidelity (markdown normalization). Architecture simplicity (two CRDT shapes). |
| C: Hybrid | Theoretical inline formatting fidelity. | Everything practical. No editor bindings. No ecosystem support. Maximum build effort for unclear benefit. |

---

## Deep Dive: The Concurrency Problem

This is the crux of the decision, so it deserves its own section.

### Why Tree-as-Truth Breaks Bash Concurrency

When a bash agent calls `writeFile('/doc.md', newMarkdown)`:

1. Parse `newMarkdown` into a ProseMirror AST
2. Replace the entire Y.Type tree with the new AST's nodes

Step 2 is a wholesale replacement. It deletes all existing children and inserts new ones. If a WYSIWYG user added a paragraph between steps 1 and 2, that paragraph is gone.

You might think: "just diff the old tree against the new tree and apply surgical operations." But tree diffing for ProseMirror nodes at the CRDT level is an unsolved problem. You'd need to:
- Match old nodes to new nodes by content similarity (not identity; the AST is freshly parsed)
- Determine which nodes were added, removed, or modified
- Express those changes as Y.Type operations (insert child, delete child, modify text within child)
- Handle reordering, nesting changes, and formatting changes

This is a research project, not an engineering task.

### Why Markdown-as-Truth Preserves Bash Concurrency

When a bash agent calls `writeFile('/doc.md', newMarkdown)`:

1. Get current text: `currentText = ytype.toString()`
2. Compute diff: `patches = diff(currentText, newMarkdown)`
3. Apply as Y.Type ops: for each patch, `ytype.delete(pos, len)` and `ytype.insert(pos, text)`

These are character-level operations on the same Y.Type that CodeMirror and the WYSIWYG adapter also use. Yjs merges them. If a WYSIWYG user added a paragraph (which the adapter serialized as a text insertion), the bash agent's diff and the WYSIWYG user's insertion merge at the character level.

It's not perfect. Two edits to the same line can produce garbled markdown. But this is the same class of conflict that any collaborative text editor handles, and Yjs is specifically designed for it.

### The Fundamental Asymmetry

Text diffs compose. Tree replacements don't.

A character-level diff says "insert these characters at position 47, delete 12 characters at position 83." Two such diffs from different peers can be merged by Yjs's CRDT algorithm because positions are tracked as relative offsets between items.

A tree replacement says "delete everything, insert this new tree." There's nothing to merge. It's a scorched-earth operation.

This asymmetry is why markdown-as-truth enables concurrency and tree-as-truth doesn't, specifically for the bash agent use case.

---

## Deep Dive: WYSIWYG Quality Tradeoff

Markdown-as-truth isn't free. The WYSIWYG experience takes a hit.

### The Re-Parse Problem

When a remote peer changes the text (bash agent or another CodeMirror user), the WYSIWYG editor must:

1. Receive the Y.Type text change event
2. Re-parse the full markdown (or the changed region) into a ProseMirror AST
3. Diff the new AST against the current ProseMirror state
4. Apply ProseMirror transactions to update the view

This can cause:
- Cursor position shifts if the re-parse changes the document structure around the cursor
- Brief flicker if the diff produces a replace-then-insert instead of a clean update
- Loss of transient editor state (selection, undo history for the ProseMirror layer)

The Milkdown POC handles this with counter-based loop prevention and character-level diffs. It works. But it's not as smooth as native ProseMirror collab where changes arrive as structural operations that ProseMirror can apply incrementally.

### When This Matters

- Two users both in WYSIWYG mode, editing the same paragraph simultaneously: tree-as-truth is noticeably better. Characters interleave correctly, cursors track, no re-parse.
- One user in WYSIWYG, another in CodeMirror or bash: markdown-as-truth is better because both editors operate on the same text CRDT.
- Single user switching between views: no difference. Both approaches handle this fine.

### The Honest Assessment

If your primary use case is "multiple humans in WYSIWYG editing a rich document together" (Google Docs / Notion), tree-as-truth is the right answer and the entire industry agrees.

If your primary use case is "bash agents and humans collaborating on markdown files with optional rich rendering" (your case), markdown-as-truth is the right answer because the concurrency win outweighs the WYSIWYG quality loss.

---

## Deep Dive: What v14 Changes

### Before (v13)

Markdown-as-truth required:
- `Y.Text('text:content')` for the markdown string
- `Y.Map('meta')` for format metadata
- `Y.Map('md:frontmatter')` for YAML front matter
- Three separate shared types, three keys in the Y.Doc

Tree-as-truth required:
- `Y.XmlFragment('md:content')` for the ProseMirror tree
- `Y.Map('meta')` for format metadata
- `Y.Map('md:frontmatter')` for YAML front matter
- Three separate shared types, three keys in the Y.Doc

### After (v14)

Markdown-as-truth:
```js
const content = doc.get('content')
content.setAttr('format', 'markdown')
content.setAttr('frontmatter', { title: 'My Doc', tags: ['a', 'b'] })
content.insert(0, '# Hello\n\nThis is **bold** text.')
```

One Y.Type. Attrs for metadata. Text for content. Single node.

Tree-as-truth:
```js
const content = doc.get('content')
content.setAttr('format', 'markdown')
content.setAttr('frontmatter', { title: 'My Doc', tags: ['a', 'b'] })

const heading = Y.Type.from(delta.create('heading').setAttr('level', 1).insert('Hello'))
const para = Y.Type.from(delta.create('paragraph').insert('This is ').insert('bold', { bold: true }).insert(' text.'))
content.insert(0, [heading, para])
```

One root Y.Type with children. Still one node for metadata, but children for content.

### What v14 Actually Changes About the Decision

Not much, honestly. The CRDT constraint (two types can't be bidirectionally synced) is unchanged. The concurrency asymmetry (text diffs compose, tree replacements don't) is unchanged.

What v14 does give you:
- Cleaner API. One type instead of six.
- Metadata and content on the same node (attrs + children/text).
- The tree option is more natural (`Y.Type` with named children instead of `Y.XmlFragment` with `Y.XmlElement`).
- Attribution system (who wrote what) built in. Works with both approaches.

v14 makes either option nicer to implement. It doesn't change which option is right.

---

## Impact on the Content-Format-Spec

The current content-format-spec uses tree-as-truth for markdown (Y.XmlFragment) and text for everything else (Y.Text). Here's how each option would change it.

### If Option A (Markdown Text)

The lens distinction between text and markdown **nearly disappears**:

```
// Current spec: two CRDT shapes
text lens  → Y.Text('text:content')
md lens    → Y.XmlFragment('md:content') + Y.Map('md:frontmatter')

// Option A with v14: one CRDT shape
all files  → Y.Type('content') with text + attrs
```

Both text and markdown files store their content as text in a Y.Type. The `format` attr tells editors whether to render plain or rich. The `frontmatter` attr holds YAML metadata (only meaningful when format is markdown).

The `ContentLens` interface simplifies:
- `toString()` is always `ytype.toString()` (maybe with frontmatter prepended for markdown)
- `fromString()` is always diff-based text update (maybe with frontmatter extraction for markdown)
- `open()` returns handles for editor binding: CodeMirror handle or WYSIWYG-adapter handle, depending on what the editor requests

`convertFormat()` becomes simpler too: changing format is just `content.setAttr('format', newFormat)`. The text doesn't change. The editor re-renders with a different view. No content migration needed for text ↔ markdown.

### If Option B (Tree)

The spec stays roughly as-is, ported to v14 types:

```
// v14 port of current spec
text lens  → Y.Type('content') with text
md lens    → Y.Type('content') with children (heading, paragraph, etc.) + attrs for frontmatter
```

Two distinct CRDT shapes. `convertFormat()` must serialize and re-parse (current spec's design). Stale keys after conversion.

### If Option C (Hybrid)

New CRDT shape that the spec doesn't account for. Would require significant spec rewrite and new serialization logic.

---

## Recommendation

Option A: markdown text as source of truth.

The reasoning:

1. Bash editability is the stated #1 priority. Option A makes it native. Option B makes it lossy and destructive to concurrent edits.

2. The concurrency model works. Text diffs compose at the CRDT level. The Milkdown POC already proves the WYSIWYG-over-text pattern.

3. v14 makes the architecture cleaner. One Y.Type per file, attrs for metadata, text for content. The content-format-spec simplifies.

4. The fidelity math works out. Storage equals markdown. No information loss on read or write. WYSIWYG fidelity is "good enough" for the use case (developers editing markdown, not publishers doing layout).

5. Option C is too risky. No ecosystem support, no editor bindings, maximum implementation effort for unclear benefit.

The main thing you give up: WYSIWYG collab quality when two humans edit the same paragraph simultaneously. If that becomes a real problem, you can explore a hybrid approach later (e.g., short-lived tree mode when multiple cursors are in the same block). But solve the bash concurrency problem first. That's the harder constraint.

---

## Open Questions

1. **Frontmatter: attrs or text?**
   - Option (a): Store frontmatter as Y.Type attrs (`content.setAttr('frontmatter', {...})`). Per-key LWW via attrs. Clean separation.
   - Option (b): Store frontmatter in the markdown text (`---\ntitle: My Doc\n---\n`). Simpler; the entire file is one text blob. But frontmatter edits are text diffs, not key-value operations.
   - Recommendation: Attrs. Frontmatter fields are independent key-value pairs. LWW per key is correct. Two users editing different frontmatter fields shouldn't conflict.

2. **WYSIWYG adapter: build or adopt?**
   - The Milkdown POC proves the pattern. But Milkdown is a specific framework. Should the adapter be Milkdown-specific or a generic "ProseMirror over Y.Type text" binding?
   - Recommendation: Defer. Start with the Milkdown POC approach. Extract a generic adapter if a second editor needs it.

3. **Diff granularity for writeFile**
   - Character-level diff (current POC approach) vs line-level diff. Character diffs produce more precise Y.Type operations but are more expensive to compute.
   - Recommendation: Character-level. The `diff` package is fast enough for documents under 100KB. Line-level can miss intra-line changes from concurrent editors.

4. **Do we still need two lenses (text vs markdown)?**
   - With markdown-as-truth, both text and markdown files are stored as text in Y.Type. The only difference is the `format` attr and how editors render.
   - Maybe one lens with format-aware rendering, instead of two lenses with the same CRDT shape?
   - Recommendation: Keep two lenses. Even though the CRDT shape is the same, `toString()` and `fromString()` differ (markdown lens handles frontmatter extraction/serialization). The lens abstraction is still useful for routing.

5. **v14 stability: is it ready?**
   - v14 is pre-release (`v14.0.0-22`). The API is labeled `@beta`. Editor bindings exist but are also pre-release.
   - Recommendation: Build against v14 now. The unified Y.Type is the future. Pin to a specific pre-release version and track breaking changes. The v13-to-v14 migration will only get harder if you build more on v13.

---

## References

- `specs/20260210T120000-content-format-spec.md`: Current content format spec (tree-as-truth for markdown). Lens interface, format registry, and `convertFormat()` design are reusable regardless of this decision.
- `apps/ytext-editor-poc/src/lib/ytext-milkdown-binding.ts`: Working proof of concept for WYSIWYG-over-text pattern with diff-based sync.
- `packages/epicenter/src/filesystem/markdown-helpers.ts`: Headless ProseMirror ↔ markdown serialization. DOM-free. Reusable with either approach.
- `packages/epicenter/src/filesystem/content-doc-store.ts`: Y.Doc lifecycle management. Unchanged by this decision.
- `packages/epicenter/src/filesystem/yjs-file-system.ts`: Main filesystem implementation. `readFile()`, `writeFile()`, `mv()` changes depend on this decision.
- `@y/y` (v14.0.0-22): Unified Y.Type API. `doc.get()`, `setAttr()`, `insert()`, `format()`.
- `@y/prosemirror` (2.0.0-2): ProseMirror binding for v14.
- `@y/codemirror` (0.0.0-3): CodeMirror binding for v14.
