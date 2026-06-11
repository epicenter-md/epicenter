# In-Place Content Migration for Type-Changing Renames

**Date**: 2026-02-10
**Status**: Superseded
**Superseded by**: `specs/20260211T100000-simplified-ytext-content-store.md` (further superseded by `specs/20260211T230000-timeline-content-storage-implementation.md`): `mv()` is now always metadata-only. No content migration at all (no extension categories, no format conversion). This spec's in-place migration is unnecessary because all files use `Y.Text('content')`.
**Author**: AI-assisted
**Supersedes**: The `mv` type-changing rename section of `specs/20260208T000000-yjs-filesystem-spec.md` (lines 517-545)
**See also**: `specs/20260211T220000-yjs-content-doc-multi-mode-research.md`: Under Option F, `mv()` remains metadata-only (same as simplified spec). Mode switches happen via timeline entry appends, not renames.

## Overview

Replace the destroy-and-recreate pattern in `mv()` with in-place content migration via `convertContentType()`. When a file is renamed across extension categories (e.g., `.txt` to `.md`), the Y.Doc stays alive and content is migrated between keys within the same document.

## Motivation

### Current State

When `mv()` detects a type-changing rename, it destroys the Y.Doc and recreates it:

```typescript
// packages/epicenter/src/filesystem/yjs-file-system.ts:297-314
if (fromCategory !== toCategory) {
    const content = await this.readFile(resolvedSrc);  // serialize to string
    this.store.destroy(id);                             // nuke the Y.Doc
    this.filesTable.update(id, {
        name: newName, parentId: newParentId, updatedAt: Date.now(),
    });
    await this.writeFile(resolvedDest, content);        // recreate Y.Doc, write new type
    return;
}
```

This creates problems:

1. **Healing is defeated by destroy.** `healContentType()` guards against cross-doc timing: if Peer B receives a metadata rename before the content migration arrives, it detects content in the wrong key and migrates. But `store.destroy(id)` nukes both keys. When Peer B loads the destroyed state, both `text` and `richtext` are empty. The healing check (`expected.length === 0 && other.length > 0`) fails because `other.length` is also 0. Content appears lost until the recreated Y.Doc state syncs.

2. **Unnecessary serialization roundtrip.** The flow reads content via `readFile()` (serialize XmlFragment to markdown string), destroys the doc, then writes via `writeFile()` (parse markdown string back into a different type). `convertContentType()` already does the in-place equivalent without the string intermediary.

3. **CRDT history is discarded.** Destroying and recreating a Y.Doc loses the operation log, tombstones, and version snapshots. Provider connections are severed. Any collaborative session observing that content doc sees a discontinuity.

### Desired State

```typescript
if (fromCategory !== toCategory) {
    const ydoc = this.store.ensure(id);
    convertContentType(ydoc, fromCategory, toCategory);
}
this.filesTable.update(id, {
    name: newName, parentId: newParentId, updatedAt: Date.now(),
});
```

No destroy, no string roundtrip. Content migrates between keys within the same Y.Doc. Stale keys retain old data (harmless, as documented in the main filesystem spec lines 820-824: "Stale keys diverge from reality. This is fine. They are never read while the file is .ts.").

## Research Findings

### How the triple-key architecture already supports this

The filesystem spec (lines 766-834) established that each content Y.Doc has three root-level keys: `'text'` (Y.Text), `'richtext'` (Y.XmlFragment), and `'frontmatter'` (Y.Map). Yjs locks each key to whichever shared type first accesses it, so separate keys are required. Both types can coexist in the same doc.

`convertContentType()` already reads from the source key and writes to the target key in-place:

```typescript
// text → richtext
const text = ydoc.getText('text').toString();
const { frontmatter, body } = parseFrontmatter(text);
updateYMapFromRecord(ydoc.getMap('frontmatter'), frontmatter);
updateYXmlFragmentFromString(ydoc.getXmlFragment('richtext'), body);

// richtext → text
const frontmatter = yMapToRecord(ydoc.getMap('frontmatter'));
const body = serializeXmlFragmentToMarkdown(ydoc.getXmlFragment('richtext'));
const combined = serializeMarkdownWithFrontmatter(frontmatter, body);
ydoc.transact(() => {
    ytext.delete(0, ytext.length);
    ytext.insert(0, combined);
});
```

After conversion, the target key has current content and the source key retains stale content. `openDocument()` reads from whichever key matches the current extension: stale keys are ignored.

### Cross-doc timing with in-place migration

Metadata (main doc) and content (content doc) sync independently. When Peer A renames `notes.txt` to `notes.md`:

| Step | Main doc (metadata) | Content doc |
|------|-------------------|-------------|
| Before rename | `name: 'notes.txt'` | `text`: populated, `richtext`: empty |
| After `convertContentType` | `name: 'notes.txt'` | `text`: stale, `richtext`: populated |
| After `filesTable.update` | `name: 'notes.md'` | `text`: stale, `richtext`: populated |

If Peer B receives the metadata update before the content migration:
- Extension says `.md`, expects `richtext` key
- `richtext` is still empty (migration hasn't arrived)
- `text` still has content (never destroyed)
- `healContentType` detects: richtext empty, text populated → migrates

With the current destroy approach, both keys are empty in this window. Healing can't recover.

### What `store.destroy()` was doing

`destroy(fileId)` calls `ydoc.destroy()` (Yjs internal cleanup) and removes the entry from the in-memory map. It was used to force a clean Y.Doc on the next `ensure()` call, avoiding any interaction between old and new key content. With in-place migration, this is unnecessary: `convertContentType` handles the key transition directly.

`store.destroy()` remains useful for file deletion (removing the Y.Doc when a file is permanently deleted). This change only affects the `mv` path.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Migration strategy | In-place via `convertContentType` | Already exists, avoids string roundtrip, preserves CRDT history |
| Stale key cleanup | Don't clear old keys | Harmless (documented in main spec), clearing adds complexity for no benefit |
| `store.destroy()` in `mv` | Remove | No longer needed; Y.Doc stays alive across renames |
| `healContentType` | Keep as-is | Now actually functional for cross-doc timing recovery |
| Existing tests | Should still pass | Tests verify content preservation, not the internal mechanism |

## Architecture

### Before (destroy-and-recreate)

```
mv('notes.txt', 'notes.md')
    │
    ├── readFile('notes.txt')           ← serialize to string
    ├── store.destroy(id)               ← nuke Y.Doc (both keys empty)
    ├── filesTable.update(name: .md)    ← update metadata
    └── writeFile('notes.md', content)  ← new Y.Doc, parse into richtext
```

### After (in-place)

```
mv('notes.txt', 'notes.md')
    │
    ├── store.ensure(id)                          ← get existing Y.Doc
    ├── convertContentType(ydoc, 'text', 'richtext')  ← migrate in-place
    └── filesTable.update(name: .md)              ← update metadata
```

### Multi-peer sync timeline (in-place)

```
Peer A (renamer)                          Peer B (observer)
─────────────────                         ─────────────────
convertContentType(text→richtext)
    │                                     readFile('notes.txt')
    │  content doc syncs ─────────────►       → reads from 'text' key ✓
filesTable.update(name: .md)
    │  main doc syncs ────────────────►   sees name change to .md
    │                                     readFile('notes.md')
    │                                         → richtext empty, text populated
    │                                         → healContentType migrates ✓
    │  content doc syncs ─────────────►   richtext now populated
    │                                     readFile('notes.md')
    │                                         → reads from 'richtext' key ✓
```

## Implementation Plan

### Phase 1: Change `mv` to in-place migration

- [ ] **1.1** Replace the destroy-and-recreate block in `yjs-file-system.ts:297-314` with `store.ensure(id)` + `convertContentType(ydoc, fromCategory, toCategory)` + metadata update
- [ ] **1.2** Run existing `convert-on-switch.test.ts` tests (`.txt → .md`, `.md → .txt`, round-trip, same-category): they should pass without modification
- [ ] **1.3** Run full `yjs-file-system.test.ts` suite

### Phase 2: Add cross-doc timing test coverage

- [ ] **2.1** Add integration test: simulate Peer B seeing metadata rename before content migration (manually set name to `.md` while content is still in `text` key), verify `readFile` returns correct content via healing
- [ ] **2.2** Add test: verify Y.Doc identity is preserved across type-changing rename (same `ydoc` instance before and after `mv`)

## Edge Cases

### Round-trip renames (.txt → .md → .txt)

1. Start with `notes.txt`, content in `text` key
2. Rename to `.md`: `convertContentType` writes to `richtext`, `text` retains stale content
3. Rename back to `.txt`: `convertContentType` reads from `richtext`, writes to `text`
4. Content round-trips through both types

Already tested in `convert-on-switch.test.ts:173-183`. The in-place approach uses the same `convertContentType` function, so behavior is identical.

### Content in both keys after migration

After converting `text → richtext`, the `text` key still has old content. If `healContentType` runs on this state: richtext is populated (length > 0), so the healing check `richtext.length === 0 && text.length > 0` is false. No spurious migration. Correct.

### Empty file rename

File has no content in any key. `convertContentType` reads empty source, writes empty target. No-op in practice. `healContentType` sees both keys empty, no-ops. Correct.

## Open Questions

1. **Should `convertContentType` clear the source key after migration?**
   - Currently it doesn't: stale data remains in the old key.
   - Clearing would make the state cleaner but adds operations with no functional benefit (stale keys are never read).
   - **Recommendation**: Don't clear. Matches the documented triple-key architecture. Stale keys are explicitly expected.

2. **Should the content migration and metadata update happen in a coordinated transaction?**
   - They're on different Y.Docs, so a single Yjs transaction can't span both.
   - The ordering (migrate content first, then update metadata) minimizes the window where healing is needed: content is in the new key before the extension changes.
   - **Recommendation**: Keep the current ordering. The healing safety net covers any remaining timing gaps.

## Success Criteria

- [ ] Existing `convert-on-switch.test.ts` tests pass without modification
- [ ] Existing `yjs-file-system.test.ts` tests pass without modification
- [ ] `mv()` no longer calls `store.destroy()` for type-changing renames
- [ ] Y.Doc identity is preserved across type-changing rename (same instance)
- [ ] Cross-doc timing test demonstrates healing recovery

## References

- `packages/epicenter/src/filesystem/yjs-file-system.ts`: `mv()` implementation (lines 287-322)
- `packages/epicenter/src/filesystem/convert-on-switch.ts`: `convertContentType()` and `healContentType()`
- `packages/epicenter/src/filesystem/content-doc-store.ts`: `ensure()` and `destroy()`
- `packages/epicenter/src/filesystem/convert-on-switch.test.ts`: Existing integration tests for type-changing renames
- `specs/20260208T000000-yjs-filesystem-spec.md`: Triple-key architecture (lines 766-834), cross-doc timing (line 895), self-healing (lines 897-898)
- `specs/20260209T000000-simplify-content-doc-lifecycle.md`: ContentDocStore design and ensure/heal/open pipeline
