# OpenSidian Toolbar Redesign

**Date**: 2026-04-07
**Status**: Draft
**Author**: AI-assisted

## Overview

Remove the overloaded global toolbar from OpenSidian and redistribute its actions to where they belong: file operations to a sidebar header, AI Chat toggle to the status bar, account to the tab bar area, and one-time actions to contextual locations.

## Motivation

### Current State

The toolbar is a single `<div>` row that mixes four unrelated concerns:

```
┌─────────────────────────────────────────────────────────────┐
│ New File  New Folder │ Rename  Delete    AI Chat  About ☁  Load │
└─────────────────────────────────────────────────────────────┘
```

This creates problems:

1. **File operations in the wrong place**: Every established editor (VS Code, StackBlitz, CodeSandbox, Zed) puts file creation in the sidebar header or context menu. Never in a global top bar. Rename/Delete are already duplicated in the context menu and keyboard shortcuts (`F2`, `Delete`/`Backspace`), making the toolbar buttons redundant and potentially confusing (they operate on `activeFileId`, which may differ from the right-clicked item).
2. **One-time action permanently visible**: "Load Sample Data" occupies toolbar space at all times for a one-time onboarding action. The empty state already says "No files yet" but lacks its own CTA.
3. **Cloud icon is ambiguous**: The cloud icon communicates sync status, not account. New users won't know it's a sign-in button.
4. **About navigates away**: Every other toolbar button is an in-page action; "About" navigates to `/about`, which is jarring in an editor context.
5. **No sidebar header**: The file tree has no title or scoped action buttons, unlike every comparable editor.

### Desired State

```
┌──────────────────┬────────────────────────────────────────────────┐
│ FILES    🔍 📁 📄 │  [tab] [tab] [tab]                        👤  │
├──────────────────┤                                                │
│  📄 A.ts          │  /docs/api.md                                  │
│  📁 docs          │                                                │
│  📁 src           │  [CodeMirror editor]                           │
│  📄 README.md     │                                                │
│                   │                                                │
│  (right-click for │                                                │
│   rename/delete)  │                                                │
├──────────────────┴────────────────────────────────────────────────┤
│ Ln 1, Col 0  0 words  1 lines         💬 AI Chat   VIM  ⚙       │
└───────────────────────────────────────────────────────────────────┘
```

No global toolbar. File operations scoped to the sidebar. AI Chat toggle in the status bar (like Zed's ✨ icon). Account in the tab bar chrome.

## Research Findings

### AI Chat Toggle Placement in Comparable Editors

| App | Icon | Placement | Type |
|-----|------|-----------|------|
| Zed | ✨ sparkle | **Status bar** | Icon button |
| Cursor | (removed in v2.3) | Keyboard-only (⌘⌥B) | Shortcut + gear layout |
| VS Code Copilot | Chat icon | Activity bar (icon rail) | Sidebar icon |
| Windsurf | Windsurf icon | Left sidebar (draggable) | Sidebar panel |
| Obsidian Copilot | Chat icon | Left ribbon → opens right panel | Ribbon icon |
| Notion AI | AI face icon | Bottom-right + sidebar | Floating + sidebar |

**Key finding**: No consensus. Status bar (Zed) and sidebar icon rail (VS Code) are the two dominant patterns. Since OpenSidian only has two sidebar views (files, search): not enough to justify an activity rail. The status bar is the better fit.

**Oracle recommendation**: Status bar with icon + tooltip showing `⌘⇧L`. Consider adding a text label ("AI Chat") beside the icon for discoverability, since AI is a marquee feature.

### Account Button Placement

**Oracle recommendation**: Account belongs in the top-right app chrome, not the status bar. Identity is app-level state, not editor status. Placing it at the right end of the tab bar area is the cleanest approach.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Remove global toolbar | Yes | It's a junk drawer mixing 4 unrelated concerns |
| File ops (New File/Folder) | Sidebar header icon buttons | Standard pattern in VS Code, StackBlitz, CodeSandbox |
| Rename/Delete from toolbar | Remove entirely | Already in context menu + keyboard shortcuts (F2, Delete). Three paths to one action is two too many. |
| AI Chat toggle | Status bar (icon + text label) | Matches Zed pattern. Panel toggle behavior belongs with other panel controls. |
| Account button | Right end of tab bar area | Identity is app-level chrome, not a status indicator |
| About link | Move to settings popover | One-time informational link doesn't need permanent toolbar space |
| Load Sample Data | Move to empty state | One-time onboarding action belongs where it's contextually relevant |
| Activity rail | Skip for now | Only 2 sidebar views (files, search). Revisit at 3+ persistent views. |
| Cloud icon → User icon | Replace | Cloud communicates sync, not identity. Use User/LogIn icon when signed out, avatar when signed in. |

## Architecture

### Component Changes

```
DELETED:
  Toolbar.svelte          → remove entirely (loadSampleData logic moves)

MODIFIED:
  AppShell.svelte         → remove <Toolbar>, restructure layout
  StatusBar.svelte        → add AI Chat toggle button
  TabBar.svelte           → add AccountPopover to right end
  FileTree.svelte         → add sidebar header with title + action icons
  AccountPopover.svelte   → replace Cloud icon with User icon

NEW:
  SidebarHeader.svelte    → "FILES" label + search + new folder + new file icon buttons
```

### Layout Flow

```
BEFORE:
  <div class="flex h-screen flex-col">
    <Toolbar />                    ← REMOVE
    <Resizable.PaneGroup>
      <Pane> sidebar </Pane>
      <Pane> editor </Pane>
      <Pane?> chat </Pane?>
    </Resizable.PaneGroup>
    <StatusBar />
  </div>

AFTER:
  <div class="flex h-screen flex-col">
    <Resizable.PaneGroup>          ← full height now
      <Pane>
        <SidebarHeader />          ← NEW: FILES + icons
        <ScrollArea> FileTree </ScrollArea>
      </Pane>
      <Pane>
        <TabBar />                 ← now includes AccountPopover at right end
        <ContentPanel />
      </Pane>
      <Pane?> chat </Pane?>
    </Resizable.PaneGroup>
    <StatusBar />                  ← now includes AI Chat toggle
  </div>
```

## Implementation Plan

### Phase 1: Create SidebarHeader Component

- [ ] **1.1** Create `SidebarHeader.svelte` with "FILES" label + New File icon button + New Folder icon button + Search toggle icon button
- [ ] **1.2** Wire New File/New Folder buttons to `fsState.startCreate('file'|'folder')`
- [ ] **1.3** Wire Search button to `sidebarSearchState.openSearch()` / `closeSearch()`
- [ ] **1.4** Integrate SidebarHeader into AppShell above the ScrollArea/SearchPanel

### Phase 2: Move AI Chat Toggle to StatusBar

- [ ] **2.1** Add AI Chat toggle button to StatusBar (icon + "AI Chat" text label + tooltip with ⌘⇧L)
- [ ] **2.2** Lift `chatOpen` state so StatusBar can toggle it (bind from AppShell)

### Phase 3: Move Account to TabBar

- [ ] **3.1** Add AccountPopover to the right end of TabBar
- [ ] **3.2** Replace Cloud/CloudOff icons with User/LogIn icon (signed out) vs User icon with indicator (signed in)
- [ ] **3.3** Ensure account button shows even when no tabs are open (TabBar should always render its right-end utility area)

### Phase 4: Move Load Sample Data to Empty State

- [ ] **4.1** Move `loadSampleData` logic from Toolbar to a shared utility or the empty state component
- [ ] **4.2** Add "Load Sample Data" button to the FileTree empty state
- [ ] **4.3** Add "Load Sample Data" button to the ContentPanel empty state (the "No file selected" view)

### Phase 5: Move About to Settings & Delete Toolbar

- [ ] **5.1** Add "About" link to the StatusBar settings popover
- [ ] **5.2** Delete `Toolbar.svelte`
- [ ] **5.3** Remove Toolbar import and usage from AppShell

### Phase 6: Verify & Clean Up

- [ ] **6.1** Run `lsp_diagnostics` on all changed files
- [ ] **6.2** Run `bun run typecheck` in apps/opensidian
- [ ] **6.3** Manual smoke test: verify all actions still work (new file, new folder, rename via context menu, delete via context menu, AI chat toggle, account popover, load sample data from empty state, about from settings, keyboard shortcuts)

## Edge Cases

### Empty State with No Files

1. User visits for the first time, no files exist
2. FileTree shows empty state with "Load Sample Data" button
3. ContentPanel shows "No file selected" with secondary "Load Sample Data" button
4. After loading, both empty states disappear automatically

### Tab Bar with No Open Files

1. No files are open, tab bar would be empty
2. AccountPopover still renders at the right end
3. TabBar renders as a minimal strip with just the account button

### Search View Active

1. User is in search view (⌘⇧F), sidebar shows SearchPanel instead of FileTree
2. SidebarHeader should indicate search is active (highlight search icon, change title to "SEARCH")
3. New File/New Folder buttons remain functional (they create at root level)

## Open Questions

1. **Should SidebarHeader change its title when in search view?**
   - Options: (a) Always show "FILES" with search icon highlighted, (b) Switch to "SEARCH" when search is active, (c) Show both icons but highlight active one
   - **Recommendation**: (c): Keep "FILES" as the label but visually indicate which view is active via the icon state. Simple, no text switching.

2. **Should we add a visible terminal toggle to the status bar too?**
   - Currently terminal is keyboard-only (⌘\`). If we add AI Chat to status bar, the asymmetry might feel odd.
   - **Recommendation**: Add terminal toggle icon to status bar for consistency. Small effort, big coherence win. But defer to Phase 2 if scope creep is a concern.

## Success Criteria

- [ ] Global toolbar is deleted. No horizontal bar above the editor
- [ ] New File and New Folder are accessible from the sidebar header
- [ ] Rename and Delete work exclusively through context menu and keyboard shortcuts
- [ ] AI Chat toggles from the status bar
- [ ] Account popover lives in the tab bar area
- [ ] Load Sample Data appears in empty states only
- [ ] About is accessible from the settings popover
- [ ] All existing keyboard shortcuts still work (⌘⇧L, ⌘⇧F, ⌘\`, N, ⇧N, F2, Delete)
- [ ] No TypeScript errors on changed files

## References

- `apps/opensidian/src/lib/components/Toolbar.svelte`: being deleted
- `apps/opensidian/src/lib/components/AppShell.svelte`: main layout, restructuring
- `apps/opensidian/src/lib/components/editor/StatusBar.svelte`: adding AI Chat toggle
- `apps/opensidian/src/lib/components/editor/TabBar.svelte`: adding AccountPopover
- `apps/opensidian/src/lib/components/tree/FileTree.svelte`: empty state enhancement
- `apps/opensidian/src/lib/components/tree/FileTreeItem.svelte`: context menu (already has rename/delete, no changes needed)
- `apps/opensidian/src/lib/components/AccountPopover.svelte`: icon replacement
- `apps/opensidian/src/lib/components/editor/ContentPanel.svelte`: empty state enhancement
- `packages/ui/src/`: available UI components (button, popover, tooltip, separator, etc.)
