# Inline File Creation & Rename UX

Replace modal dialogs with inline tree inputs for file/folder creation and rename—matching VS Code, Obsidian, and JetBrains patterns.

## Current State

- **CreateDialog.svelte** — Modal dialog pops up center-screen to name new files/folders
- **RenameDialog.svelte** — Same modal approach for rename
- **FileTreeItem.svelte** — Already has context menu (right-click) with New File/Folder/Rename/Delete
- **Toolbar.svelte** — Buttons trigger the modal dialogs
- **FileTree.svelte** — Keyboard nav (arrows, Home/End, Enter/Space) works well

## Problem

Modal dialogs for file creation are not idiomatic. Every major file explorer (VS Code, Obsidian, JetBrains, Sublime) uses inline inputs that appear directly in the tree at the insertion point.

## Design (VS Code Pattern)

### Inline Creation
1. User clicks "New File" button (toolbar), or right-clicks folder → "New File" (context menu), or presses keyboard shortcut
2. If a folder is selected/focused, auto-expand it and insert an inline input as the **first child** of that folder
3. If a file is selected, insert the inline input as a **sibling** (in the same parent folder)
4. If nothing is selected, insert at root level
5. **Enter** confirms → creates file/folder with that name
6. **Escape** cancels → removes the inline input
7. Clicking outside (blur) also confirms (VS Code behavior)

### Inline Rename
1. User right-clicks → "Rename", or presses F2 (keyboard shortcut)
2. The name text is replaced with an inline input pre-filled with the current name
3. Text is selected (so typing replaces it)
4. Same Enter/Escape/blur behavior as creation

### Keyboard Shortcuts (scoped to tree panel)
- **N** — New file (in focused folder or at root)
- **Shift+N** — New folder
- **F2** — Rename focused item
- **Delete** / **Backspace** — Delete focused item (with confirmation dialog—keep DeleteConfirmation.svelte)

### Context Menu
Already exists. Update actions to trigger inline inputs instead of dialogs.

## Changes

### 1. `fs-state.svelte.ts` — Add inline editing state
- `inlineCreate: { parentId: FileId | null; type: 'file' | 'folder' } | null`
- `renamingId: FileId | null`
- Actions: `startCreate(parentId, type)`, `confirmCreate(name)`, `cancelCreate()`, `startRename(id)`, `confirmRename(name)`, `cancelRename()`

### 2. New: `InlineNameInput.svelte`
- Tiny input that fits inline in the tree item row
- Handles Enter/Escape/blur
- Calls confirm/cancel actions
- Auto-focuses on mount

### 3. `FileTree.svelte` — Render inline create input & keyboard shortcuts
- After the children of a folder (or at root), render InlineNameInput when inlineCreate matches that location
- Add N, Shift+N, F2, Delete keyboard handlers

### 4. `FileTreeItem.svelte` — Inline rename support
- When `renamingId === id`, replace name span with InlineNameInput (pre-filled)
- Context menu actions call new state actions instead of opening dialogs

### 5. `Toolbar.svelte` — Remove dialog state, call inline actions
- "New File" → `fsState.actions.startCreate(parentId, 'file')`
- "New Folder" → `fsState.actions.startCreate(parentId, 'folder')`
- Remove CreateDialog and RenameDialog imports/instances

### 6. Delete `CreateDialog.svelte` and `RenameDialog.svelte`

## Todo

- [x] Add inline editing state and actions to `fs-state.svelte.ts`
- [x] Create `InlineNameInput.svelte` component
- [x] Update `FileTree.svelte` with inline create rendering + keyboard shortcuts
- [x] Update `FileTreeItem.svelte` with inline rename + update context menu actions
- [x] Update `Toolbar.svelte` to use inline actions instead of dialogs
- [x] Delete `CreateDialog.svelte` and `RenameDialog.svelte`
- [x] Verify everything works end-to-end (all diagnostics clean)

## Review

### What changed

**Deleted** (2 files):
- `CreateDialog.svelte` — Modal dialog for file/folder creation
- `RenameDialog.svelte` — Modal dialog for renaming

**Created** (1 file):
- `InlineNameInput.svelte` — ~68 lines. Small input component with Enter/Escape/blur handling, auto-focus, filename stem selection.

**Modified** (4 files):
- `fs-state.svelte.ts` — Added `inlineCreate` and `renamingId` state + 6 new actions (`startCreate`, `confirmCreate`, `cancelCreate`, `startRename`, `confirmRename`, `cancelRename`). All centralized, no duplication.
- `FileTree.svelte` — Renders inline create input at root level. Added keyboard shortcuts: N (new file), Shift+N (new folder), F2 (rename), Delete/Backspace (delete). Suppresses tree nav during inline editing.
- `FileTreeItem.svelte` — Renders inline rename (replacing name text) and inline create (inside folder children). Context menu now triggers inline actions with keyboard shortcut hints. Removed CreateDialog/RenameDialog imports.
- `Toolbar.svelte` — Buttons now call `fsState.actions.startCreate/startRename` directly. Removed all dialog state and imports.

### Net result
- **2 components deleted**, 1 created → net -1 component
- **Duplicated dialog state eliminated** (was in both Toolbar and every FileTreeItem)
- **N×3 hidden dialog instances removed** (every tree item was mounting CreateDialog + RenameDialog + DeleteConfirmation; now only DeleteConfirmation remains per-item)
- **Centralized editing state** in fs-state singleton — one source of truth
- **DeleteConfirmation stays** as a modal (correct—destructive actions need explicit confirmation)
