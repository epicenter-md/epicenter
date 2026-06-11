# Honeycrisp: Factory Consolidation & File Reorganization

## Goal

Split the 538-line god factory (`createNotesState`) into 3 focused factories, extract editor utilities, and reorganize files for clarity.

## Changes

### 1. workspace/ split
- `workspace.ts` → `workspace/schema.ts` (types, tables, defineWorkspace) + `workspace/client.ts` (createWorkspace + extension) + `workspace/index.ts` (re-exports)
- No import changes needed: `$lib/workspace` resolves to `workspace/index.ts`

### 2. state/ split (the big one)
- `state/notes.svelte.ts` (538 lines) → 3 factories:
  - `state/folders.svelte.ts`: folder CRUD + reactive folder list (~70 lines)
  - `state/notes.svelte.ts`: note CRUD + derived note collections (~140 lines)
  - `state/view.svelte.ts`: selection, search, sort, view mode + cross-cutting derivations (~120 lines)
  - `state/index.ts`: re-exports all 3
- Dependency chain: `foldersState` → `notesState` → `viewState` (clean DAG, no cycles)
- Cross-cutting: `deleteFolder` reads workspace directly instead of $state cache; notes observer picks up changes

### 3. editor/ extraction
- Extract `createYjsExtension()` → `editor/extensions.ts`
- Extract `extractTitleAndPreview()` → `editor/utils.ts`
- Move `components/Editor.svelte` → `editor/Editor.svelte`

### 4. Date util consolidation
- Move `getDateLabel()` from NoteList.svelte → `utils/date.ts`

### 5. Component import updates
All 5 consumers update from `notesState.*` to `foldersState.*` / `viewState.*` / `notesState.*` as appropriate.

## Todo

- [x] Create workspace/schema.ts, workspace/client.ts, workspace/index.ts; delete workspace.ts
- [x] Create state/folders.svelte.ts
- [x] Create state/notes.svelte.ts (slimmed)
- [x] Create state/view.svelte.ts
- [x] Create state/index.ts; delete old state/notes.svelte.ts
- [x] Create editor/extensions.ts, editor/utils.ts
- [x] Move and update Editor.svelte → editor/Editor.svelte
- [x] Update utils/date.ts with getDateLabel
- [x] Update Sidebar.svelte imports
- [x] Update NoteCard.svelte imports
- [x] Update NoteList.svelte imports
- [x] Update CommandPalette.svelte imports
- [x] Update +page.svelte imports
- [x] Verify with diagnostics/typecheck

## Review

## Summary

**Before:** 10 source files, 1,700 lines. One 538-line god factory (`createNotesState`) handling folders, notes, and navigation in a single closure.

**After:** 20 source files, ~1,800 lines (slight increase from JSDoc). Three focused state factories (116/253/217 lines), workspace split into schema/client, editor utilities extracted, date utils consolidated.

### Key architectural decisions:
- **No cycles in state DAG:** `foldersState` → `notesState` → `viewState`. View state depends on both folders and notes for cross-cutting derivations (`filteredNotes`, `folderName`, `selectedNote`).
- **Direct workspace reads over $state cache:** `deleteFolder` reads `workspaceClient.kv.get('selectedFolderId')` and `workspaceClient.tables.notes.getAllValid()` directly instead of depending on $state variables from other factories. The observers in the affected factory pick up the changes.
- **`$lib/workspace` import path preserved:** The workspace/index.ts barrel re-exports everything with the same names, so zero import changes were needed for the workspace split.
- **Editor as a domain directory:** Editor.svelte moved from components/ to editor/ alongside its extracted utilities (extensions.ts, utils.ts), co-locating related code.

### Files changed:
- Created: `workspace/schema.ts`, `workspace/client.ts`, `workspace/index.ts`, `state/folders.svelte.ts`, `state/view.svelte.ts`, `state/index.ts`, `editor/extensions.ts`, `editor/utils.ts`, `editor/Editor.svelte`
- Modified: `state/notes.svelte.ts` (slimmed from 538→253 lines), `utils/date.ts` (+getDateLabel), `Sidebar.svelte`, `NoteCard.svelte`, `NoteList.svelte`, `CommandPalette.svelte`, `+page.svelte`
- Deleted: `workspace.ts`, `components/Editor.svelte`
