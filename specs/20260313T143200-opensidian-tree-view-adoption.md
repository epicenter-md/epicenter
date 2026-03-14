# OpenSidian Tree View Component Adoption

**Date**: 2026-03-13
**Status**: Implemented
**Author**: AI-assisted

## Overview

Evaluate whether to replace OpenSidian's custom `TreeNode.svelte` (177 lines) with the `TreeView` component from `shadcn-svelte-extras`, which is already configured as a registry in the UI package (`jsrepo.config.ts` → `@ieedan/shadcn-svelte-extras`).

## Motivation

### Current State

OpenSidian renders its file tree with two custom components:

**`FileTree.svelte`** (34 lines) — the root container:
```svelte
<div class="flex flex-col" role="tree">
  {#each fsState.rootChildIds as childId (childId)}
    <TreeNode id={childId} depth={0} />
  {/each}
</div>
```

**`TreeNode.svelte`** (177 lines) — recursive per-node rendering:
- Uses `Collapsible.Root` / `Collapsible.Trigger` / `Collapsible.Content` from `@epicenter/ui/collapsible`
- Inline SVG icons for chevron, folder, folder-open, file
- Depth-based left padding (`style="padding-left: {depth * 16}px"`)
- Click handler: toggles expansion for folders, selects files
- Keyboard handler: Enter/Space
- Context menu via `ContextMenu.Root` with New File, New Folder, Rename, Delete
- Integrates `CreateDialog`, `RenameDialog`, `DeleteConfirmation` directly

This works. The question is whether the extras Tree View component provides enough value to justify the migration.

### shadcn-svelte-extras Tree View

The extras package provides `TreeView` with three components:

- **`TreeView.Root`** — flex column container (equivalent to `FileTree.svelte`)
- **`TreeView.Folder`** — uses Collapsible internally (equivalent to TreeNode's folder path)
- **`TreeView.File`** — button with icon slot (equivalent to TreeNode's file path)

**API surface** (from `tree-view-folder.svelte`):
```svelte
<Collapsible.Root bind:open>
  <Collapsible.Trigger>
    <!-- folder icon + name -->
  </Collapsible.Trigger>
  <Collapsible.Content>
    <!-- children (recursive) -->
  </Collapsible.Content>
</Collapsible.Root>
```

This is structurally identical to what TreeNode already does manually.

## Research Findings

### What TreeView Provides vs What OpenSidian Needs

| Capability | TreeView (extras) | Current TreeNode | Gap |
|---|---|---|---|
| Folder expand/collapse | ✅ Collapsible internally | ✅ Collapsible manually | None |
| File rendering | ✅ Button with icon | ✅ Button with inline SVG | None |
| Depth indentation | ✅ CSS nesting | ✅ Manual padding-left | Minor difference |
| Selection state | ❌ Not built-in | ✅ `fsState.activeFileId` comparison | **TreeView lacks this** |
| Context menu | ❌ Not built-in | ✅ Integrated ContextMenu | **TreeView lacks this** |
| Keyboard nav (arrow keys) | ❌ Not built-in | ❌ Only Enter/Space | Neither has it |
| CRUD actions | ❌ Not built-in | ✅ Create/Rename/Delete dialogs | **TreeView lacks this** |
| Data binding | ❌ Static props only | ✅ Reactive fsState integration | **TreeView lacks this** |
| Accessibility (`role`) | Partial | ✅ `role="tree"` / `role="treeitem"` | TreeNode is better |

**Key finding**: The extras Tree View is a thin wrapper around Collapsible with folder/file semantics. It provides structural correctness (the right nesting pattern) but not the interactive features OpenSidian needs (selection, context menus, CRUD, reactive data binding).

### What Migration Would Look Like

To adopt TreeView, you'd:

1. Install `tree-view` via `bunx jsrepo add tree-view` into `packages/ui/`
2. Replace `FileTree.svelte`'s root div with `<TreeView.Root>`
3. Split `TreeNode.svelte` into a wrapper that renders `<TreeView.Folder>` or `<TreeView.File>`
4. **Still need custom logic for**: selection highlighting, context menu integration, depth-aware CRUD dialog triggers, reactive fsState binding

The wrapper component would still be ~100+ lines because all the OpenSidian-specific behavior (selection, context menus, CRUD) lives outside what TreeView provides.

### Honest Assessment

The extras Tree View gives you:
- **Correct HTML structure** (proper nesting of collapsible containers)
- **Consistent styling** (matches other shadcn-svelte-extras components)
- **Upstream updates** (if the component improves, you get it for free)

But it doesn't give you:
- Selection management
- Context menus
- Keyboard navigation
- Any data-binding patterns
- CRUD integration

OpenSidian's TreeNode already handles all of these. The Tree View component would replace maybe 40% of TreeNode's code (the structural rendering), while the other 60% (behavior, state, interactions) would remain custom.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Adopt TreeView? | **Recommended: Yes, with caveats** | Aligns with design system conventions; reduces structural code even if behavior stays custom |
| Migration scope | Structural only | Replace HTML structure and Collapsible wiring; keep all behavior/state logic |
| Selection state | Custom data attribute | Add `data-selected` to TreeView.File/Folder; style via Tailwind `data-[selected]:bg-accent` |
| Context menus | Wrap TreeView nodes | `<ContextMenu.Root><TreeView.File>...</TreeView.File></ContextMenu.Root>` |
| When to migrate | After UI Idiomaticity spec | Icons and inputs should be fixed first; tree view migration builds on those |

## Architecture

### Before (Current)

```
FileTree.svelte
  └── TreeNode.svelte (recursive)
        ├── Collapsible.Root/Trigger/Content (manual)
        ├── Inline SVG icons (manual)
        ├── Selection logic (manual)
        ├── ContextMenu (manual)
        └── CRUD Dialogs (manual)
```

### After (Proposed)

```
FileTree.svelte
  └── TreeView.Root (from extras)
        └── FileTreeItem.svelte (custom wrapper, recursive)
              ├── TreeView.Folder (from extras) — structural
              │     └── Collapsible handled internally
              ├── TreeView.File (from extras) — structural
              ├── Lucide icons (from idiomaticity spec)
              ├── Selection logic (custom)
              ├── ContextMenu (custom)
              └── CRUD Dialogs (custom)
```

The net effect: `TreeNode.svelte` (177 lines) becomes `FileTreeItem.svelte` (~120 lines). You lose ~50 lines of structural Collapsible boilerplate but keep all behavior. The win is alignment with the design system, not line count reduction.

## Implementation Plan

### Phase 1: Install and Prototype

- [x] **1.1** Install tree-view component: `bunx jsrepo add tree-view` in `packages/ui/`
- [x] **1.2** Export from `@epicenter/ui/tree-view`
  > jsrepo auto-handled the exports. Also customized tree-view-folder.svelte to add `onOpenChange` + `style` forwarding.
- [x] **1.3** Create `FileTreeItem.svelte` as a new wrapper component
- [x] **1.4** Render `<TreeView.Folder>` for folders, `<TreeView.File>` for files
- [x] **1.5** Verify expand/collapse works identically to current behavior

### Phase 2: Migrate Behavior

- [x] **2.1** Wire selection state via data attribute or class binding
  > Used class binding with `isSelected ? 'bg-accent text-accent-foreground' : ''` (same as original).
- [x] **2.2** Wrap nodes with `ContextMenu.Root` for right-click actions
- [x] **2.3** Attach CRUD dialog triggers (CreateDialog, RenameDialog, DeleteConfirmation)
- [x] **2.4** Verify all keyboard interactions (Enter/Space) still work
- [x] **2.5** Remove old `TreeNode.svelte` once `FileTreeItem.svelte` is verified

### Phase 3: Polish

- [x] **3.1** Ensure depth indentation matches current visual (TreeView may use CSS nesting vs manual padding)
  > Removed tree-line styling from Collapsible.Content; kept manual `padding-left` approach matching original.
- [x] **3.2** Verify accessibility attributes (`role="tree"`, `role="treeitem"`, `aria-expanded`)
  > `role="tree"` on TreeView.Root, `role="treeitem"` + `aria-expanded` on wrapper divs/buttons.
- [ ] **3.3** Test with screen reader to confirm no accessibility regressions

## Edge Cases

### TreeView Styling Conflicts

1. The extras TreeView applies its own Tailwind classes for spacing and hover
2. OpenSidian's current TreeNode also applies hover/focus classes
3. Merging may cause double-styling. Need to audit and remove redundant classes.

### Controlled vs Uncontrolled Expansion

1. Current TreeNode uses `fsState.expandedIds` to control which folders are open
2. TreeView.Folder has its own `open` prop bound to Collapsible.Root
3. Must ensure `open` is bound to `fsState.expandedIds.has(id)` and `onOpenChange` calls `fsState.actions.toggleExpand(id)`

## Open Questions

1. **Is the code reduction worth the migration cost?**
   - The structural win is ~50 lines (Collapsible boilerplate). The total component stays ~120 lines.
   - **Recommendation**: Yes, but primarily for design system alignment, not line count. Being on the standard Tree View means upstream improvements (keyboard navigation, accessibility) benefit OpenSidian automatically.

2. **Should we wait for the extras Tree View to add selection/keyboard nav?**
   - The extras Tree View is young. It may gain selection and keyboard navigation later.
   - **Recommendation**: Don't wait. Adopt now with custom selection logic. If extras adds selection later, refactor to use it.

3. **Should the `FileTreeItem` wrapper live in OpenSidian or in `@epicenter/ui`?**
   - Options: (a) `apps/opensidian/src/lib/components/FileTreeItem.svelte`, (b) `packages/ui/src/file-tree/`
   - **Recommendation**: (a) — it's OpenSidian-specific (binds to `fsState`). If other apps need a file tree, extract then.

## Success Criteria

- [x] File tree renders identically to current implementation (visual diff)
- [x] Expand/collapse, selection, context menu, CRUD all function identically
- [x] `TreeNode.svelte` is deleted; replaced by `FileTreeItem.svelte` using TreeView primitives
- [x] TreeView component installed in `@epicenter/ui/tree-view`
- [x] `svelte-check` passes with no new errors (67 pre-existing, 0 new)
- [x] Accessibility roles preserved (`role="tree"`, `role="treeitem"`, `aria-expanded`)

## References

- `apps/opensidian/src/lib/components/TreeNode.svelte` — current implementation (177 lines)
- `apps/opensidian/src/lib/components/FileTree.svelte` — current root container (34 lines)
- `packages/ui/jsrepo.config.ts` — configured for `@ieedan/shadcn-svelte-extras`
- `packages/ui/src/collapsible/` — Collapsible primitives (already used)
- `packages/ui/src/context-menu/` — ContextMenu primitives (already used)
- shadcn-svelte-extras Tree View source: https://github.com/ieedan/shadcn-svelte-extras/tree/main/src/lib/components/ui/tree-view
- shadcn-svelte-extras Tree View docs: https://shadcn-svelte-extras.com/components/tree-view

## Review

**Completed**: 2026-03-13

### Summary

Replaced OpenSidian's custom `TreeNode.svelte` (140 lines) with `FileTreeItem.svelte` (128 lines) backed by `TreeView.Folder` and `TreeView.File` from shadcn-svelte-extras. The installed tree-view component was customized to support controlled open state (`onOpenChange` forwarded to Collapsible.Root) and style forwarding for depth-based indentation.

### Changes Made

1. **Installed tree-view** via `bunx jsrepo add tree-view` in `packages/ui/`
2. **Customized `tree-view-folder.svelte`**: Added `onOpenChange` and `style` props; removed tree-line nesting from `Collapsible.Content` to match OpenSidian's padding-based indentation
3. **Updated `types.ts`**: Extended `TreeViewFolderProps` with `onOpenChange` and `style`
4. **Modified `tree-view.svelte`**: Added `...rest` forwarding so `role="tree"` can be passed
5. **Created `FileTreeItem.svelte`**: New recursive wrapper using TreeView.Folder/File with all existing behavior (selection, context menu, CRUD dialogs, keyboard handlers)
6. **Updated `FileTree.svelte`**: Replaced `<div>` + `<TreeNode>` with `<TreeView.Root>` + `<FileTreeItem>`
7. **Deleted `TreeNode.svelte`**

### Deviations from Spec

- TreeView.Folder lacked an `onOpenChange` prop—added it to the local copy to support controlled expansion via `fsState.expandedIds`
- `role="treeitem"` and `aria-expanded` placed on the ContextMenu wrapper `<div>` for folders (instead of on TreeView.Folder's trigger) to avoid type conflicts with Collapsible.Trigger's prop types
- Removed tree-line visual styling (`border-l` + vertical line) from the installed component to match the existing padding-based indentation exactly

### Follow-up Work

- Screen reader testing (spec item 3.3 left unchecked)
- Monitor shadcn-svelte-extras for upstream tree-view improvements (keyboard navigation, selection)
