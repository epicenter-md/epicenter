# OpenSidian Feature Additions

**Date**: 2026-03-13
**Status**: Draft
**Author**: AI-assisted

## Overview

New features for OpenSidian that transform it from a filesystem demo into a usable note-taking application. Each feature is scoped independently—they can be built in any order, though some have natural dependencies.

## Motivation

### Current State

OpenSidian has the bones of a file manager:
- Tree view with expand/collapse
- Single-file text editing (raw textarea)
- Create, rename, delete operations
- Breadcrumb navigation
- CRDT-backed persistence via Yjs + IndexedDB

But it lacks features that users expect from any file-based note app:

1. **No open file tabs** — `fsState.openFileIds` tracks open files, but there's no tab bar. Users can only view one file at a time with no way to switch between recently opened files.
2. **No search** — No way to find files by name or content. The only navigation is manual tree browsing.
3. **No keyboard tree navigation** — Only Enter/Space work. No arrow keys for up/down/expand/collapse.
4. **No rich editing** — Plain textarea. No markdown rendering, no syntax highlighting, no formatting.
5. **No file type awareness** — All files show the same icon regardless of extension.
6. **No drag-and-drop** — Can't move files/folders by dragging in the tree.
7. **No sort options** — Tree is always sorted alphabetically by name.

### Desired State

A note-taking app where users can efficiently navigate large file trees, search across all content, edit markdown with live preview, and reorganize files via drag-and-drop—all built on shadcn-svelte primitives from `@epicenter/ui`.

## Feature Catalog

### Feature 1: Open File Tabs

**Priority**: High
**Depends on**: None
**Complexity**: Low

The state already exists (`fsState.openFileIds`, `fsState.activeFileId`, `fsState.actions.selectFile`, `fsState.actions.closeFile`). This is purely a UI addition.

**Design**:
- Use `Tabs` from `@epicenter/ui/tabs` above the `ContentPanel`
- Each tab shows the file name with a close button
- Active tab corresponds to `fsState.activeFileId`
- Tab overflow scrolls horizontally
- Middle-click or close button calls `fsState.actions.closeFile(id)`
- Dirty indicator (unsaved changes) on tab if `ContentEditor` has modifications

**Architecture**:
```
ContentPanel.svelte
  ├── TabBar.svelte (NEW)
  │     └── Tabs.Root > Tabs.List > Tabs.Trigger (per open file)
  ├── PathBreadcrumb.svelte
  └── ContentEditor.svelte
```

### Feature 2: Command Palette (Search)

**Priority**: High
**Depends on**: SQLite Index Extension (for content search), or can work with name-only search initially
**Complexity**: Medium

**Design**:
- Use `Command` from `@epicenter/ui/command` (cmdk-sv under the hood)
- Trigger via `Ctrl+K` / `Cmd+K` keyboard shortcut
- Two modes:
  - **File search** (default): Filter files by name using `fsState` data (no SQLite needed)
  - **Content search**: If SQLite index extension is available, search file contents via FTS5
- Results show file icon, name, path, and content snippet (for content search)
- Selecting a result opens the file via `fsState.actions.selectFile(id)`

**Architecture**:
```
AppShell.svelte
  └── CommandPalette.svelte (NEW)
        └── Command.Root > Command.Input > Command.List > Command.Item
```

**Without SQLite**: File name search works by filtering `fsState.rootChildIds` recursively. This is O(n) over all files but fast enough for <10k files.

**With SQLite**: Content search uses the extension's `search()` method with FTS5 for ranked, highlighted results.

### Feature 3: Keyboard Tree Navigation

**Priority**: Medium
**Depends on**: None (or Tree View Adoption spec)
**Complexity**: Medium

**Design**:
- Arrow Up/Down: Move focus between visible tree items
- Arrow Right: Expand focused folder (or move to first child)
- Arrow Left: Collapse focused folder (or move to parent)
- Enter: Open focused file / toggle focused folder
- Home/End: Jump to first/last visible item
- Type-ahead: Start typing to jump to matching file name

This requires managing a `focusedId` state separate from `activeFileId` (focused ≠ selected). The tree container handles keydown events and translates them to focus movements.

**Implementation approach**:
- Add `focusedId` to `fsState`
- Compute a flat list of visible item IDs (respecting expansion state)
- Arrow Up/Down moves `focusedId` through the flat list
- `aria-activedescendant` on the tree root points to the focused item
- Focus is managed via the roving tabindex pattern

### Feature 4: File Type Icons

**Priority**: Low
**Depends on**: UI Idiomaticity spec (lucide-svelte icons)
**Complexity**: Low

**Design**:
- Map file extensions to Lucide icons:
  - `.md` → `FileText`
  - `.ts` / `.js` → `FileCode`
  - `.json` → `FileJson`
  - `.csv` → `Sheet`
  - `.png` / `.jpg` / `.svg` → `Image`
  - Default → `File`
- Extract extension from `row.name` in `TreeNode.svelte` (or `FileTreeItem.svelte`)
- Small utility function: `getFileIcon(name: string): ComponentType`

### Feature 5: Rich Text Editor

**Priority**: Medium
**Depends on**: None directly, but makes more sense after tabs
**Complexity**: High

**Design options**:

| Editor | Yjs Integration | Markdown Support | Bundle Size | Maturity |
|---|---|---|---|---|
| **TipTap** | `y-tiptap` | Via extensions | ~150KB | Very mature |
| **CodeMirror 6** | `y-codemirror.next` | Syntax highlighting | ~200KB | Very mature |
| **Milkdown** | Built on ProseMirror + Yjs | First-class markdown | ~100KB | Moderate |
| **BlockNote** | Built on TipTap + Yjs | Block-based markdown | ~250KB | Growing |

**Key insight**: OpenSidian's content layer already stores data in Yjs Y.Docs. Editors with native Yjs bindings (TipTap via y-tiptap, CodeMirror via y-codemirror) can bind DIRECTLY to the existing content documents without any serialization layer. This is the ideal path.

**Recommendation**: Start with CodeMirror 6 for a code/markdown editor with syntax highlighting and Yjs binding. It's the most flexible and has excellent Svelte integration patterns.

### Feature 6: Drag-and-Drop

**Priority**: Low
**Depends on**: Tree View Adoption (easier with structured tree components)
**Complexity**: High

**Design**:
- Drag files/folders within the tree to move them
- Visual indicator showing drop target (folder highlight, insertion line)
- Drop action calls `fsState.actions` to move the file: `fs.mv(sourcePath, destPath)`
- Prevent invalid drops (e.g., dropping a folder into its own descendant)
- Use native HTML5 drag-and-drop or a library like `@formkit/drag-and-drop`

### Feature 7: Sort Options

**Priority**: Low
**Depends on**: None
**Complexity**: Low

**Design**:
- Dropdown or toggle in the Toolbar: Sort by Name (A-Z, Z-A), Date Modified, Type, Size
- Sort state stored in `fsState` (persisted in KV or local)
- Applied when computing child display order in `FileTree` / `TreeNode`
- Folders always sorted before files (configurable)

## Implementation Plan

### Phase 1: High-Priority Features

- [x] **1.1** Build `TabBar.svelte` using `Tabs` from `@epicenter/ui/tabs`
- [x] **1.2** Wire tab state to `fsState.openFileIds` / `fsState.activeFileId`
- [x] **1.3** Add close button on tabs (dirty indicator removed—no save concept in CRDT-backed storage)
- [x] **1.4** Build `CommandPalette.svelte` using `Command` from `@epicenter/ui/command`
- [x] **1.5** Implement file-name search (no SQLite dependency)
- [x] **1.6** Add `Ctrl+K` / `Cmd+K` keyboard shortcut to open palette
- [x] **1.7** Wire result selection to `fsState.actions.selectFile`

### Phase 2: Navigation and Polish

- [x] **2.1** Implement keyboard tree navigation (arrow keys, Home/End)
- [x] **2.2** Add `focusedId` state to `fsState`
- [x] **2.3** Compute flat visible-items list from tree expansion state
- [x] **2.4** Add file type icon mapping utility
- [x] **2.5** Wire icons into TreeNode/FileTreeItem based on file extension

### Phase 3: Rich Editing

- [x] **3.1** Add CodeMirror 6 dependency with Svelte wrapper
- [x] **3.2** Add `y-codemirror.next` for Yjs binding
- [x] **3.3** Replace `ContentEditor.svelte`'s textarea with CodeMirror
- [x] **3.4** Bind CodeMirror to the file's Y.Doc directly (no serialization)
- [x] **3.5** Add markdown syntax highlighting
- [ ] **3.6** Optional: Add split-pane markdown preview (skipped for now)

### Phase 4: Advanced Interactions

- [ ] **4.1** Implement drag-and-drop in tree (library selection TBD)
- [ ] **4.2** Add sort options to toolbar
- [ ] **4.3** Wire content search to SQLite index extension (when available)

## Edge Cases

### Tab State Persistence

1. User has 5 tabs open, refreshes the page
2. `fsState.openFileIds` is derived from Yjs state—does it persist?
3. If not, tabs reset on reload. Consider storing open tab IDs in workspace KV.

### Command Palette with Large File Trees

1. Workspace has 10,000 files
2. File-name search needs to be fast (filtering 10k items on every keystroke)
3. Solution: Debounce input (150ms), limit results to 50, use `startsWith` before `includes`

### CodeMirror + Yjs Binding Lifecycle

1. User opens a file → CodeMirror binds to its Y.Doc
2. User switches tabs → CodeMirror instance must unbind from old Y.Doc, bind to new one
3. Y.Doc lifecycle is managed by `documents.open(fileId)` / `documents.close(fileId)`
4. Must coordinate CodeMirror lifecycle with document open/close

## Open Questions

1. **Should tabs persist across sessions?**
   - Options: (a) Ephemeral—reset on reload, (b) Persist in workspace KV, (c) Persist in localStorage
   - **Recommendation**: (b) — workspace KV is already available and persists via Yjs. Store `openFileIds` and `activeFileId` there.

2. **Which rich text editor to use?**
   - Options: (a) CodeMirror 6, (b) TipTap, (c) Milkdown
   - **Recommendation**: (a) CodeMirror 6. It's the most flexible, has excellent Yjs integration, and supports both code editing and markdown. TipTap is better for WYSIWYG rich text; CodeMirror is better for a code/note editor.

3. **Should the command palette support commands beyond search?**
   - Options: (a) Search only, (b) Search + actions (create file, delete, rename, change theme)
   - **Recommendation**: Start with (a). Add actions later—the Command component supports grouping results, making it easy to add "Actions" sections.

4. **Should drag-and-drop use native HTML5 or a library?**
   - Native DnD is painful for tree reordering. Libraries like `@formkit/drag-and-drop` or `dnd-kit` (React-first but adaptable) handle edge cases.
   - **Recommendation**: Defer DnD to last. Evaluate library options when the time comes.

## Success Criteria

- [ ] Open file tabs render above the content area with close buttons
- [ ] Switching tabs switches the active file instantly (no load delay for recently opened files)
- [ ] Command palette opens with Ctrl+K and searches files by name
- [ ] Arrow keys navigate the file tree (up/down/left/right)
- [ ] File icons change based on extension (.md, .ts, .json, etc.)
- [ ] All new UI uses shadcn-svelte primitives (Tabs, Command) from `@epicenter/ui`
- [ ] `svelte-check` passes with no new errors

## References

- `apps/opensidian/src/lib/fs/fs-state.svelte.ts` — existing `openFileIds`, `activeFileId`, `selectFile`, `closeFile`
- `apps/opensidian/src/lib/components/ContentPanel.svelte` — content area where tabs would go
- `apps/opensidian/src/lib/components/ContentEditor.svelte` — textarea to replace with rich editor
- `apps/opensidian/src/lib/components/AppShell.svelte` — top-level layout for command palette
- `packages/ui/src/tabs/` — Tabs component
- `packages/ui/src/command/` — Command palette component
- `packages/filesystem/src/content/content.ts` — content read/write for editor binding

## Phase 3 Review

### Summary

Replaced the plain `<Textarea>` in ContentEditor with CodeMirror 6 bound directly to Yjs via `y-codemirror.next`. Every keystroke is now a Y.Doc operation with no intermediate string copy.

### Key Discovery

The Y.Array('timeline') / Y.Text compatibility concern was a non-issue. The timeline Y.Array is a container for versioned entries; each text entry contains a Y.Text inside it. The existing `DocumentHandle.asText()` method (designed explicitly for editor binding) returns the Y.Text directly, handling mode conversion and empty-doc initialization automatically.

### Changes Made

1. **`packages/filesystem/src/file-system.ts`** -- Added `open()` method to `fs.content`. One-line passthrough to `contentDocuments.open(fileId)` that returns the full `DocumentHandle`. This bridges the string-based I/O layer to the richer handle API needed for editor binding.

2. **`apps/opensidian/package.json`** -- Added devDependencies: `@codemirror/state`, `@codemirror/view`, `@codemirror/commands`, `@codemirror/lang-markdown`, `@codemirror/language`, `y-codemirror.next`.

3. **`apps/opensidian/src/lib/components/CodeMirrorEditor.svelte`** (NEW) -- Svelte 5 wrapper for CodeMirror 6. Accepts a `Y.Text` prop, creates an `EditorView` in `$effect`, destroys on cleanup. Extensions: `yCollab` (Yjs binding with built-in UndoManager), `markdown()` (syntax highlighting), `defaultKeymap`, `indentWithTab`, `drawSelection`, `EditorView.lineWrapping`. Styled to match the original textarea: monospace font, no gutters, no focus ring, transparent background, 1rem padding.

4. **`apps/opensidian/src/lib/components/ContentEditor.svelte`** -- Complete rewrite. Dropped: `content` state, `loading`/`dirty` flags, `loadContent()`, `saveContent()`, `handleInput()`, `handleKeydown()`, cleanup write-on-destroy, `Textarea` import. Added: async `open()` call to get `DocumentHandle`, `handle.asText()` to extract `Y.Text`, renders `CodeMirrorEditor` with the Y.Text. The entire read-edit-writeback cycle is eliminated.

### What Was Eliminated

- No more `readContent` / `writeContent` calls from the editor
- No more `dirty` flag tracking
- No more `saveContent` on blur / Ctrl+S / cleanup
- No more race condition guard on string loading (the Y.Text is the source of truth)
- No more Textarea component import

### Lifecycle

The `{#key fsState.activeFileId}` block in ContentPanel.svelte destroys/recreates ContentEditor on tab switch. This naturally handles CodeMirror lifecycle: the `$effect` cleanup calls `view.destroy()`, and a new EditorView is created for the next file's Y.Text. The `DocumentHandle` caching in the Documents manager means re-opening the same file is cheap (returns the existing cached Y.Doc).

### Pre-existing Issues

svelte-check reports 80 pre-existing errors in `@epicenter/ui` (missing `#/utils.js` module resolution) and `define-table.ts` (missing `NumberKeysOf` type). None are related to our changes.
