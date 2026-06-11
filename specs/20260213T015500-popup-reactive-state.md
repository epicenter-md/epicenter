# Popup Reactive State: Replace TanStack Query with Svelte 5 `$state`

**Date**: 2026-02-13
**Status**: Implemented
**Author**: AI-assisted
**Implementation notes**: All 5 phases completed. `browser-state.svelte.ts` created with `$state` reactive class, surgical browser event handlers, and direct action methods. Components (`TabList.svelte`, `TabItem.svelte`, `SavedTabList.svelte`) rewritten to use `browserState`. TanStack Query fully removed: `query/` directory deleted, `EpicenterProvider.svelte` deleted, no `@tanstack/svelte-query` imports remain.

## Overview

Replace TanStack Query in the tab manager popup with a Svelte 5 `$state` reactive class that seeds from `browser.windows.getAll({ populate: true })` and receives surgical updates via browser event listeners. The popup becomes self-contained for live browser state; TanStack Query is removed entirely.

## Motivation

### Current State

The popup reads live tab/window data through TanStack Query, which calls browser APIs directly:

```typescript
// query/tabs.ts: queries call Chrome APIs
getAll: defineQuery({
  queryKey: tabsKeys.all,
  queryFn: async () => {
    const browserTabs = await browser.tabs.query({});
    return Ok(rows);
  },
  staleTime: Infinity,
}),
```

A separate `EpicenterProvider.svelte` subscribes to every browser event and invalidates the TanStack Query cache:

```typescript
// EpicenterProvider.svelte: event-driven invalidation
browser.tabs.onCreated.addListener(invalidateTabs); // invalidates entire ['tabs'] query
browser.tabs.onUpdated.addListener(invalidateTabs); // invalidates entire ['tabs'] query
browser.tabs.onRemoved.addListener(invalidateTabs); // invalidates entire ['tabs'] query
// ...13 more listeners, all doing full cache invalidation
```

Components consume data via `createQuery`:

```svelte
const tabsQuery = createQuery(() => rpc.tabs.getAll.options); const windowsQuery
= createQuery(() => rpc.tabs.getAllWindows.options);
```

This creates problems:

1. **Full re-query on every event**: Any tab event invalidates the entire `['tabs']` query, triggering `browser.tabs.query({})` again: re-fetching all 100+ tabs when only one changed.
2. **Two separate API calls**: `browser.tabs.query({})` and `browser.windows.getAll()` run independently. `browser.windows.getAll({ populate: true })` returns both in a single IPC call.
3. **Unnecessary abstraction layer**: TanStack Query adds caching, deduplication, and stale management for data that is inherently local and cheap to access. Browser APIs are synchronous IPC, not network requests. The caching layer adds complexity without meaningful benefit.
4. **Mutation boilerplate**: Every action (close, pin, mute, reload, duplicate) is wrapped in `defineMutation` + `createMutation` + `createTaggedError` when it could be a direct `browser.tabs.update()` call.

### Desired State

A single reactive class seeds state on popup open, then receives surgical updates from browser events:

```svelte
<script>
	import { browserState } from '$lib/browser-state.svelte';
</script>

{#each browserState.windows as window (window.id)}
	{#each browserState.tabsByWindow(window.id) as tab (tab.id)}
		<TabItem {tab} />
	{/each}
{/each}
```

No QueryClient, no cache invalidation, no mutation wrappers. Browser events directly mutate `$state`. Svelte's deep proxy handles granular reactivity.

## Research Findings

### Popup Browser API Access

Popups are extension pages with full access to all `browser.*` APIs. No message passing to background needed.

| Capability                                   | Supported? | Notes                                       |
| -------------------------------------------- | :--------: | ------------------------------------------- |
| `browser.tabs.query({})`                     |     ✅     | Direct call, no permissions beyond manifest |
| `browser.windows.getAll({ populate: true })` |     ✅     | Returns windows with nested `tabs` arrays   |
| `browser.tabs.onCreated.addListener()`       |     ✅     | Listeners live for popup lifetime           |
| `browser.tabs.onUpdated.addListener()`       |     ✅     | Full `Tab` object in 3rd argument           |
| Listeners survive popup close                |     ❌     | Destroyed when popup closes: this is fine  |

**Key finding**: The current codebase already calls browser APIs directly from the popup (via TanStack Query `queryFn`). Zero `runtime.sendMessage` usage exists. TanStack Query is purely a caching/invalidation layer.

**Implication**: Removing TanStack Query doesn't change the data flow. It removes an intermediary.

### `browser.windows.getAll({ populate: true })`

When `populate: true`, each `Window` object includes a `tabs: Tab[]` array with the same `Tab` objects returned by `browser.tabs.query({})`.

| Property                                 | Included without `populate`? | Included with `populate: true`? |
| ---------------------------------------- | :--------------------------: | :-----------------------------: |
| `window.id`, `focused`, `state`, etc.    |              ✅              |               ✅                |
| `window.tabs`                            |        ❌ (undefined)        |        ✅ (full `Tab[]`)        |
| `tab.url`, `tab.title`, `tab.favIconUrl` | - |  ✅ (with `"tabs"` permission)  |

**Key finding**: One IPC call gets everything. The existing `windowToRow` converter already destructures `tabs` off the window object (line 73: `const { id, tabs: _tabs, ...rest } = window`).

### Svelte 5 `$state` vs `createSubscriber`

| Mechanism          | What it does                                                           | When to use                                  |
| ------------------ | ---------------------------------------------------------------------- | -------------------------------------------- |
| `$state`           | Deep proxy. Intercepts `.push()`, index assignment, property mutation. | Events mutate stored state                   |
| `createSubscriber` | Invisible version counter. Triggers re-read of getter.                 | Value computed on-read, no `$state` involved |

**Key finding**: Browser event listeners directly mutate `$state`. The proxy handles reactivity. `createSubscriber` is unnecessary because there's no expensive subscription to lazily manage: browser event listeners are cheap and always wanted while the popup is open. Popup destruction handles cleanup automatically.

See `docs/articles/state-vs-createsubscriber-who-owns-reactivity.md` for the full analysis.

### Surgical Updates with `$state`

`$state` arrays are deep proxies. Svelte tracks which property on which element was read:

```typescript
// Only components reading tabs[42].title re-render
tabs[42] = { ...tabs[42], title: 'New Title' };
```

For O(1) lookups during surgical updates, maintain a parallel `Map<string, number>` (tabId → array index). This avoids `findIndex` on every event.

## Design Decisions

| Decision                  | Choice                                         | Rationale                                                                                                                                             |
| ------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reactivity mechanism      | `$state` (deep proxy)                          | Events mutate stored state; `$state` proxy handles granular reactivity. See research above.                                                           |
| Initial seed call         | `browser.windows.getAll({ populate: true })`   | Single IPC call returns windows + tabs. Currently 2 calls.                                                                                            |
| Lookup structure          | Plain `Map<string, number>` for index lookups  | O(1) find during surgical updates. Not reactive: internal bookkeeping only.                                                                          |
| Tab storage               | `$state<Tab[]>` flat array                     | Matches current data shape. UI groups by window via `$derived`.                                                                                       |
| Window storage            | `$state<Window[]>` flat array                  | Small count (typically 1-5). No index map needed.                                                                                                     |
| Mutation approach         | Direct `browser.tabs.*` calls, no wrappers     | Browser APIs are sync IPC. Error handling via `tryAsync` where needed. No mutation state tracking needed: browser events update `$state` reactively. |
| Suspended tabs            | Keep Y.Doc access, drop TanStack Query wrapper | Suspended tabs must sync across devices via Yjs. But the TanStack Query wrapper can be replaced with a `$state` class that observes the Y.Doc table.  |
| Module format             | `.svelte.ts` file with class export            | Standard Svelte 5 pattern for reactive modules.                                                                                                       |
| Background service worker | No changes                                     | Background handles Y.Doc ↔ Browser sync for multi-device. Completely separate concern from popup reactivity.                                          |

## Architecture

### Current Flow (Remove)

```
┌──────────────┐     invalidate      ┌───────────────────┐     query      ┌──────────────┐
│ Browser Event │ ──────────────────▶ │ TanStack Query    │ ─────────────▶ │ Browser API  │
│ (13 listeners)│                     │ Cache             │                │ tabs.query() │
└──────────────┘                     │ (re-fetches ALL)  │ ◀───────────── │ windows.get()│
                                     └───────────────────┘   full arrays  └──────────────┘
                                              │
                                              ▼
                                     ┌───────────────────┐
                                     │ Svelte Components  │
                                     │ (re-render all)    │
                                     └───────────────────┘
```

### New Flow (Add)

```
POPUP OPEN
──────────
  browser.windows.getAll({ populate: true })
       │
       ▼
  ┌───────────────────────────────────────────┐
  │ BrowserState  (.svelte.ts)                │
  │                                           │
  │  #windows = $state<Window[]>([])          │
  │  #tabs = $state<Tab[]>([])                │
  │  #tabIndex = Map<string, number>          │
  │                                           │
  │  get windows() → #windows                 │
  │  get tabs() → #tabs                       │
  │  tabsByWindow(id) → $derived filter       │
  │                                           │
  │  actions.close(tabId)                     │
  │  actions.pin(tabId)                       │
  │  actions.activate(tabId)                  │
  │  ...                                      │
  └───────────────────────────────────────────┘
       ▲                    │
       │ surgical           │ direct calls
       │ $state mutation    │
       │                    ▼
  ┌──────────────┐   ┌──────────────┐
  │ Browser Event │   │ Browser API  │
  │ Listeners     │   │ tabs.update  │
  │ (on popup)    │   │ tabs.remove  │
  └──────────────┘   └──────────────┘

POPUP CLOSE
───────────
  All listeners die. State garbage collected.
  Next open → fresh seed + fresh listeners.
```

### Saved Tabs (Separate Concern)

```
  ┌───────────────────────────────────────────┐
  │ SavedTabState  (.svelte.ts)               │
  │                                           │
  │  #tabs = $state<SavedTab[]>([])           │
  │                                           │
  │  constructor:                              │
  │    seed from popupWorkspace.tables         │
  │    observe Y.Doc table for changes         │
  │                                           │
  │  actions.save(tab)                        │
  │  actions.restore(savedTab)                │
  │  actions.remove(id)                       │
  └───────────────────────────────────────────┘
       ▲
       │ Y.Doc observe callback
       │
  ┌───────────────────────────────────────────┐
  │ popupWorkspace (Y.Doc + WebSocket sync)   │
  │ (unchanged: still needed for multi-device)│
  └───────────────────────────────────────────┘
```

## Implementation Plan

### Phase 1: Create `BrowserState` reactive class

- [ ] **1.1** Create `src/lib/browser-state.svelte.ts` with:
  - `$state<Tab[]>` for tabs, `$state<Window[]>` for windows
  - `Map<string, number>` index map for O(1) tab lookup
  - `#seed()` method: calls `browser.windows.getAll({ populate: true })`, populates both arrays, uses `createBrowserConverters` to transform to row types
  - Browser event listeners registered in constructor (surgical `$state` mutations)
  - Getters: `tabs`, `windows`, `tabsByWindow(windowId)`
  - Action methods: `close(tabId)`, `activate(tabId)`, `pin(tabId)`, `unpin(tabId)`, `mute(tabId)`, `unmute(tabId)`, `reload(tabId)`, `duplicate(tabId)`: direct `browser.tabs.*` calls, no wrappers

- [ ] **1.2** Handle all browser events surgically:
  - `tabs.onCreated` → push to array, update index map
  - `tabs.onRemoved` → splice from array, update index map
  - `tabs.onUpdated` → replace element at index (3rd arg provides full `Tab`)
  - `tabs.onMoved` → update `index` field, re-sort affected window's tabs
  - `tabs.onActivated` → set `active: false` on previous, `active: true` on new
  - `tabs.onAttached` / `onDetached` → update `windowId`, re-query the tab via `browser.tabs.get()`
  - `windows.onCreated` → push to windows array
  - `windows.onRemoved` → splice from windows array, remove associated tabs
  - `windows.onFocusChanged` → update `focused` on windows
  - `tabGroups.onCreated/Updated/Removed` → if tab groups are tracked

### Phase 2: Create `SavedTabState` reactive class

- [ ] **2.1** Create `src/lib/saved-tab-state.svelte.ts` with:
  - `$state<SavedTab[]>` seeded from `popupWorkspace.tables.savedTabs.getAllValid()`
  - Y.Doc table observer for reactive updates (when background or remote device changes saved tabs)
  - Action methods: `save(tab)`, `restore(savedTab)`, `restoreAll()`, `remove(id)`, `removeAll()`, `update(savedTab)`: call the existing `save-tab.ts` helpers

### Phase 3: Update components

- [ ] **3.1** Rewrite `TabList.svelte`:
  - Replace `createQuery` with `browserState.windows` / `browserState.tabsByWindow()`
  - Remove query loading/error states (seed is <10ms, no network)
  - Keep accordion UI structure

- [ ] **3.2** Rewrite `TabItem.svelte`:
  - Replace `createMutation` calls with direct `browserState.actions.close(tabId)` etc.
  - Remove mutation pending states (browser APIs are ~instant, no spinner needed)
  - Keep suspend action (calls `suspendedTabState.actions.suspend(tab)`)

- [ ] **3.3** Rewrite `SavedTabList.svelte`:
  - Replace `createQuery` / `createMutation` with `savedTabState` reactive class
  - Keep existing UI structure

- [ ] **3.4** Simplify `App.svelte`:
  - Remove `QueryClientProvider` wrapper
  - Remove `EpicenterProvider` wrapper (no more chrome event → query invalidation)
  - Keep `Tooltip.Provider` and layout

### Phase 4: Remove dead code

- [ ] **4.1** Delete `src/lib/query/_client.ts` (QueryClient setup)
- [ ] **4.2** Delete `src/lib/query/tabs.ts` (TanStack Query tab definitions)
- [ ] **4.3** Delete `src/lib/query/saved-tabs.ts` (TanStack Query saved tab definitions)
- [ ] **4.4** Delete `src/lib/query/index.ts` (rpc namespace)
- [ ] **4.5** Delete `src/lib/epicenter/EpicenterProvider.svelte` (chrome event → query invalidation)
- [ ] **4.6** Remove `@tanstack/svelte-query` and `@tanstack/svelte-query-devtools` from popup dependencies (if not used elsewhere)
- [ ] **4.7** Update `src/lib/epicenter/index.ts`: remove `EpicenterProvider` re-export

### Phase 5: Verify

- [ ] **5.1** Type check passes (`bun run --filter tab-manager typecheck`)
- [ ] **5.2** Extension builds successfully
- [ ] **5.3** Manual test: popup shows tabs grouped by window, updates live when tabs are created/closed/moved/updated
- [ ] **5.4** Manual test: saved tabs list works (save, restore, delete)

## Edge Cases

### Async Seed Gap

1. Popup opens, `$state` arrays start empty
2. `#seed()` is async: takes <10ms but still a microtask
3. Components see `[]` for one frame

**Resolution**: Either show a brief loading state or accept the flash. Seed is fast enough that it's barely noticeable. Can add `#seeded = $state(false)` flag if needed.

### Tab Events During Seed

1. Popup opens, `#seed()` starts
2. Browser event fires before seed completes
3. Event handler mutates empty/partial array

**Resolution**: Queue events during seed or ignore them: the seed result will be authoritative. Simplest approach: set a `#ready` flag, skip event handlers until seed completes, then process events normally. Seed is authoritative because it reflects the current complete state.

### `onUpdated` Partial ChangeInfo

1. `browser.tabs.onUpdated` provides `changeInfo` (partial) and `tab` (full)
2. The 3rd argument (`tab`) is the complete `Tab` object

**Resolution**: Always use the 3rd argument, not `changeInfo`. Replace the entire tab entry.

### Window Removed With Tabs

1. `windows.onRemoved` fires
2. `tabs.onRemoved` fires for each tab in that window

**Resolution**: `windows.onRemoved` handler should clean up the window from `#windows`. The tab removal events will handle tab cleanup individually. No need to batch.

### Popup Reopened Quickly

1. User closes and reopens popup rapidly
2. Previous instance's listeners still cleaning up

**Resolution**: Non-issue. Each popup open creates a fresh JS context. No shared state between popup instances.

## Open Questions

1. **Should actions show pending/loading state?**
   - Currently `TabItem.svelte` shows `<Spinner />` during mutation pending states
   - Browser API calls are ~instant IPC, not network requests
   - **Recommendation**: Remove spinners. The browser event will update `$state` within milliseconds. If needed, add optimistic updates (e.g., immediately mark tab as closed in `$state` before the API call).

2. **Should the index map use composite IDs or native tab IDs?**
   - Current code uses composite IDs (`${deviceId}_${tabId}`) as the primary key
   - Browser events provide native `tabId` (number)
   - **Recommendation**: Maintain both lookups. Index map keyed by composite ID for `$state` array index. A separate `nativeIdToCompositeId` map for translating browser event `tabId` to composite ID.

3. **Should tab groups be tracked in `BrowserState`?**
   - Current code has `tabGroups` table and queries
   - Firefox doesn't support tab groups
   - **Recommendation**: Include tab groups in `BrowserState` with Chrome-only guards (matching existing pattern in `background.ts`).

4. **How should `SuspendedTabState` observe Y.Doc changes?**
   - Options: (a) Poll `getAllValid()` on a timer, (b) Use the table's `.observe()` callback to surgically update `$state`, (c) Use `createSubscriber` for lazy lifecycle
   - **Recommendation**: Option (b): the table `.observe()` callback directly mutates `$state`. This matches how the background service worker already uses observers.

## Success Criteria

- [ ] Popup displays tabs grouped by window correctly
- [ ] Creating a new tab appears in popup without full re-query
- [ ] Closing a tab disappears from popup without full re-query
- [ ] Tab updates (title, favicon, status) reflect in popup surgically
- [ ] Tab actions (close, pin, mute, reload, duplicate, save) work
- [ ] Saved tabs list works (save, restore, delete)
- [ ] No TanStack Query imports remain in popup code
- [ ] Type check passes
- [ ] Extension builds and loads in browser

## References

- `apps/tab-manager/src/lib/browser-helpers.ts`: Row converters (keep, reuse in seed)
- `apps/tab-manager/src/lib/epicenter/browser.schema.ts`: Tab/Window types (keep, unchanged)
- `apps/tab-manager/src/lib/epicenter/workspace.ts`: Popup Y.Doc client (keep, for suspended tabs)
- `apps/tab-manager/src/lib/epicenter/save-tab.ts`: Save/restore helpers (keep, reuse in SavedTabState)
- `apps/tab-manager/src/entrypoints/background.ts`: Background sync (unchanged)
- `apps/tab-manager/src/lib/query/`: Entire directory removed
- `apps/tab-manager/src/lib/epicenter/EpicenterProvider.svelte`: Removed
- `docs/articles/state-vs-createsubscriber-who-owns-reactivity.md`: Design rationale for `$state` over `createSubscriber`
