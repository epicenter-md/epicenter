> **Note (2026-03-14)**: Binary content mode was removed and `handle.content` was flattened to direct handle methods in [document-handle-cleanup](./20260314T060000-document-handle-cleanup.md).

# Unify Document Content Model

**Date**: 2026-03-13
**Status**: Active
**Supersedes**: `specs/20260219T094400-migrate-filesystem-to-document-binding.md` (content model aspects—the dual-path decision is reversed here)

## Overview

Document Y.Docs store content through two independent, incompatible models—a timeline array and a raw Y.Text. Writes through one path are invisible to reads through the other. This spec unifies on the timeline model as the single content abstraction.

## Motivation

### Current State

Every table with `.withDocument()` gets a content Y.Doc per row. That Y.Doc can be accessed two ways:

**Path 1: Timeline model** (packages/filesystem)

```typescript
// packages/filesystem/src/content/timeline.ts
const timeline = ydoc.getArray<Y.Map>('timeline');
// Each entry: { type: 'text'|'binary'|'sheet', content: Y.Text|Uint8Array|... }

// packages/filesystem/src/content/content.ts
const { ydoc } = await documents.open(fileId);
const tl = createTimeline(ydoc);
tl.readAsString();          // reads timeline[last].content
tl.pushText('hello');       // appends new timeline entry
```

**Path 2: Handle model** (packages/workspace)

```typescript
// packages/workspace/src/workspace/create-document.ts — makeHandle()
read()  { return ydoc.getText('content').toString(); }
write(text) {
    const ytext = ydoc.getText('content');
    ydoc.transact(() => { ytext.delete(0, ytext.length); ytext.insert(0, text); });
}
```

These write to completely different Y.js shared types within the same Y.Doc:

```
Document Y.Doc (guid: fileId)
├── Y.Array('timeline')           ← filesystem API writes here
│   └── [0]: Y.Map { type: 'text', content: Y.Text('hello') }
├── Y.Text('content')             ← handle.read/write uses here
└── (both persisted to IndexedDB, but never synchronized)
```

This creates problems:

1. **Silent data loss**: `fs.writeFile('/readme.md', 'hello')` writes to timeline. `handle.read()` reads from raw Y.Text. Returns `''`. Content exists but is invisible to the editor.
2. **Confusing API surface**: `DocumentHandle` exposes `read()/write()` as the "obvious" way to use documents, but these methods use a different storage model than the filesystem that created the content.
3. **No single source of truth**: Two independent content stores in the same Y.Doc means no authoritative read path.

### Current App Usage

| App | Content Access Pattern | Model Used |
|---|---|---|
| Opensidian | `handle.read()/write()` in ContentEditor | Handle (raw Y.Text) |
| Opensidian | `fs.writeFile()`/`fs.readFile()` for file creation | Timeline |
| Honeycrisp | `handle.ydoc.getXmlFragment('content')` directly | Neither—raw Y.Doc access |
| Fuji | `handle.ydoc.getText('content')` directly | Neither—raw Y.Doc access |

Honeycrisp and Fuji bypass `handle.read()/write()` entirely. They use the handle only for Y.Doc access and work with shared types directly. Opensidian is the only app using both paths on the same Y.Doc.

### Anti-Patterns

Two patterns are anti-patterns going forward:

**1. Using `handle.read()`/`handle.write()` alongside filesystem APIs**

```typescript
// ❌ BAD: handle.read/write uses Y.Text('content'), fs uses Y.Array('timeline')
const handle = await ws.documents.files.content.open(id);
const text = handle.read();           // reads from Y.Text('content') — WRONG store
handle.write('hello');                // writes to Y.Text('content') — WRONG store

// ✅ GOOD: use fs.content which reads/writes via timeline
const text = await fs.content.read(id);     // reads from timeline
await fs.content.write(id, 'hello');        // writes to timeline
```

**2. Accessing `handle.ydoc` directly for content**

```typescript
// ❌ BAD: bypasses both abstractions, writes to a shared type timeline doesn't know about
const ytext = handle.ydoc.getText('content');
const fragment = handle.ydoc.getXmlFragment('content');

// ✅ GOOD: use createTimeline(handle.ydoc) and access the nested shared types
import { createTimeline } from '@epicenter/filesystem';
const tl = createTimeline(handle.ydoc);
const entry = tl.currentEntry;
const ytext = entry?.get('content') as Y.Text;  // timeline-managed Y.Text
```

### Desired State

One content model. Timeline wins because it supports multiple formats (text, binary, sheet) and already powers the filesystem API. The handle's `read()/write()` will eventually read from the timeline, not a separate raw Y.Text.

## Research Findings

### Why Timeline Exists

The timeline model was introduced for the filesystem package to support multi-format content: plain text files, binary blobs, and CSV sheets. Each "entry" in the timeline is a typed Y.Map with a mode discriminator. The most recent entry is the current content.

See: `packages/filesystem/src/content/entry-types.ts`, `packages/filesystem/src/content/timeline.ts`

### Why Handle Uses Raw Y.Text

`makeHandle()` in `create-document.ts` was built as a generic convenience for the workspace package. It uses `ydoc.getText('content')` because that's the simplest Y.js pattern for text content. It was designed before the filesystem/timeline model existed, or without awareness of it.

### Who Actually Calls handle.read()/write()

Only Opensidian's `readContent`/`writeContent` in `fs-state.svelte.ts`. Honeycrisp and Fuji use the `ydoc` property directly.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Which content model wins | Timeline | Supports text/binary/sheet. Already powers filesystem. More capable. |
| Phase 1 change point | Opensidian app layer | Simplest fix—switch `readContent`/`writeContent` to use `fs.content` instead of `handle.read/write`. Zero workspace package changes. |
| Phase 2 change point | `makeHandle()` in create-document.ts | Eventually unify handle.read/write to use timeline internally. Requires solving dependency direction. |
| What about apps using ydoc directly | Future Phase 3 | Honeycrisp/Fuji access Y.Doc directly for Tiptap binding. Migration to timeline-nested shared types is a separate effort. |
| handle.ydoc escape hatch | Keep it | Apps that need raw Y.Doc access (custom shared types beyond timeline) still have it, but it should be rare and documented as advanced usage. |
| Timeline location | Stays in packages/filesystem for now | Moving to packages/workspace requires solving the sheet/binary dependency. Deferred to Phase 2. |

## Architecture

### Before (two content stores)

```
Document Y.Doc
├── Y.Array('timeline')     ← fs.writeFile/readFile
│   └── entries[]
├── Y.Text('content')       ← handle.read/write
└── (disconnected)
```

### After Phase 1 (opensidian unified)

```
Document Y.Doc
├── Y.Array('timeline')     ← fs.writeFile/readFile AND opensidian editor
│   └── entries[]
├── Y.Text('content')       ← unused in opensidian (handle.read/write still uses it generically)
```

### After Phase 2 (handle unified)

```
Document Y.Doc
├── Y.Array('timeline')     ← EVERYTHING reads/writes here
│   └── entries[]
├── Y.Text('content')       ← legacy, unused
└── handle.read() → timeline[last].readAsString()
    handle.write() → timeline[last] text replace OR pushText
```

## Implementation Plan

### Phase 1: Fix opensidian (NOW)

Opensidian's `readContent`/`writeContent` in `fs-state.svelte.ts` currently use `handle.read()`/`handle.write()`, which read/write `Y.Text('content')`. The filesystem's `fs.content.read()`/`fs.content.write()` use the timeline. Switch to the filesystem path.

- [x] **1.1** Change `readContent` in `fs-state.svelte.ts` to use `fs.content.read(id)` instead of `handle.read()`
- [x] **1.2** Change `writeContent` in `fs-state.svelte.ts` to use `fs.content.write(id, data)` instead of `handle.write(data)`
- [x] **1.3** Update `DocumentHandle` type JSDoc to warn about the Y.Text/timeline mismatch
- [x] **1.4** Update documentation: skills, READMEs, AGENTS.md to document anti-patterns

**Exact changes in `fs-state.svelte.ts`:**

```typescript
// readContent — BEFORE:
const handle = await ws.documents.files.content.open(id);
return handle.read();

// readContent — AFTER:
return await fs.content.read(id);

// writeContent — BEFORE:
const handle = await ws.documents.files.content.open(id);
handle.write(data);

// writeContent — AFTER:
await fs.content.write(id, data);
```

### Phase 2: Make `makeHandle()` timeline-backed (FUTURE)

Change `makeHandle()` in `create-document.ts` so `read()` and `write()` use the timeline instead of raw `Y.Text('content')`. This requires resolving the dependency direction problem.

**Dependency direction problem**: `createTimeline()` lives in `packages/filesystem` and imports sheet parsing utilities. `packages/workspace` cannot import from `packages/filesystem`.

**Resolution options** (to be decided when Phase 2 is picked up):

- **(a) Extract minimal text timeline into workspace**: Create a `createTextTimeline(ydoc)` in workspace that supports only text mode (~40 lines, no sheet/binary imports). The filesystem's `createTimeline()` extends it. `makeHandle()` uses the minimal version.
- **(b) Inline timeline read/write in makeHandle**: Add ~20 lines of inline logic to `makeHandle()` that reads from `getArray('timeline')` last entry and writes to it. No import needed, but duplicates some timeline knowledge.
- **(c) Move full timeline to workspace**: Move `timeline.ts` and `entry-types.ts` into workspace, extract sheet parsing into a filesystem-specific extension. Clean but more files to move.

**Recommendation**: Option (a)—minimal text timeline in workspace. Sheet and binary are filesystem-specific concerns.

- [ ] **2.1** Create `packages/workspace/src/workspace/text-timeline.ts` with minimal text-only timeline
- [ ] **2.2** Change `makeHandle()` to use text-timeline for `read()`/`write()`
- [ ] **2.3** Handle migration: if timeline is empty but `getText('content')` has data, copy it into a timeline text entry on first read
- [ ] **2.4** Update `packages/filesystem/src/content/timeline.ts` to extend or import from workspace's text-timeline
- [ ] **2.5** Update DocumentHandle type JSDoc to reflect timeline-backed behavior
- [ ] **2.6** All workspace/filesystem tests pass

### Phase 3: Migrate fuji and honeycrisp (FUTURE)

Both apps bypass `handle.read()/write()` and access `handle.ydoc` directly for Tiptap editor binding:

- **Fuji**: `handle.ydoc.getText('content')` → passes Y.Text to Tiptap
- **Honeycrisp**: `handle.ydoc.getXmlFragment('content')` → passes Y.XmlFragment to Tiptap/y-prosemirror

These create shared types outside the timeline. The migration path:

1. Open document via workspace documents manager (same as today)
2. Use `createTimeline(handle.ydoc)` to access the timeline
3. For text content (Fuji): get the current text entry's nested `Y.Text` from the timeline entry (`entry.get('content') as Y.Text`). This Y.Text is a valid Tiptap binding target.
4. For rich text content (Honeycrisp): push a `richtext` timeline entry containing a `Y.XmlFragment`. Get the nested fragment from the entry. Pass to y-prosemirror.
5. Handle migration: if timeline is empty but `getText('content')` or `getXmlFragment('content')` has data, copy into a timeline entry.

**Key insight**: Tiptap/y-prosemirror binds to `Y.Text` or `Y.XmlFragment` instances. The timeline wraps these inside `Y.Map` entries, but the nested shared types are themselves valid binding targets. The migration is about *where* the shared type lives (top-level vs nested in timeline), not changing Tiptap's binding model.

- [ ] **3.1** Fuji: replace `handle.ydoc.getText('content')` with timeline-based Y.Text access
- [ ] **3.2** Honeycrisp: replace `handle.ydoc.getXmlFragment('content')` with timeline-based Y.XmlFragment access
- [ ] **3.3** Handle migration for existing persisted Y.Docs in both apps

## Edge Cases

### Existing persisted Y.Docs with raw Y.Text content

1. User saved content via old handle.write() → data in `ydoc.getText('content')`
2. Code is updated → handle.read() now reads from timeline → returns '' (timeline is empty)
3. **Need migration**: on first read, if timeline is empty but `getText('content')` has data, copy it into a timeline entry.

This migration is deferred to Phase 2. Phase 1 (opensidian fix) doesn't need it because opensidian's `readContent`/`writeContent` switch to `fs.content` which already reads timeline. Files created via `fs.writeFile()` already have timeline entries. Files where content was written via `handle.write()` (the editor path) would have raw Y.Text content—but in practice, opensidian creates files via `fs.writeFile(path, '')` (empty timeline entry) and edits via the handle, so the timeline entry exists but is empty while the real content is in raw Y.Text. After Phase 1, new edits go to timeline, but old content in Y.Text is orphaned until Phase 2 adds migration.

### Empty document (no timeline entries)

1. Brand new file, timeline is empty, `currentMode === undefined`
2. `fs.content.read()` → `readAsString()` returns `''` (correct)
3. `fs.content.write(id, 'hello')` → pushes a text entry (correct)

### Binary/sheet content read as text

1. File was written as binary via `fs.writeFile(path, buffer)`
2. `fs.content.read()` → `readAsString()` decodes binary as text
3. This is the current timeline behavior—acceptable.

## Resolved Questions

1. **Where should timeline live?** → Stays in `packages/filesystem` for Phase 1. Phase 2 extracts a minimal text-timeline into `packages/workspace`.

2. **Should handle.read()/write() exist?** → Yes. They're kept as a convenience. Phase 2 changes their internals to use timeline. Until then, they remain Y.Text-backed and are documented as not timeline-aware.

3. **What about the `onUpdate` callback?** → No change needed. `create-document.ts` watches the Y.Doc `'update'` event, which fires on ANY Y.Doc change regardless of which shared type was modified. Both timeline writes and raw Y.Text writes trigger it.

## Success Criteria

### Phase 1 (now)
- [x] Opensidian `readContent`/`writeContent` use `fs.content.read()`/`fs.content.write()` (timeline-backed)
- [x] Documentation updated: skills, READMEs, AGENTS.md, JSDoc
- [x] Anti-patterns documented with code examples
- [ ] Manual test: opensidian create file → type content → switch files → switch back → content persists

### Phase 2 (future)
- [ ] `handle.read()` returns content written by `fs.writeFile()` (same shared type)
- [ ] `fs.readFile()` returns content written by `handle.write()` (same shared type)
- [ ] Existing persisted content (in raw Y.Text) is migrated on first read
- [ ] All workspace/filesystem tests pass

### Phase 3 (future)
- [ ] Fuji uses timeline-nested Y.Text for Tiptap binding
- [ ] Honeycrisp uses timeline-nested Y.XmlFragment for Tiptap binding
- [ ] No app accesses `handle.ydoc.getText('content')` or `handle.ydoc.getXmlFragment('content')` directly

## References

- `packages/workspace/src/workspace/create-document.ts` — `makeHandle()` (line 101-120)
- `packages/workspace/src/workspace/types.ts` — `DocumentHandle` type (line 255-278)
- `packages/filesystem/src/content/timeline.ts` — Timeline abstraction
- `packages/filesystem/src/content/content.ts` — `createContentHelpers()` (uses timeline)
- `packages/filesystem/src/file-system.ts` — `createYjsFileSystem()` (uses content helpers)
- `apps/opensidian/src/lib/fs/fs-state.svelte.ts` — `readContent`/`writeContent` (uses handle)
- `apps/opensidian/src/lib/components/ContentEditor.svelte` — Editor component
- `specs/20260219T094400-migrate-filesystem-to-document-binding.md` — Previous dual-model decision (superseded)
