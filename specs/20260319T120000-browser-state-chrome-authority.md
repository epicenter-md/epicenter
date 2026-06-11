# Browser State: Chrome as Sole Authority

## Motivation

`browser-state.svelte.ts` is 690 lines because it maintains two parallel stores (SvelteMap + Y.Doc) for live browser tabs. Every event handler dual-writes to both. Y.Doc observers watch for remote changes and call Chrome APIs to materialize remote tabs locally, creating circular data flows that require echo detection via time-based heuristics.

**The core insight:** live browser tabs don't need CRDT persistence. Chrome IS the authority for its own state. The panel reads from Chrome on open, receives surgical updates via browser events, and dies on close. Only user-created data (saved tabs, bookmarks, chat) needs Y.Doc for cross-device sync.

## Current Architecture (what exists)

```
Chrome ──events──► SvelteMap ──► UI
         │              │
         └──────► Y.Doc ◄──────┘    ← unnecessary for live tabs
                    │
              sync to remotes
                    │
              observer fires
                    │
              Chrome API calls       ← remote device opens tabs on YOUR browser
                    │
              echo detection...      ← 5s setTimeout heuristic to break cycle
```

### Files involved

| File | Role | Y.Doc usage |
|---|---|---|
| `src/lib/state/browser-state.svelte.ts` | Live browser state | Writes to `tables.tabs`, `tables.windows`, `tables.tabGroups`, `tables.devices`; observers call Chrome APIs |
| `src/lib/sync/row-converters.ts` | Chrome → Y.Doc row mappers | `tabToRow`, `windowToRow`, `tabGroupToRow` |
| `src/lib/workspace.ts` | Table definitions | Defines `tabsTable`, `windowsTable`, `tabGroupsTable`; composite ID helpers |
| `src/entrypoints/sidepanel/App.svelte` | UI entrypoint | `{#await browserState.whenReady}` |
| `src/lib/state/unified-view-state.svelte.ts` | View composition | Reads `browserState.windows`, `browserState.tabsByWindow()` |
| `src/lib/components/tabs/UnifiedTabList.svelte` | Tab list UI | Reads `browserState` |
| `src/lib/components/tabs/TabItem.svelte` | Tab item UI | Reads `browserState` actions |
| `src/lib/components/command-palette/items.ts` | Command palette | Reads `browserState` for tab listing |

### What stays Y.Doc-backed (NO CHANGES)

| Module | Table | Why |
|---|---|---|
| `saved-tab-state.svelte.ts` | `tables.savedTabs` | User-created data, cross-device sync |
| `bookmark-state.svelte.ts` | `tables.bookmarks` | User-created data, cross-device sync |
| `chat-state.svelte.ts` | `tables.conversations`, `tables.chatMessages` | User-created data |
| `tool-trust.svelte.ts` | `tables.toolTrust` | User preferences |

## Target Architecture

```
LIVE TABS (ephemeral, Chrome is authority)
──────────────────────────────────────────

  Chrome ──events──► SvelteMap ──► UI
                     (sole store)
                     dies on panel close
                     re-seeds on panel open
                     NO Y.Doc


SAVED TABS / BOOKMARKS (persistent, Y.Doc is authority)
───────────────────────────────────────────────────────

  User action ──► Y.Doc table ──► derived SvelteMap ──► UI
                       │
                  sync to remotes
```

### What changes

The public API of `browserState` stays identical. Consumers (App.svelte, UnifiedTabList, TabItem, command-palette, unified-view-state) don't change at all. The internal implementation shrinks dramatically.

## Detailed Changes

### 1. `browser-state.svelte.ts`: Rewrite (690 → ~200 lines)

**Remove:**
- ALL `tables.*` imports and usage
- ALL `workspaceClient` usage (batch, whenReady for Y.Doc)
- ALL Y.Doc seed logic (the diff against existing rows, prune stale entries)
- ALL Y.Doc observers (`_unobserveTabs`, `_unobserveWindows`, `_unobserveTabGroups`)
- ALL `// Y.Doc write` lines in event handlers
- `recentlyAddedTabIds` echo detection (no more echoes without Y.Doc)
- `row-converters` imports (`tabToRow`, `windowToRow`, `tabGroupToRow`)
- Composite ID imports (`createTabCompositeId`, `createWindowCompositeId`, `createGroupCompositeId`, parse helpers)
- Device registration (`tables.devices.set(...)`, `getDeviceId`, `generateDefaultDeviceName`, `getBrowserName`)

**Keep:**
- `SvelteMap<number, WindowState>`: keyed by Chrome's native `windowId` (no more composite IDs needed)
- `whenReady` promise: still gates UI, but now only awaits `browser.windows.getAll()`
- All browser event listeners: but they only write to SvelteMap
- All action methods (`close`, `activate`, `pin`, `unpin`, `mute`, `unmute`, `reload`, `duplicate`)
- The public API shape (`whenReady`, `windows`, `tabsByWindow`, actions)

**New internal types:**

```typescript
type WindowState = {
  window: BrowserWindow;
  tabs: SvelteMap<number, BrowserTab>;
};

type BrowserWindow = {
  windowId: number;
  focused: boolean;
  incognito: boolean;
  type: string;
};

type BrowserTab = {
  tabId: number;
  windowId: number;
  index: number;
  title: string;
  url: string;
  favIconUrl: string;
  active: boolean;
  pinned: boolean;
  audible: boolean;
  mutedInfo: { muted: boolean };
  groupId: number;
  openerTabId?: number;
  status: string;
};
```

These are plain objects derived from Chrome's tab/window objects. No composite IDs, no device scoping, no `_v` version field. Just what the UI needs.

**New `createBrowserState()` structure:**

```typescript
function createBrowserState() {
  const windowStates = new SvelteMap<number, WindowState>();

  const whenReady = (async () => {
    const browserWindows = await browser.windows.getAll({ populate: true });
    for (const win of browserWindows) {
      // Map Chrome window+tabs to plain objects, populate SvelteMap
    }
  })();

  // Event listeners: SvelteMap writes only
  browser.tabs.onCreated.addListener(...)
  browser.tabs.onRemoved.addListener(...)
  browser.tabs.onUpdated.addListener(...)
  browser.tabs.onMoved.addListener(...)
  browser.tabs.onActivated.addListener(...)
  browser.tabs.onAttached.addListener(...)
  browser.tabs.onDetached.addListener(...)
  browser.windows.onCreated.addListener(...)
  browser.windows.onRemoved.addListener(...)
  browser.windows.onFocusChanged.addListener(...)
  // Tab groups if supported
  if (browser.tabGroups) { ... }

  return { whenReady, windows, tabsByWindow, close, activate, ... };
}
```

### 2. `workspace.ts`: Remove browser-state tables

**Remove from table definitions:**
- `tabsTable` (the Y.Doc table for live tabs)
- `windowsTable` (the Y.Doc table for live windows)
- `tabGroupsTable` (the Y.Doc table for live tab groups)

**Remove from exports:**
- `Tab` type (the Y.Doc row type: replaced by `BrowserTab` in browser-state)
- `Window` type (the Y.Doc row type: replaced by `BrowserWindow` in browser-state)
- `TabCompositeId`, `WindowCompositeId`, `GroupCompositeId` branded types
- `createTabCompositeId`, `createWindowCompositeId`, `createGroupCompositeId` helpers
- `parseTabId`, `parseWindowId`, `parseGroupId` helpers

**Keep:**
- `devicesTable`: still useful for device identity in saved tabs ("Saved from Chrome on MacBook")
- `savedTabsTable`, `bookmarksTable`, `conversationsTable`, `chatMessagesTable`, `toolTrustTable`
- `DeviceId` type
- All workspace extensions (persistence, broadcast, sync)

### 3. `row-converters.ts`: Remove or gut

**Remove:**
- `tabToRow` (converts Chrome tab → Y.Doc row)
- `windowToRow` (converts Chrome window → Y.Doc row)
- `tabGroupToRow` (converts Chrome tab group → Y.Doc row)

If the file has no remaining exports, delete it. If it has converters used by saved-tab-state or bookmark-state, keep only those.

### 4. Consumer changes: Minimal

**unified-view-state.svelte.ts:**
- Currently reads `browserState.windows` (returns `Window[]` with Y.Doc row type) and `browserState.tabsByWindow(windowId)` (returns `Tab[]`).
- After: reads `browserState.windows` (returns `BrowserWindow[]`) and `browserState.tabsByWindow(windowId)` (returns `BrowserTab[]`).
- The field names may differ slightly (e.g., `tab.id` → `tab.tabId`). Verify and update field references.

**UnifiedTabList.svelte, TabItem.svelte, command-palette/items.ts:**
- These consume the browserState API. If the returned types change field names, update references. The API shape (`.windows`, `.tabsByWindow()`, `.close()`, etc.) stays the same.

### 5. Device registration: Simplify

Currently browser-state.svelte.ts registers the device in `tables.devices` during seed. Since we're removing Y.Doc from browser-state, device registration should move to a shared location that runs on app init (e.g., a side effect in `workspace.ts` or a dedicated `device-state.svelte.ts`). Saved tabs and bookmarks reference `sourceDeviceId`, so device registration is still needed, just not in browser-state.

## Migration Checklist

- [x] Rewrite `browser-state.svelte.ts`: Chrome-only, SvelteMap-only, ~200 lines
- [x] Define `BrowserWindow` and `BrowserTab` types locally in browser-state (plain objects from Chrome data)
- [x] Remove Y.Doc table definitions (`tabsTable`, `windowsTable`, `tabGroupsTable`) from `workspace.ts`
- [x] Remove composite ID helpers and branded types from `workspace.ts`
- [x] Remove or delete `row-converters.ts`
- [x] Move device registration out of browser-state into a shared init path
- [x] Update `unified-view-state.svelte.ts` for any field name changes
- [x] Update `UnifiedTabList.svelte` for any field name changes
- [x] Update `TabItem.svelte` for any field name changes
- [x] Update `command-palette/items.ts` for any field name changes
- [x] Verify the `{#await browserState.whenReady}` gate still works (it should: whenReady is still a promise)
- [ ] Run the extension in Chrome and verify: tabs render, events update UI, actions work
- [ ] Verify saved tabs and bookmarks still sync cross-device (unaffected by this change)

## Risks and Considerations

1. **Cross-device live tab viewing is removed.** Device A can no longer see Device B's open tabs. This was the feature that justified Y.Doc for live tabs. If this feature is needed in the future, it could be re-added as a separate read-only sync (push a snapshot to Y.Doc on interval, no observers that call Chrome APIs).

2. **IndexedDB may still contain old browser-state data.** The Y.Doc persisted via IndexedDB will have stale `tabs`, `windows`, `tabGroups` entries. These are harmless (no code reads them) but will consume storage. A one-time cleanup migration could delete them, or they'll naturally be ignored.

3. **The `Tab` and `Window` types from workspace.ts are used in consumer components.** Changing from Y.Doc row types to plain Chrome-derived types requires updating type references. The field shapes are similar but not identical (e.g., Y.Doc rows have `id: TabCompositeId` and `_v: 1`; Chrome objects have `tabId: number`).

## Review

**Status**: Implemented
**Commits**: `c526f4e` (main rewrite), `16c7fce` (cleanup)

### Summary

Removed all Y.Doc/CRDT usage for live browser tabs and windows. Chrome is now the sole authority for ephemeral browser data. The side panel seeds from `browser.windows.getAll({ populate: true })`, receives surgical updates via browser event listeners, and writes only to SvelteMap. No dual-writes, no observers, no echo detection.

### Line counts

| File | Before | After | Delta |
|---|---|---|---|
| `browser-state.svelte.ts` | 690 | 406 | −284 |
| `workspace.ts` | 1058 | 587 | −471 |
| `row-converters.ts` | 117 | deleted | −117 |
| Consumers (7 files) |: |: | ~+30 net |
| **Total** |: |: | **−842 net** |

### Deviations from spec

1. **`saved-tab-state.svelte.ts` and `bookmark-state.svelte.ts` required type-only changes.** Both imported `type Tab` from workspace, which was removed. Changed to `type BrowserTab` from browser-state. No logic changes. Just the import and method parameter type.
2. **Workspace actions were not addressed in the spec.** 7 query actions that read from removed Y.Doc tables were removed (`tabs.search`, `tabs.list`, `tabs.findDuplicates`, `tabs.dedup`, `tabs.groupByDomain`, `windows.list`, `domains.count`). 8 mutation actions were simplified to accept native Chrome tab IDs instead of composite string IDs.
3. **`tab-helpers.ts` `TabLike` type updated.** Changed `id: string` to `tabId: number` since the only remaining consumer passes `BrowserTab[]`.
4. **Existing bug fixed in `command-palette/items.ts`.** `savedTabState.actions.save(tab)` → `savedTabState.save(tab)` (`.actions` property doesn't exist).

### Follow-up work

- **AI tab queries are gone.** The AI chat can no longer search/list/count tabs via Y.Doc. To restore this, query actions would need to read from `browserState` (reactive SvelteMap) instead of Y.Doc tables. This requires either importing browserState into workspace.ts or defining actions outside the workspace.
- **Stale IndexedDB data.** Old Y.Doc still has `tabs`, `windows`, `tabGroups` entries in IndexedDB. Harmless but wastes storage. A cleanup migration could remove them.
