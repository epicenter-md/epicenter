# Sync Status Indicator Redesign

## Problem

The current sync status indicator is a permanent `<footer>` bar at the bottom of the tab manager sidepanel showing a green dot + "Connected" text. This has three problems:

1. **Wasted space**: 30px of permanent vertical real estate in a space-constrained sidepanel for information the user almost never needs
2. **Wrong information priority**: "Connected" is the default assumption; users only care when something is wrong or in progress
3. **No progressive disclosure**: no way to get more details (last synced time, retry action, etc.)

## Solution

Replace the permanent footer bar with a **compact header icon** using the Google Docs cloud-icon pattern. The icon lives in the header next to "Tab Manager", uses Tooltip for hover details, and Popover for click-to-expand with sync details.

### Design

```
┌─────────────────────────────────────┐
│ Tab Manager                    ☁️   │  ← cloud icon, right-aligned
│ [Tabs 5] [Saved 7] [✨ AI]         │
│ ...full content area...             │
│                                     │  ← no footer anymore
└─────────────────────────────────────┘
```

### States

| State | Icon | Color | Tooltip | Behavior |
|---|---|---|---|---|
| `connected` | Cloud | `text-muted-foreground` (subtle gray) | "Connected" | Quiet, nearly invisible |
| `connecting` | LoaderCircle | `text-muted-foreground` | "Connecting…" | Spinning animation via `animate-spin` |
| `offline` | CloudOff | `text-destructive` | "Offline" | Red, clearly noticeable |

### Component Composition

- **Tooltip** wraps the icon for hover details (uses existing `@epicenter/ui/tooltip`, already provided via `Tooltip.Provider` in App.svelte)
- **Popover** on click shows expanded details (connected device count, "Last synced" timestamp placeholder, etc.): optional stretch goal
- **Lucide icons**: `Cloud`, `CloudOff`, `LoaderCircle` (all from `@lucide/svelte/icons/*`)

### Files Changed

1. **`SyncStatusIndicator.svelte`**: Rewrite to icon-based component with Tooltip
2. **`App.svelte`**: Move indicator from footer into header, delete footer

## Implementation Plan

- [x] 1. Rewrite `SyncStatusIndicator.svelte`: Replace dot+text with icon+tooltip. Keep the existing `createSyncStatus()` module-level singleton (it works well). Use `Cloud`/`CloudOff`/`LoaderCircle` icons from Lucide. Wrap in `Tooltip.Root` > `Tooltip.Trigger` > `Tooltip.Content`.
- [x] 2. Update `App.svelte`: Move `<SyncStatusIndicator />` from footer into the header, right-aligned next to "Tab Manager" title. Delete the entire `<footer>` block.
- [x] 3. Verify: Check LSP diagnostics on both files. Visual sanity check that the icon is properly positioned.

## Future Enhancements (not in scope)

- **`hasLocalChanges`**: When implemented in `@epicenter/sync-client`, add "Saving…" / "Saved" states (the most useful signal)
- **Popover on click**: Show expanded sync details, connected devices, "Sync Now" button
- **Toast on disconnect**: Use Sonner to show a transient notification when connection drops

## Review

### Changes Made

**`SyncStatusIndicator.svelte`**: Full rewrite of the template. The `<script module>` block with `createSyncStatus()` singleton is unchanged. Replaced the dot+text `<div>` with a `Tooltip.Root` > `Tooltip.Trigger` (using `child` snippet pattern matching `TabItem.svelte`) > `Tooltip.Content`. Icon selection uses `{#if}`/`{:else if}`/`{:else}` for `Cloud` (connected), `LoaderCircle` with `animate-spin` (connecting), and `CloudOff` with `text-destructive` (offline). The trigger is a `<button>` with hover styles (`hover:bg-accent`) for future popover support.

**`App.svelte`**: Moved `<SyncStatusIndicator />` from the `<footer>` into the `<header>`, wrapped in a `flex justify-between` div alongside the "Tab Manager" title. Deleted the entire `<footer>` block, reclaiming ~30px of vertical space.

### Verification

- `bun typecheck --filter=@epicenter/tab-manager`: 0 errors in changed files (90 pre-existing `#/utils.js` errors in `@epicenter/ui` unrelated to this change).
