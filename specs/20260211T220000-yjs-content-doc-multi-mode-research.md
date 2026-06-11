# Decision Record: Per-File Y.Doc Architecture for Multi-Mode Content Storage

**Status**: Decision Record: Option F Accepted
**Date**: 2026-02-11
**Related**: `specs/20260211T200000-yjs-filesystem-conformance-fixes.md`, `specs/20260208T000000-yjs-filesystem-spec.md`
**Implemented by**: `specs/20260211T230000-timeline-content-storage-implementation.md`

> Six architectural options were evaluated for supporting text, markdown, and binary content in per-file Yjs documents. **Option F (Y.Array timeline with nested shared types) was chosen.** This document preserves the full research, rationale, and comparative analysis.

---

## Problem Statement

Epicenter's Yjs filesystem currently stores text in `Y.Text('content')` per file, but binary files go to an ephemeral `Map<FileId, Uint8Array>` that **doesn't sync or persist**. This is asymmetrical: text gets full CRDT collaboration, binary gets nothing.

**Goal**: Support three content modes in a single per-file Y.Doc (`gc:false` for revision history):
1. **Text**: Character-level CRDT via `Y.Text` (for `.ts`, `.js`, `.txt`)
2. **Markdown**: `Y.XmlFragment` + `Y.Map` frontmatter (for `.md`): helpers exist, not wired in
3. **Binary**: `Uint8Array` via `ContentBinary` (for `.png`, `.sqlite`, compiled output)

**Requirements**:
- Binary data syncs and persists (not ephemeral)
- Reconstruct which content mode was active at any `Y.snapshot()` point
- Files can switch modes during a bash session (`echo "text" > f.dat` then `gzip f.dat`)
- Minimize tombstone/storage bloat with `gc:false`

---

## Chosen Architecture: Option F: Y.Array Timeline with Nested Shared Types

A single `Y.Array` IS the entire content history. Each entry is a `Y.Map` containing the content mode discriminant and a **nested shared type** appropriate for that mode. The nested `Y.Text` or `Y.XmlFragment` is a fully functional CRDT: bindable to editors, supporting character-level concurrent editing.

```
Y.Doc (guid = fileId, gc: false)
│
└── Y.Array('timeline')
    │
    ├── [0] Y.Map                              ← v0: plain text
    │   ├── 'type' → 'text'
    │   └── 'content' → Y.Text("hello world")  ← nested CRDT, bind to CodeMirror
    │
    ├── [1] Y.Map                              ← v1: markdown
    │   ├── 'type'        → 'richtext'
    │   ├── 'content'     → Y.XmlFragment(...)  ← nested CRDT, bind to ProseMirror
    │   └── 'frontmatter' → Y.Map({ title: 'My Post', tags: [...] })
    │
    ├── [2] Y.Map                              ← v2: binary
    │   ├── 'type'    → 'binary'
    │   └── 'content' → Uint8Array([0x89, 0x50, ...])  ← atomic
    │
    └── [3] Y.Map                              ← v3: back to text (CURRENT = last index)
        ├── 'type' → 'text'
        └── 'content' → Y.Text("updated")      ← BRAND NEW Y.Text, isolated history
```

### Entry structure (discriminated union)

All entries share one common key:
- `'type'`: `'text' | 'richtext' | 'binary'`: the discriminant

> **Note**: The `ts` field was originally proposed for MAX-timestamp current-version resolution but has been [superseded](#superseded-ts-field-is-unnecessary--last-index-is-sufficient). Current version is determined by last index position, which is O(1) and equally convergent.

All entries share a uniform `'content'` key for their primary payload (the type varies per mode). Variant-specific fields are named for their domain:

| Key | `text` | `richtext` | `binary` | Value Type |
|-----|--------|------------|----------|------------|
| `'content'` | Y.Text | Y.XmlFragment | Uint8Array | primary payload (type varies) |
| `'frontmatter'` |: | Y.Map |: | nested shared type |

### How reading works

```ts
function getCurrentEntry(timeline: Y.Array<Y.Map<any>>): Y.Map<any> {
  // Last index = current version. O(1), convergent across all clients.
  return timeline.get(timeline.length - 1)
}

function readFile(timeline): string | Uint8Array {
  const entry = getCurrentEntry(timeline)
  switch (entry.get('type')) {
    case 'text':     return entry.get('content').toString()
    case 'richtext': return serializeMarkdown(entry.get('content'), entry.get('frontmatter'))
    case 'binary':   return entry.get('content')
  }
}
```

### How writing works

```
SAME-MODE EDIT (common, no new array entry):
  Current entry [3]: { type:'text', content: Y.Text }
  User types "foo"
  → entry.get('content').insert(pos, 'foo')
  → Standard CRDT ops on nested Y.Text. Array unchanged.

MODE SWITCH (rare: appends new entry):
  doc.transact(() => {
    const entry = new Y.Map()
    entry.set('type', 'binary')
    entry.set('content', compressedBytes)
    timeline.push([entry])
  })
```

| Aspect | Detail |
|--------|--------|
| Text write (same mode) | Edit nested `Y.Text` directly. No array entry. Full CRDT. |
| Binary write (same mode) | **Append new entry** (binary is atomic: each write is a new version) |
| Mode switch | Append new `Y.Map` entry with fresh nested shared types |
| Current version | `timeline.get(timeline.length - 1)`: O(1) |
| Concurrent same-mode edit | Standard Yjs CRDT merge on the nested shared type |
| Concurrent mode switch | Both entries appear in array. Last index picks winner (clientID ordering). All clients converge. |
| Snapshot reconstruction | `Y.createDocFromSnapshot()` restores entire array. Last index at that point. |

### Why this avoids tombstones on mode switch

In Options A/D/E, switching text → binary → text requires **clearing** the single `Y.Text` (creating deletion tombstones for entire content), then rewriting:
```
Option A text→binary→text:
  Y.Text: "hello world"
  Y.Text: delete(0, 11)     ← tombstones for ENTIRE content
  Y.Text: insert(0, "new")  ← new content
  Dead weight: full original content as deletion tombstones
```

In Option F, the old `Y.Text` stays intact. A new version gets a fresh `Y.Text`:
```
Option F text→binary→text:
  [0] Y.Text: "hello world"   ← untouched, no tombstones created
  [1] binary: Uint8Array(...)
  [2] Y.Text: "new"           ← brand new, clean
  Dead weight: none (old content is "history", not tombstones)
```

With `gc:false`, you're keeping everything anyway. But there's a meaningful semantic difference between "preserved version history" (each entry is a self-contained version you could inspect or restore) and "useless deletion tombstones from clear-and-rewrite" (artifact of the single-shared-type approach).

### Why Option F was chosen over alternatives

| Question | Options That Solve It |
|----------|----------------------|
| Explicit, queryable transition history? | B, D, **F** (Y.Array log) |
| Conflict-safe concurrent type switching? | E (per-client proposals), B (MAX-ts on array), **F** (last-index: equally convergent, simpler) |
| Maximum simplicity? | A (single meta key) |
| No tombstones on mode switch? | **F only** (fresh nested types per version) |
| Minimal top-level key pollution? | **F** (single key: `'timeline'`) |
| Self-contained version records? | **F** (each array entry is a complete version with its own CRDT) |
| Timeline as file history? | **F** (the array IS the history: each entry is inspectable) |

Option F unifies content and metadata in each array entry: each entry is a **self-contained version record**. The Y.Array becomes a natural **version timeline** where the data structure mirrors the conceptual model. For a filesystem that tracks revision history (`gc:false`), this structural alignment is compelling.

The honest counterargument: Options A and D are simpler. If you never need to inspect past versions except through `Y.snapshot()`, the timeline approach adds complexity for a feature you don't use. The decision to accept this tradeoff is based on: (1) the timeline will be directly queryable for UI features, (2) snapshots are external blobs requiring separate storage and indexing, while the array is self-contained, and (3) the implementation complexity difference is small: encapsulated in a few helper functions.

### Known tradeoffs

1. **Slightly more complex access pattern.** `doc.getArray('timeline').get(n).get('content')` instead of `doc.getText('content')`. More indirection, but encapsulated in helpers.

2. **Editing wrong version after concurrent push.** If Client A is editing entry [2]'s `Y.Text` when Client B pushes entry [3], A's edits land in the stale version. Not lost: preserved in [2]'s history, but orphaned from "current." UI must observe the array and rebind. Window for this is network latency.

3. **Shared type overhead.** Each mode switch creates a new `Y.Text` or `Y.XmlFragment` (~100-200 bytes base overhead). A file that switches modes 50 times has 50 shared type instances = ~10KB. Negligible compared to actual content.

4. **Binary overwrites within binary mode.** Each binary write appends a new entry (unlike text, where edits are CRDT ops on the nested `Y.Text`). 10 writes of 1MB = 10 entries = 10MB. Same cost as Y.Map tombstones in other options, but semantically "version history" rather than "dead data."

### v14 Migration Path: Y.Type Structural Mapping

The timeline structure is orthogonal to Yjs version. When Yjs v14 ships (`Y.Type` replaces `Y.Map`, `Y.Text`, `Y.XmlFragment`, `Y.Array`), each timeline entry's internal types change but the **structure is identical**:

```
v13 (current)                        v14 (future)
─────────────────────────────        ─────────────────────────────
Y.Array('timeline')                  Y.Type('timeline')  [array-like]
└── Y.Map entry                      └── Y.Type entry
    ├── .get('type') → string            ├── .getAttr('type') → string
    ├── .get('content') → Y.Text /       ├── .getAttr('content') → Y.Type /
    │                    Y.XmlFrag /     │                        Uint8Array
    │                    Uint8Array      │
    └── .get('frontmatter') → Y.Map     └── .getAttr('frontmatter') → Y.Type
```

**Design decisions for v14 migration** (evaluated during Option F research):

1. **Content stays as a nested type, not promoted to entry's children.** v14 `Y.Type` can hold both attrs (metadata) and children (text content) on the same instance: meaning the entry itself could BE the text, eliminating the nested `content` type. This was rejected because:
   - Mixed observation: text edits and attr changes would fire on the same target, requiring event filtering to distinguish "user typed a character" from "mode switched"
   - Inconsistent access: some data via `getAttr()`, content via the entry directly
   - Uniform `entry.getAttr(key)` access for all fields is cleaner and matches v13's `entry.get(key)`

2. **Frontmatter stays as a nested type, not flat `fm:` prefixed attrs.** v14 supports storing frontmatter fields as prefixed attrs directly on the entry (`entry.setAttr('fm:title', ...)`, `entry.setAttr('fm:tags', ...)`). This was rejected because:
   - Requires manual filtering/iteration of `fm:*` attrs to extract frontmatter as an object
   - A nested Y.Type for frontmatter provides a clean API boundary: `entry.getAttr('frontmatter')` returns the whole thing
   - Per-key LWW is preserved either way (nested Y.Type attrs are independently LWW)

3. **Y.Type unifies text and richtext types.** In v14, the separate `Y.Text` vs `Y.XmlFragment` distinction collapses: a single `Y.Type` handles both plain text and formatted text (via `format()` for inline marks). The `type` discriminant distinguishes modes, but both use the uniform `content` key and resolve to the same underlying `Y.Type`.

4. **Attribution comes free.** v14's attribution system tracks who made what changes at the CRDT level. No changes to the timeline structure needed: attribution applies to any `Y.Type` content. This enables "AI wrote this paragraph" annotations, diff-based accept/reject, and contribution heatmaps without structural changes.

**Migration surface**: Swap type constructors in `timeline-helpers.ts` (`new Y.Map()` → `new Y.Type()`, `new Y.Text()` → `new Y.Type()`) and change `.get()` to `.getAttr()` in entry access. The helper API (`getCurrentEntry`, `readEntryAsString`, `pushTextEntry`, etc.) insulates all consumers from the change.

---

## Key Research Findings

### Yjs Binary Support
- `Y.Map.set(key, Uint8Array)` works natively: stored as `ContentBinary` (atomic, no split/merge)
- `Y.Array.push([Uint8Array])` also works: `Uint8Array` is a supported `Y.Array` value type
- With **gc:false**: each `Y.Map` key overwrite retains the FULL previous `Uint8Array` as a tombstone. Write 1MB 10 times = 10MB of dead data.
- `Y.Array` append-only entries have ~40-50 bytes overhead each. Old entries persist by design.

### Snapshots
- `Y.snapshot(ydoc)` captures ALL shared types (`Y.Text`, `Y.Map`, `Y.Array`, `Y.XmlFragment`) simultaneously
- `Y.createDocFromSnapshot(originDoc, snapshot)` restores exact state of all shared types at snapshot time
- Requires `gc:false` on the origin doc
- You CAN inspect `Y.Map` values, `Y.Text` content, and `Y.Array` entries from a reconstructed snapshot

### Yjs Nested Shared Types
- `Y.Map.set(key, new Y.Text())` works: the `Y.Text` becomes a fully functional nested shared type once the parent is integrated into the doc
- `Y.Array.push([ymap])` with a `Y.Map` containing nested `Y.Text`/`Y.XmlFragment`: all nested types are live and editable after push
- Editor bindings (`y-codemirror`, `y-prosemirror`) accept shared type **instances**, not key names: so they bind to nested types just fine
- **Constraint**: A shared type instance can only exist in one location. Cannot reuse the same `Y.Text` in two array entries.
- **Constraint**: Shared types cannot be moved once added to a document (Yjs fundamental rule)

### LearnYJS Findings (Gotchas That Apply)

From [learn.yjs.dev](https://learn.yjs.dev):

**Lesson 1: Use the right shared type for the data:**
- Primitives in `Y.Map` → LWW (last writer wins, concurrent writes lose data)
- `Y.Text` → character-level merge (both concurrent edits survive)
- Rule: Never store collaborative text as a string in `Y.Map`. Use `Y.Text`.

**Lesson 2: Don't have two clients write to the same key for additive values:**
- `read → modify → write` on a shared `Y.Map` key is broken under latency (classic lost-update problem)
- Solution: per-client key partitioning (G-Counter pattern). Each client writes to its own key, aggregate by iterating all values.
- Applies to our design: timeline entries are set once by one client at push time: no read-modify-write race.

**Lesson 3: Shared types can NEVER be moved:**
- "Move" in `Y.Array` = delete + insert. Yjs sees these as unrelated operations.
- Concurrent move causes **data loss** (delete destroys updated state) and **duplication** (both clients insert a "copy")
- Solution: don't move. Use property mutation (fractional indexing) instead of positional changes.
- Applies to our design: append-only timeline never moves entries. This is a feature, not a limitation.

**Lesson 2+3 combined: Y.Array concurrent push ordering:**
- When two clients push to the end of a `Y.Array` simultaneously, both entries appear
- Ordering is deterministic (by `clientID`: lower goes left, higher goes right)
- But **clientID is random**, so ordering is arbitrary from the application's perspective
- **"Last entry" ≠ "latest operation"**: array position reflects clientID ordering, not wall-clock time

### Y.Array Concurrent Push: The "Last Entry" Problem

This is the critical gotcha for any append-only log design:

```
Client A (clientID = 5):  pushes {type:'binary'}
Client B (clientID = 12): pushes {type:'text'}

After sync, Y.Array order: [entryA, entryB]
  entryB is "last" because clientID 12 > 5
  Both entries survive. "Last" is determined by clientID, not wall-clock time.

array.get(array.length - 1) → entryB (deterministic, all clients agree)
```

> **Superseded analysis**: The original version of this example included timestamps and labeled last-index as "WRONG" and MAX(ts) as "CORRECT." This was misleading: timestamps are equally arbitrary due to clock skew. Both approaches give convergence; neither gives a truly "correct" winner.

**When does this happen?** Only when two clients push within the same sync cycle (milliseconds on LAN, seconds on bad connection). For file mode switches (triggered by explicit user actions or bash commands), concurrent pushes are astronomically rare.

### Superseded: `ts` Field Is Unnecessary: Last Index Is Sufficient

The original analysis recommended a `ts` (timestamp) field as "cheap insurance" for resolving concurrent push ordering. On further examination, this recommendation is superseded. **Last index is the correct approach.**

The key insight: **timestamps don't actually give you a "correct" winner either.** Clock skew between machines is real: one device's clock could be seconds or minutes ahead. So a timestamp-based tiebreaker is just as arbitrary as Yjs's clientID-based array ordering. You're trading one form of arbitrary for another, while adding complexity.

| Approach | Convergence | "Correct" winner in concurrent case | Retrieval complexity |
|---|---|---|---|
| Last index | All clients agree | Arbitrary (clientID ordering) | `arr[arr.length - 1]`: O(1) |
| Max timestamp | All clients agree | Arbitrary (clock skew) | O(n) sweep through array |

Both approaches guarantee **convergence**: after sync, every client sees the exact same array in the exact same order, so every client picks the same winner. The only question is which tiebreaker resolves the astronomically rare concurrent push: clientID ordering (deterministic, free) or wall-clock timestamps (subject to clock skew, requires a sweep).

For this use case: mode switches triggered by explicit user actions or bash commands. The concurrent case requires two humans to independently switch the same file's content mode within the same sync window. This doesn't happen in practice. And even if it did, the "wrong" winner via clientID ordering is no more wrong than the "wrong" winner via a skewed clock.

**Decision**: Drop the `ts` field from timeline entries. Use `timeline.get(timeline.length - 1)` for current version. This simplifies the entry schema, eliminates the O(n) scan, and removes open question #8 (wall-clock vs logical clock) entirely.

See also: [Y.Array Append-Only Logs: Last Index vs Max Timestamp](../docs/articles/yarray-last-index-vs-max-timestamp.md)

### Context: Prior Implementation and Inspiration

**Current implementation** (being replaced): Per-file Y.Doc with `Y.Text('content')` for text, ephemeral `Map<FileId, Uint8Array>` for binary. No content-type metadata in the Y.Doc. Binary data lost on restart.

**JustBash model**: Stores everything as `Uint8Array` internally. `IFileSystem` is type-agnostic: `writeFile` accepts both string and `Uint8Array`.

**HeadDoc pattern** (inspiration for Option E): Per-client MAX aggregation for safe concurrent epoch bumps. Each client writes to their own key, eliminating LWW conflicts. The global value is derived by aggregation.

---

## Storage Cost Comparison (gc:false)

Scenario: File starts as text (10KB), edited 50 times, converted to binary (1MB), updated 5 times, back to text.

| Component | Option A | Option B | Option D | Option E | **Option F** |
|-----------|----------|----------|----------|----------|----------|
| Text edits (50 char-level) | ~25KB | ~25KB | ~25KB | ~25KB | ~25KB |
| Binary overwrites (5 x 1MB) | 5MB (Y.Map tombstones) | 5MB (5 array entries) | 5MB (Y.Map tombstones) | 5MB (Y.Map tombstones) | 5MB (5 array entries) |
| Type transitions metadata | ~240B | ~150B | ~150B | ~200B | ~200B |
| Mode-switch tombstones | ~20KB (clear Y.Text + rewrite) | ~20KB | ~20KB | ~20KB | **0** (no clear needed) |
| Shared type overhead | 1 per type (fixed) | 1 per type (fixed) | 1 per type (fixed) | 1 per type (fixed) | 1 per version (~400B for 2 switches) |
| **Total** | **~5.05MB** | **~5.05MB** | **~5.05MB** | **~5.05MB** | **~5.03MB** |

**The binary data cost is inherent with gc:false regardless of structure.** The difference between options is:
- **Semantic**: tombstones (dead data from overwrites) vs. history entries (queryable version records)
- **Mode-switch tombstones**: Options A. E clear-and-rewrite shared types on mode switch, creating deletion tombstones. Option F creates fresh shared types: no deletion tombstones at all.

### What "No Tombstones on Mode Switch" Actually Means

**Options A. E (clear-and-rewrite):**
```
text→binary→text lifecycle of Y.Text('content'):
  1. Y.Text created, 50 edits accumulated (25KB of ops)
  2. Mode switch to binary: Y.Text.delete(0, length) → deletion tombstones
  3. Mode switch back to text: Y.Text.insert(0, newContent) → new ops
  Result: Y.Text contains 25KB of original ops + deletion tombstones + new ops
          The original text is unrecoverable as structured data (it's in tombstones)
```

**Option F (fresh types per version):**
```
text→binary→text lifecycle:
  [0] Y.Text: 50 edits accumulated (25KB of ops): INTACT, inspectable
  [1] binary entry: Uint8Array
  [2] Y.Text: new content, fresh ops: CLEAN
  Result: Each version is a self-contained record. v0's edit history is fully preserved.
          You could bind an editor to v0 and see the original text.
```

---

## Alternatives Considered

### Option A: Reserved Keys + Active Type Marker

```
Y.Doc (guid = fileId, gc: false)
├── Y.Map('meta')           → { activeType: 'text' | 'markdown' | 'binary' }
├── Y.Text('content')       → text (active when type='text')
├── Y.XmlFragment('richtext') → ProseMirror tree (active when type='markdown')
├── Y.Map('frontmatter')    → YAML fields (active when type='markdown')
└── Y.Map('binary')         → { content: Uint8Array } (active when type='binary')
```

Simplest approach: read `meta.activeType`, dispatch to the correct shared type. One key read to determine type. Matches the superseded content-format-spec pattern.

**Not chosen because**: No explicit transition history. Binary tombstone accumulation (each overwrite retains full `Uint8Array`). Mode switches create deletion tombstones when clearing shared types. Concurrent type switches resolved by arbitrary LWW.

### Option B: Y.Array Transition Log (Binary Inline)

```
Y.Doc (guid = fileId, gc: false)
├── Y.Text('content')           → text
├── Y.XmlFragment('richtext')   → ProseMirror tree
├── Y.Map('frontmatter')        → YAML fields
└── Y.Array('transitions')      → append-only log:
     [{ type: 'text' }, { type: 'binary', data: Uint8Array([...]) }, ...]
```

Active type = last entry in transitions array. Binary data stored inline in array entries. Text/markdown content stays in top-level shared types.

**Not chosen because**: Still uses top-level shared types (tombstones on mode switch). Binary data inline works but content is split between the array (binary) and top-level keys (text/richtext). "Last entry" ambiguity with concurrent appends originally required MAX-ts resolution.

**Variant B2**: Same as B but binary data in `Y.Map('binary')`. Fewer array entries, but reintroduces Y.Map binary tombstone problem.

### Option C: Everything in Y.Array (Unified Content Log): ELIMINATED

```
Y.Doc (guid = fileId, gc: false)
└── Y.Array('content')
     [{ v: 1, type: 'text', data: 'console.log("hi")' }, ...]
```

**Eliminated**: gives up character-level CRDT entirely. Cannot bind CodeMirror/ProseMirror. Every text edit stores the full file content as a new entry. Defeats the core value proposition of Yjs.

### Option D: Y.Array Transitions (Mode Switches Only) + Dedicated Storage

```
Y.Doc (guid = fileId, gc: false)
├── Y.Text('content')          → text
├── Y.XmlFragment('richtext')  → markdown body
├── Y.Map('frontmatter')       → markdown metadata
├── Y.Map('binary')            → { content: Uint8Array }
└── Y.Array('transitions')     → metadata only: [{ type, size }]
```

Transition entries only appended on mode switch. Within a mode, edits go directly to the dedicated shared type. Lightweight log.

**Not chosen because**: Binary tombstone accumulation in `Y.Map` (same as Option A). Two sources of truth for binary history (tombstones in Y.Map + transitions in array). Still creates deletion tombstones on mode switch for text/richtext shared types.

### Option E: HeadDoc-Inspired Per-Client Type Proposals

```
Y.Doc (guid = fileId, gc: false)
├── Y.Text('content')
├── Y.XmlFragment('richtext')
├── Y.Map('frontmatter')
├── Y.Map('binary')            → { content: Uint8Array }
└── Y.Map('activeType')        → per-client proposals:
     { 'client-123': { type: 'text', ts: ... }, 'client-456': { type: 'binary', ts: ... } }
```

Active type = proposal with highest `ts` (MAX aggregation, same as HeadDoc epochs). Each client writes to own key, no LWW conflicts.

**Not chosen because**: No transition history. Accumulates one entry per client that ever touched the file. Overkill: concurrent type switches on the same file are astronomically rare in practice. Same tombstone problems as A/D for the top-level shared types.

---

## Open Questions

5. **Markdown vs text: extension-based or explicit type marker?** Extension-based: rename `.txt` → `.md` triggers type change. Marker-based: type stored in the entry's `type` field, independent of filename. The `type` field in Option F entries is explicit, but what triggers setting it? Could be: (a) always infer from file extension at write time, (b) user/editor explicitly sets the mode, (c) content detection heuristic.

6. **`readFileBuffer(path)` return type**: Needs to return `Uint8Array`. For binary: zero-copy from entry's `data`. For text: `TextEncoder.encode(ytext.toString())`. For richtext: serialize markdown then encode. This is straightforward but the serialization path for richtext needs the existing markdown helpers wired in.

7. **Binary overwrite: new entry or mutate existing?** When a file stays in binary mode and gets overwritten, should we: (a) append a new array entry (full version history, array grows), or (b) update the existing entry's `data` field (in-place overwrite, previous value becomes a Y.Map tombstone within the entry)? Option (a) gives explicit binary version history. Option (b) keeps the array shorter but loses the "each entry is a version" property for binary-only overwrites. Leaning toward (a) for consistency.

9. **How does the UI observe mode changes?** When a new entry is pushed to the timeline (mode switch), the editor needs to: detect the change (observe the array), get the new current entry (last index), unbind from the old shared type, and bind to the new one. What's the observation pattern? `timeline.observe(event => { ... })` watching for insert events at the tail.

10. **What about very large binary files?** A 100MB binary file overwritten 10 times = 1GB in the Y.Doc. With `gc:false`, this is unavoidable in any option. Should there be a size threshold where binary content is stored outside the Y.Doc (e.g., in a separate blob store with only a hash/reference in the entry)?

---

## Spec Lineage and Cross-References

Option F touches a chain of prior specs about content storage format. This section maps the full lineage so an implementing agent can navigate the history.

### Specs that Option F supersedes

| Spec | Current Status | How Option F changes it |
|------|---------------|------------------------|
| `specs/20260211T100000-simplified-ytext-content-store.md` | **Implemented** | The most important one. Option F replaces the single `Y.Text('content')` key with a timeline array of nested shared types. The ephemeral `Map<FileId, Uint8Array>` binary store is replaced by persistent binary entries in the timeline. The "Future Evolution" section of that spec anticipated lenses, persistent binary, and content metadata: Option F addresses all three via the timeline approach. |
| `specs/20260210T120000-content-format-spec.md` | Superseded (by simplified spec) | Already superseded, but Option F provides an alternative path. The format-as-metadata colocation idea survives: each timeline entry's `type` field IS the format, embedded inside the content Y.Doc. But no `FormatRegistry`, no healing, no stale keys. |
| `specs/20260210T000000-content-lens-spec.md` | Superseded (by simplified spec) | The lens concept (bidirectional converters, registry, namespaced keys) is unnecessary under Option F. Each timeline entry is self-contained with its own typed content. Type dispatch is a simple `switch` on the entry's `type` field, not a registry lookup. |

### Specs that Option F sidesteps or makes moot

| Spec | Current Status | How Option F relates |
|------|---------------|---------------------|
| `specs/20260210T150000-content-storage-format-debate.md` | Acknowledged | Recommended markdown-as-text (Option A). Option F makes the debate moot: it supports text (`Y.Text`), richtext (`Y.XmlFragment`), AND binary (`Uint8Array`) in the same timeline. You can have both the Obsidian model and the Google Docs model, per-file, switching at runtime. |
| `specs/20260210T220000-v14-content-storage-spec.md` | Deferred | Designed for Yjs v14 (`Y.Type`, `fm:` attrs, attribution). Option F is v13-compatible with a 1:1 structural mapping to v14 (see [v14 Migration Path](#v14-migration-path-ytype-structural-mapping)). The v14 spec's flat `fm:` attr approach for frontmatter was evaluated and rejected in favor of a nested frontmatter type for cleaner API boundaries. The v14 spec's single-key `Y.Type('content')` approach doesn't support the timeline's lifecycle history: Option F's timeline structure is preserved under v14, with `Y.Type` replacing each `Y.Map`/`Y.Text`/`Y.XmlFragment` instance. |
| `specs/20260210T000000-mv-in-place-migration.md` | Superseded (by simplified spec) | Already superseded. Under Option F, `mv()` remains metadata-only (same as the simplified spec). No content migration on rename. |

### Specs that remain valid under Option F

| Spec | Why it's unaffected |
|------|-------------------|
| `specs/20260208T000000-yjs-filesystem-spec.md` | Two-layer architecture (flat metadata table + per-file content docs), files table schema, runtime indexes, `IFileSystem` interface: all unchanged. Only the content doc internal structure changes. |
| `specs/20260211T200000-yjs-filesystem-conformance-fixes.md` | `IFileSystem` behavioral fixes. Orthogonal to content storage format. |
| `specs/20260209T000000-simplify-content-doc-lifecycle.md` | `ContentDocStore` (`ensure`/`destroy`/`destroyAll`) is unchanged. Option F changes what's inside the Y.Doc, not how the Y.Doc lifecycle is managed. |
| `specs/20260209T120000-branded-file-ids.md` | `FileId` branding is unchanged. |

### Reference documents (not specs)

- `docs/articles/archived-head-registry-patterns.md`: HeadDoc per-client MAX pattern (inspiration for Option E)
- `docs/articles/y-array-tombstones-are-tiny.md`: Y.Array tombstone analysis
- `docs/articles/ykeyvalue-gc-the-hidden-variable.md`: gc:false storage implications

## Files to Modify (When Implementing)

- `packages/epicenter/src/filesystem/yjs-file-system.ts`: Core: add type dispatch to readFile/writeFile
- `packages/epicenter/src/filesystem/types.ts`: Add ContentType union, update interfaces
- `packages/epicenter/src/filesystem/markdown-helpers.ts`: Wire into writeFile/readFile for markdown mode
- `packages/epicenter/src/filesystem/content-doc-store.ts`: May need type-aware helpers
- `packages/epicenter/src/filesystem/yjs-file-system.test.ts`: Tests for binary persistence, type switching, concurrent edits
