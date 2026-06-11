# Browser State Simplification

**Date**: 2026-02-13
**Status**: Obsolete (target file deleted)
**File**: `apps/tab-manager/src/lib/browser-state.svelte.ts`

> **Note (2026-02-14):** `browser-state.svelte.ts` no longer exists. The code this spec targeted was removed during prior refactoring. Nothing to do.

## Problem

`createBrowserState()` stores browser state as two disconnected flat collections:

- `tabs`: `SvelteMap<number, Tab>`: all tabs across all windows
- `windows`: `$state<Window[]>`: all windows

This is a tree (windows → tabs) modeled as two flat lists. Every access pattern reconstructs the tree:

| Access Pattern       | Current Cost                                                            |
| -------------------- | ----------------------------------------------------------------------- |
| `tabsByWindow(id)`   | Filter ALL tabs + sort. Called per window in render = O(windows × tabs) |
| `onActivated`        | Iterate ALL tabs to find old active tab in same window                  |
| `onRemoved` (window) | `findIndex` on array + iterate ALL tabs to delete orphans               |
| `onFocusChanged`     | `findIndex` on array for focus target                                   |

The data structures are also asymmetric for no reason (SvelteMap vs $state array).

## Consumer Audit

Only 2 files consume `browserState`:

| File             | Accessors                                            |
| ---------------- | ---------------------------------------------------- |
| `TabList.svelte` | `.windows` (iterate, `.length`), `.tabsByWindow(id)` |
| `TabItem.svelte` | `.actions.*` (all 8 methods)                         |

**Unused API**: `seeded` getter, `tabs` flat getter: zero references.

## Solution

Replace both collections with a single `SvelteMap<WindowCompositeId, WindowState>`:

```typescript
type WindowState = {
	window: Window;
	tabs: SvelteMap<number, Tab>;
};

const windowStates = new SvelteMap<WindowCompositeId, WindowState>();
```

### SvelteMap Nested Reactivity (confirmed)

Inner `SvelteMap` mutations trigger subscribers who read from the inner map directly. In Svelte templates, `{#each}` over the outer map's values establishes subscriptions to each inner SvelteMap's version signal. This gives per-window reactive granularity: better than the current design where any tab change re-filters everything.

### Event Handler Changes

| Event                | Before                                              | After                                                          |
| -------------------- | --------------------------------------------------- | -------------------------------------------------------------- |
| `tabsByWindow()`     | Filter all tabs + sort                              | Direct map lookup + sort                                       |
| `onCreated` (tab)    | `tabs.set(id, row)`                                 | `windowStates.get(windowId).tabs.set(id, row)`                 |
| `onRemoved` (tab)    | `tabs.delete(id)`: scans nothing but uses flat map | Use `removeInfo.windowId` for direct window lookup             |
| `onUpdated`          | `tabs.set(id, row)`                                 | Route to correct window's inner map                            |
| `onMoved`            | Re-query + `tabs.set`                               | Re-query + route to window                                     |
| `onActivated`        | Iterate ALL tabs to deactivate                      | Iterate only that window's tabs                                |
| `onAttached`         | Re-query + `tabs.set`                               | Re-query + add to new window's map                             |
| `onDetached`         | Re-query + `tabs.set`                               | Remove from old window's map (using `detachInfo.oldWindowId`)  |
| `onCreated` (window) | `windows.push(row)`                                 | `windowStates.set(id, { window: row, tabs: new SvelteMap() })` |
| `onRemoved` (window) | `findIndex` + splice + iterate all tabs             | `windowStates.delete(id)`: one line                           |
| `onFocusChanged`     | Iterate array + findIndex                           | Iterate values + direct `.get()`                               |

### Public API (identical shape for consumers)

```typescript
return {
	get windows() {
		return [...windowStates.values()].map((s) => s.window);
	},
	tabsByWindow(windowId: WindowCompositeId): Tab[] {
		const state = windowStates.get(windowId);
		if (!state) return [];
		return [...state.tabs.values()].sort((a, b) => a.index - b.index);
	},
	actions: {
		/* all 8 methods unchanged */
	},
};
```

### Dropped

- `seeded` getter (unused)
- `tabs` flat getter (unused)
- `ready` flag (replaced by `!deviceId` guard)

## What Does NOT Change

- `actions` object: pure browser API calls, no state reads
- Import/export structure
- `TabList.svelte` and `TabItem.svelte`: same public API shape
- `browser.schema.ts`: no changes needed

## Checklist

- [ ] Rewrite `browser-state.svelte.ts` with coupled `WindowState`
- [ ] Verify typecheck passes for `apps/tab-manager`
- [ ] Verify `TabList.svelte` and `TabItem.svelte` unchanged

## Review

Implemented as planned. Single `SvelteMap<WindowCompositeId, WindowState>` replaces both the flat `SvelteMap<number, Tab>` and `$state<Window[]>`.

Key changes:

- **Seed**: Builds `WindowState` entries directly with nested tab maps
- **`onRemoved` (tab)**: Uses `removeInfo.windowId` for direct window lookup; skips if `isWindowClosing`
- **`onActivated`**: Scoped to one window's tabs instead of scanning all tabs
- **`onRemoved` (window)**: Single `windowStates.delete()`: tabs removed with it
- **`onDetached`**: Removes tab from old window using `detachInfo.oldWindowId` (no re-query)
- **`onFocusChanged`**: Uses `windowStates.set()` to trigger outer map reactivity
- **Dropped**: `seeded`, `tabs` flat getter, `ready` flag (replaced by `!deviceId` guard)

Public API unchanged. TabList.svelte and TabItem.svelte require zero modifications.

Typecheck: 0 errors from changed files. 23 pre-existing errors in `packages/ui` (unrelated `#/utils.js` module resolution).
